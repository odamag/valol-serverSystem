import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { verifyEd25519 } from '../lib/verify-ed25519';
import { jsonResponse } from '../lib/respond';
import { todayJst } from '../lib/jst';
import { listRecords } from '../lib/records';
import {
  formatRecordChoiceName,
  getInteractionUserId,
  getSubcommand,
  shouldBeEphemeral,
  type DiscordInteraction,
} from '../lib/commands';

// Discord Interaction の「リクエスト種別 (type)」と「レスポンスの種別 (type)」は別体系なので注意。
//
// リクエスト側 InteractionType:
//   1 = PING
//   2 = APPLICATION_COMMAND
//   3 = MESSAGE_COMPONENT
//   4 = APPLICATION_COMMAND_AUTOCOMPLETE
//   5 = MODAL_SUBMIT
//
// レスポンス側 InteractionResponseType:
//   1 = PONG
//   4 = CHANNEL_MESSAGE_WITH_SOURCE
//   5 = DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
//   6 = DEFERRED_UPDATE_MESSAGE
//   8 = APPLICATION_COMMAND_AUTOCOMPLETE_RESULT
//   9 = MODAL
//
// 同じ「4」でも、リクエスト側だと AUTOCOMPLETE、レスポンス側だと MESSAGE を意味するなど数字が衝突するので、
// コード中に生の数字を書くときは必ずどちら側の type かをコメントで明示すること。

const DISCORD_PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY ?? '';
const WORKER_FN = process.env.WORKER_FN ?? '';

// Lambda クライアントはモジュールスコープで1つだけ生成する（ddb.ts と同じ理由）。
const lambdaClient = new LambdaClient({});

const DAY_MS = 24 * 60 * 60 * 1000;
const RELATIVE_DATE_LABELS = ['今日', '昨日', '一昨日', '3日前', '4日前', '5日前', '6日前'];

// `date` オプションのオートコンプリート候補。
// ユーザーにタイムゾーンを意識させないため、日付計算は（クライアントではなく）ここサーバー側で行う。
function buildDateChoices(): { name: string; value: string }[] {
  const now = Date.now();
  return RELATIVE_DATE_LABELS.map((label, i) => {
    const runDate = todayJst(now - i * DAY_MS);
    return { name: `${label} (${runDate})`, value: runDate };
  });
}

/**
 * type=4 (APPLICATION_COMMAND_AUTOCOMPLETE) の処理。
 * defer できない（3秒以内に確定した応答を返す必要がある）ため、このハンドラ自身が
 * 同期的に DynamoDB を読んで即答する。
 *
 * エラーが起きても例外は投げず、空の choices を返す（例外を投げると入力欄が壊れるため）。
 */
async function handleAutocomplete(
  interaction: DiscordInteraction,
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const sub = getSubcommand(interaction.data);
    const focused = sub?.options.find((o) => o.focused);

    if (focused?.name === 'date') {
      return jsonResponse(200, { type: 8, data: { choices: buildDateChoices() } });
    }

    if (focused?.name === 'record') {
      const discordId = getInteractionUserId(interaction);
      if (!discordId) {
        return jsonResponse(200, { type: 8, data: { choices: [] } });
      }
      // Discord の choices は最大25件までなので、limit をそのまま25にして取得すれば超過しない。
      const { records } = await listRecords(discordId, 25, null);
      const choices = records.map((r) => ({ name: formatRecordChoiceName(r), value: r.id }));
      return jsonResponse(200, { type: 8, data: { choices } });
    }

    return jsonResponse(200, { type: 8, data: { choices: [] } });
  } catch (err) {
    console.error('[interactions] autocomplete failed', err);
    return jsonResponse(200, { type: 8, data: { choices: [] } });
  }
}

/**
 * type=2 (APPLICATION_COMMAND) の処理。
 * Discord の3秒応答制限に対処するため、重い処理（DynamoDB書き込み等）は WorkerFn に丸投げし、
 * このハンドラは deferred 応答だけを即座に返す。
 */
async function dispatchToWorker(
  interaction: DiscordInteraction,
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: WORKER_FN,
        // 同期呼び出し（既定）のままだと Discord の3秒タイムアウトに縛られてしまうため、
        // 非同期実行（Event）を必ず指定する。
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify(interaction)),
      }),
    );
  } catch (err) {
    // 起動に失敗しても、Discord へは deferred 応答を返す予定なので、ここではログに残すだけにする。
    // （Worker が起動できなければ、ユーザーには「応答なし」に見えてしまうが、3秒以内に確実な
    // エラー応答へ切り替える手段が無いため、これは許容する）。
    console.error('[interactions] failed to invoke WorkerFn', err);
  }

  // レスポンス type=5 (DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE)。
  // ephemeral かどうかは、この defer 応答を返した時点で確定し、後から worker.ts の
  // followup で変更することはできない（Discord の仕様）。そのため、まだバリデーションも
  // していないこの時点で、コマンド名とオプションだけを見て shouldBeEphemeral が判断する
  // （判断ロジック・ここでバリデーションエラーも公開されうる点の許容理由は commands.ts 参照）。
  return jsonResponse(200, {
    type: 5,
    data: shouldBeEphemeral(interaction) ? { flags: 64 } : {},
  });
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  // 生ボディを復元する。
  // 署名は「タイムスタンプ + 生ボディのバイト列」に対して計算されているため、
  // 一度 JSON.parse してから JSON.stringify で作り直したボディでは、
  // キー順序や空白の違いだけで署名検証が絶対に通らなくなる。必ず受信したバイト列そのものを使うこと。
  const rawBody = Buffer.from(event.body ?? '', event.isBase64Encoded ? 'base64' : 'utf8');

  // API Gateway HTTP API (payload format 2.0) はヘッダ名をすべて小文字に正規化して渡してくる。
  const signature = event.headers['x-signature-ed25519'];
  const timestamp = event.headers['x-signature-timestamp'];

  if (!signature || !timestamp || !verifyEd25519(DISCORD_PUBLIC_KEY, timestamp, rawBody, signature)) {
    // Discord は Interactions Endpoint URL を Developer Portal に保存する際、
    // わざと不正な署名を持つリクエストを送ってきて 401 が返ることを確認する。
    // ここで 401 以外（500 など）を返すと Endpoint URL の登録自体が失敗する。
    return { statusCode: 401, body: 'invalid request signature' };
  }

  const body = JSON.parse(rawBody.toString('utf8')) as DiscordInteraction;

  if (body.type === 1) {
    // リクエスト type=1 (PING) には レスポンス type=1 (PONG) を返す。
    return jsonResponse(200, { type: 1 });
  }

  if (body.type === 4) {
    // リクエスト type=4 (APPLICATION_COMMAND_AUTOCOMPLETE)
    return handleAutocomplete(body);
  }

  if (body.type === 2) {
    // リクエスト type=2 (APPLICATION_COMMAND)
    return dispatchToWorker(body);
  }

  // MESSAGE_COMPONENT (3) や MODAL_SUBMIT (5) は Phase 1 の対象コマンドでは発生しないが、
  // 想定外のリクエストが来ても 500 にはせず、本人にのみ見える形で素直に案内を返す。
  return jsonResponse(200, {
    type: 4,
    data: { content: '未対応のリクエストです', flags: 64 },
  });
};
