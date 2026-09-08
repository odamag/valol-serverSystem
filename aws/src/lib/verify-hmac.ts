import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb';
import { getRunningParameter } from './ssm';

// PHP プロキシ（api/running/lib/aws.php）からの HMAC 署名を検証する。
// canonical string の組み立て方・順序は `document/running_api.md` §2 が仕様の正であり、
// PHP 側の実装（api/running/lib/aws.php の runningForward()）と1バイトも違わず一致させる必要がある。
//
//   method \n path \n query \n discordId \n ts \n nonce \n sha256hex(body)

const MAX_CLOCK_SKEW_SECONDS = 300;
const NONCE_TTL_SECONDS = 600;

export interface HmacVerifyResult {
  ok: boolean;
  /** ok=true のときだけ設定される。以降の全ての DynamoDB 操作の PK はこの値から作ること。 */
  discordId?: string;
}

// API Gateway HTTP API はヘッダ名を小文字化して渡すのが通常だが、それに依存しすぎず
// 大文字小文字を無視して探す（curl 経由で来る値の大文字小文字はPHP側の実装に依存するため）。
function getHeader(event: APIGatewayProxyEventV2, name: string): string | undefined {
  const headers = event.headers ?? {};
  const lowerName = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerName) {
      return headers[key];
    }
  }
  return undefined;
}

function getRawBodyBuffer(event: APIGatewayProxyEventV2): Buffer {
  const body = event.body ?? '';
  // API Gateway がバイナリと判定した場合は base64 エンコードして渡してくるため、
  // その場合はデコードしてから生バイト列としてハッシュを取る必要がある。
  return event.isBase64Encoded ? Buffer.from(body, 'base64') : Buffer.from(body, 'utf8');
}

/**
 * リクエストの HMAC 署名を検証し、リプレイ対策（nonce）も行う。
 * 失敗時は理由を返さない（呼び出し側は一律 401 + 汎用メッセージにすること）。
 */
export async function verifyHmac(event: APIGatewayProxyEventV2): Promise<HmacVerifyResult> {
  const discordId = getHeader(event, 'X-Run-Discord-Id');
  const ts = getHeader(event, 'X-Run-Ts');
  const nonce = getHeader(event, 'X-Run-Nonce');
  const signature = getHeader(event, 'X-Run-Signature');

  // (1) ヘッダの存在確認
  if (!discordId || !ts || !nonce || !signature) {
    return { ok: false };
  }

  // (2) 時刻チェック。署名の一致確認より先に行う。
  // これを署名確認の後に回すと、不正な（署名が一致しない）リクエストであっても
  // 時刻さえ正しければ nonce テーブルへの書き込みまで進んでしまい得るため
  // （※実際に nonce を書き込むのは (3) の署名確認を通過した後だが、時刻チェック自体は
  // 署名計算より軽い処理なので、無駄な HMAC 計算・SSM 参照を避ける意味でも先に弾く）。
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) {
    return { ok: false };
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - tsNum) > MAX_CLOCK_SKEW_SECONDS) {
    return { ok: false };
  }

  // (3) 署名の一致確認
  const secret = await getRunningParameter('proxy-shared-secret');
  const method = event.requestContext.http.method;
  const path = event.rawPath;
  const query = event.rawQueryString ?? '';
  const bodyHash = createHash('sha256').update(getRawBodyBuffer(event)).digest('hex');

  const canonical = [method, path, query, discordId, ts, nonce, bodyHash].join('\n');
  const expectedSignature = createHmac('sha256', secret).update(canonical).digest('hex');

  const expectedBuf = Buffer.from(expectedSignature, 'utf8');
  const actualBuf = Buffer.from(signature, 'utf8');
  // timingSafeEqual は長さが異なると例外を投げるため、先に長さを比較して false を返す。
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    return { ok: false };
  }

  // (4) nonce の初出チェック。
  // 必ず署名検証を通過した後にのみ nonce を書き込む。もし署名確認より先に nonce を
  // 消費してしまうと、署名が不正な（＝誰でも送れる）リクエストだけで正規のリクエストの
  // nonce を先に潰せてしまい、正当なリクエストがリプレイ扱いで拒否される DoS の穴になる。
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: { pk: `NONCE#${nonce}`, sk: 'NONCE', ttl: nowSeconds + NONCE_TTL_SECONDS },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      // 同じ nonce が既に使われている＝リプレイ（再送）とみなして拒否する。
      return { ok: false };
    }
    throw err;
  }

  return { ok: true, discordId };
}
