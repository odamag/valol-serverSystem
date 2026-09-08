// InteractionsFn から `InvocationType: 'Event'` で非同期に invoke されるワーカー。
// Discord の3秒応答制限に縛られず、DynamoDB 書き込みなどの重い処理をここで行い、
// 完了したら followup（PATCH .../messages/@original）で本編の応答を返す。
//
// 受け取る event は、interactions.ts が署名検証を通した Discord Interaction オブジェクトそのもの
// （API Gateway のラップは無い。Lambda-to-Lambda invoke なので Payload がそのまま event になる）。
//
// 重要: このハンドラは絶対に例外を外へ投げてはいけない。
// 非同期 Lambda 呼び出しは失敗すると自動的にリトライされる仕組みになっており、
// 例えば createRecord が成功した「あと」に followup 送信が失敗して例外を投げてしまうと、
// Lambda が「処理全体が失敗した」と判断して worker を再実行し、記録が二重に作成されてしまう。
// そのため handler の最上位は必ず try/catch で全体を包み、失敗時もログに残すだけに留める。

import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/ddb';
import { parseRecordId, recordSk, userPk } from '../lib/keys';
import { createRecord, deleteRecord, listRecords } from '../lib/records';
import { validateCreateRecord } from '../lib/validate';
import { followup } from '../lib/discord-rest';
import {
  type DiscordInteraction,
  type DiscordInteractionOption,
  LIST_RECENT_LIMIT,
  SUB_ADD,
  SUB_DELETE,
  SUB_LIST,
  SUB_WEB,
  OPT_COURSE,
  OPT_DATE,
  OPT_DISTANCE,
  OPT_HR,
  OPT_KCAL,
  OPT_MEMO,
  OPT_RECORD,
  OPT_TIME,
  OPT_WEATHER,
  findOption,
  formatClock,
  formatPace,
  getInteractionUserId,
  getInteractionUserName,
  getSubcommand,
  parseClockToSeconds,
  weatherLabel,
} from '../lib/commands';

const SITE_ORIGIN = process.env.SITE_ORIGIN ?? '';

// Discord Embed のアクセントカラー（水色寄りの青）。特に意味はなく見た目の統一のためだけの定数。
const EMBED_COLOR = 0x2b6cb0;

function optionValue(options: DiscordInteractionOption[], name: string): string | number | boolean | undefined {
  return findOption(options, name)?.value;
}

async function replyText(interaction: DiscordInteraction, content: string): Promise<void> {
  await followup(interaction.application_id, interaction.token, { content });
}

/** `/run add`: 距離・時間などを検証して記録を作成し、結果を Embed で返す。 */
async function handleAdd(
  interaction: DiscordInteraction,
  discordId: string,
  userName: string,
  options: DiscordInteractionOption[],
): Promise<void> {
  const distance = optionValue(options, OPT_DISTANCE);
  const time = optionValue(options, OPT_TIME);

  if (typeof time !== 'string') {
    await replyText(interaction, '時間を指定してください（例: 26:30 / 1:05:12）');
    return;
  }

  const durationS = parseClockToSeconds(time);
  if (durationS === null) {
    await replyText(
      interaction,
      '時間の形式が正しくありません。mm:ss または h:mm:ss の形式で入力してください（例: 26:30 / 1:05:12）',
    );
    return;
  }

  // Web（handlers/api.ts）と同じバリデーション関数に、Web API と同じ形のボディを渡す。
  // こうすることで丸め・上限・エラーメッセージの規約を二重実装せずに揃えられる
  // （document/running_api.md §6）。
  const body: Record<string, unknown> = { distanceKm: distance, durationS };

  const date = optionValue(options, OPT_DATE);
  if (typeof date === 'string') body.runDate = date;

  const course = optionValue(options, OPT_COURSE);
  if (typeof course === 'string') body.course = course;

  const weather = optionValue(options, OPT_WEATHER);
  if (typeof weather === 'string') body.weather = weather;

  const hr = optionValue(options, OPT_HR);
  if (typeof hr === 'number') body.heartRate = hr;

  const kcal = optionValue(options, OPT_KCAL);
  if (typeof kcal === 'number') body.calories = kcal;

  const memo = optionValue(options, OPT_MEMO);
  if (typeof memo === 'string') body.memo = memo;

  const result = validateCreateRecord(body);
  if (!result.ok) {
    await replyText(interaction, result.message);
    return;
  }

  const record = await createRecord(discordId, userName, 'discord', result.value);

  const fields: { name: string; value: string; inline?: boolean }[] = [
    { name: '距離', value: `${record.distanceKm}km`, inline: true },
    { name: '時間', value: formatClock(record.durationS), inline: true },
    { name: 'ペース', value: formatPace(record.paceSPerKm), inline: true },
    { name: '日付', value: record.runDate, inline: true },
  ];
  if (record.course) fields.push({ name: 'コース', value: record.course, inline: true });
  const wLabel = weatherLabel(record.weather);
  if (wLabel) fields.push({ name: '天気', value: wLabel, inline: true });
  if (record.heartRate !== null) fields.push({ name: '心拍数', value: `${record.heartRate}bpm`, inline: true });
  if (record.calories !== null) fields.push({ name: '消費カロリー', value: `${record.calories}kcal`, inline: true });
  if (record.memo) fields.push({ name: 'メモ', value: record.memo });

  await followup(interaction.application_id, interaction.token, {
    embeds: [{ title: '記録を追加しました', color: EMBED_COLOR, fields }],
  });
}

/** `/run list`: 直近 LIST_RECENT_LIMIT 件を新しい順に返す（page を実装しない理由は commands.ts 参照）。 */
async function handleList(interaction: DiscordInteraction, discordId: string): Promise<void> {
  const { records } = await listRecords(discordId, LIST_RECENT_LIMIT, null);

  if (records.length === 0) {
    await replyText(interaction, 'まだ記録がありません。`/run add` で記録を追加しましょう！');
    return;
  }

  const lines = records.map((r) => {
    const mmdd = r.runDate.slice(5).replace('-', '/');
    const course = r.course ? ` ${r.course}` : '';
    return `${mmdd} ${r.distanceKm}km ${formatClock(r.durationS)}（${formatPace(r.paceSPerKm)}）${course}`;
  });

  await followup(interaction.application_id, interaction.token, {
    embeds: [
      {
        title: `直近の記録（最大${LIST_RECENT_LIMIT}件）`,
        color: EMBED_COLOR,
        description: lines.join('\n'),
      },
    ],
  });
}

/**
 * `/run delete`: deleteRecord は楽観ロック（updatedAt）を要求するため、削除前に対象を読んで
 * updatedAt を取得してから渡す。records.ts に単体の getRecord は無いため、
 * records.ts が内部でやっているのと同じ形（keys.ts でキーを組み立てて GetCommand）をここで行う。
 */
async function handleDelete(
  interaction: DiscordInteraction,
  discordId: string,
  options: DiscordInteractionOption[],
): Promise<void> {
  const recordIdValue = optionValue(options, OPT_RECORD);
  if (typeof recordIdValue !== 'string') {
    await replyText(interaction, '削除する記録を指定してください');
    return;
  }

  const parsed = parseRecordId(recordIdValue);
  if (!parsed) {
    await replyText(interaction, '記録が見つかりません（IDの形式が正しくありません）');
    return;
  }

  const pk = userPk(discordId);
  const sk = recordSk(parsed.runDate, parsed.recordIdHex);

  const got = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { pk, sk }, ConsistentRead: true }));
  const item = got.Item as { updatedAt: number; distanceM: number; durationS: number } | undefined;
  if (!item) {
    await replyText(interaction, '記録が見つかりません（既に削除された可能性があります）');
    return;
  }

  const result = await deleteRecord(discordId, recordIdValue, item.updatedAt);
  if (!result.ok) {
    if (result.reason === 'not_found') {
      await replyText(interaction, '記録が見つかりません（既に削除された可能性があります）');
    } else {
      await replyText(interaction, '他の操作と競合しました。もう一度お試しください');
    }
    return;
  }

  const distanceKm = item.distanceM / 1000;
  await replyText(
    interaction,
    `記録を削除しました（${parsed.runDate} ${distanceKm}km ${formatClock(item.durationS)}）`,
  );
}

/** `/run web`: Web版へのリンクを返すだけ。 */
async function handleWeb(interaction: DiscordInteraction): Promise<void> {
  if (!SITE_ORIGIN) {
    await replyText(interaction, 'Web版のURLが未設定です。管理者に問い合わせてください。');
    return;
  }
  await replyText(interaction, `Web版のランニング記録はこちらから開けます:\n${SITE_ORIGIN}`);
}

async function dispatch(interaction: DiscordInteraction): Promise<void> {
  const discordId = getInteractionUserId(interaction);
  const userName = getInteractionUserName(interaction);

  if (!discordId || !userName) {
    // member/user のどちらも無いのは Discord 側の仕様上ほぼ起こらないはずだが、
    // 万一に備えてスタックトレース等は出さずに日本語エラーだけ返す。
    console.error('[worker] interaction has neither member nor user', JSON.stringify(interaction));
    await replyText(interaction, 'エラーが発生しました');
    return;
  }

  const sub = getSubcommand(interaction.data);
  if (!sub) {
    await replyText(interaction, 'エラーが発生しました');
    return;
  }

  switch (sub.name) {
    case SUB_ADD:
      await handleAdd(interaction, discordId, userName, sub.options);
      return;
    case SUB_LIST:
      await handleList(interaction, discordId);
      return;
    case SUB_DELETE:
      await handleDelete(interaction, discordId, sub.options);
      return;
    case SUB_WEB:
      await handleWeb(interaction);
      return;
    default:
      await replyText(interaction, '未対応のコマンドです');
  }
}

export const handler = async (event: DiscordInteraction): Promise<void> => {
  try {
    await dispatch(event);
  } catch (err) {
    // 想定外の例外はログにだけ残し、スタックトレース等はユーザーに返さない。
    console.error('[worker] unhandled error', err);
    try {
      await followup(event.application_id, event.token, { content: 'エラーが発生しました' });
    } catch (followupErr) {
      console.error('[worker] failed to send error followup', followupErr);
    }
  }
};
