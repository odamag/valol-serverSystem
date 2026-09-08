import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { jsonResponse } from '../lib/respond';
import { verifyHmac } from '../lib/verify-hmac';
import { validateCreateRecord, validateUpdateRecord } from '../lib/validate';
import { createRecord, deleteRecord, getSummary, listRecords, updateRecord } from '../lib/records';
import { monthKey, todayJst } from '../lib/jst';
import { type AggScope } from '../lib/keys';
import { getLeaderboard, getMyRank, pickNextThreshold, resolvePeriod } from '../lib/leaderboard';
import { getSettings } from '../lib/settings';

// フロントエンド（ブラウザ）が PHP プロキシ（api/running/index.php）経由で叩く Web API（ANY /v1/{proxy+}）。
//
// 重要な設計原則: すべての DynamoDB 操作の PK（U#<discordId>）は、必ず verifyHmac() が
// HMAC 署名の検証を通して確定させた discordId から作る。クライアントがリクエストボディや
// パス・クエリパラメータで discordId を渡せる経路は一切作らない
// （PHP プロキシ側も同様に、セッションから解決した discordId のみを署名対象にしている）。

const RECORD_ID_PATTERN = '[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9a-f]{32}';
const RECORD_PATH_RE = new RegExp(`^/v1/records/(${RECORD_ID_PATTERN})$`);
const PHOTO_PATH_RE = new RegExp(`^/v1/records/(${RECORD_ID_PATTERN})/photo(?:-url)?$`);

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  try {
    const verify = await verifyHmac(event);
    if (!verify.ok || !verify.discordId) {
      // 署名検証失敗の理由は返さない（document/running_api.md §2）。
      return jsonResponse(401, { success: false, message: '認証に失敗しました' });
    }
    const { discordId } = verify;

    // Web 経由のリクエストには表示名（Discordのニックネーム等）が渡ってこないため、
    // Phase 1 では暫定的に discordId をそのまま userName として使う。
    // ランキング表示などで実際の表示名が必要になる Phase 2 で解決する。
    const userName = discordId;

    const method = event.requestContext.http.method;
    const path = event.rawPath;

    if (path === '/v1/records') {
      if (method === 'GET') return await handleListRecords(event, discordId);
      if (method === 'POST') return await handleCreateRecord(event, discordId, userName);
    }

    const recordMatch = RECORD_PATH_RE.exec(path);
    if (recordMatch) {
      const id = recordMatch[1];
      if (method === 'PATCH') return await handleUpdateRecord(event, discordId, userName, id);
      if (method === 'DELETE') return await handleDeleteRecord(event, discordId, id);
    }

    if (path === '/v1/me/summary' && method === 'GET') {
      return await handleGetSummary(event, discordId);
    }

    if (path === '/v1/ranking' && method === 'GET') {
      return await handleGetRanking(event, discordId);
    }
    if (path === '/v1/settings' && method === 'GET') {
      return await handleGetSettings();
    }

    // Phase 4 で実装予定のエンドポイント。まだ何もできないことを明示するスタブ。
    if (PHOTO_PATH_RE.test(path) && method === 'POST') {
      return jsonResponse(501, { success: false, message: 'この機能はまだ利用できません' });
    }

    return jsonResponse(404, { success: false, message: 'Not Found' });
  } catch (err) {
    // スタックトレースなど内部情報はレスポンスに含めない。ログにだけ残す。
    console.error('[api] unhandled error', err);
    return jsonResponse(500, { success: false, message: 'サーバーエラーが発生しました' });
  }
};

// event.body は API Gateway が isBase64Encoded=true にすることがあるため考慮してデコードする。
// JSON として parse できない場合は undefined を返し、呼び出し側で 400 にする。
function parseJsonBody(event: APIGatewayProxyEventV2): unknown {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function handleListRecords(
  event: APIGatewayProxyEventV2,
  discordId: string,
): Promise<APIGatewayProxyStructuredResultV2> {
  const qs = event.queryStringParameters ?? {};

  let limit = 20;
  if (qs.limit !== undefined) {
    const n = Number(qs.limit);
    if (!Number.isInteger(n) || n < 1 || n > 50) {
      return jsonResponse(400, { success: false, message: 'limit は 1〜50 の整数で指定してください' });
    }
    limit = n;
  }

  const cursor = qs.cursor ?? null;
  const { records, nextCursor } = await listRecords(discordId, limit, cursor);
  return jsonResponse(200, { success: true, records, nextCursor });
}

async function handleCreateRecord(
  event: APIGatewayProxyEventV2,
  discordId: string,
  userName: string,
): Promise<APIGatewayProxyStructuredResultV2> {
  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'リクエストボディの形式が正しくありません' });
  }

  const result = validateCreateRecord(body);
  if (!result.ok) {
    return jsonResponse(400, { success: false, message: result.message });
  }

  const record = await createRecord(discordId, userName, 'web', result.value);
  return jsonResponse(200, { success: true, record });
}

async function handleUpdateRecord(
  event: APIGatewayProxyEventV2,
  discordId: string,
  userName: string,
  id: string,
): Promise<APIGatewayProxyStructuredResultV2> {
  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'リクエストボディの形式が正しくありません' });
  }

  const result = validateUpdateRecord(body);
  if (!result.ok) {
    return jsonResponse(400, { success: false, message: result.message });
  }

  const updated = await updateRecord(discordId, userName, id, result.value.patch, result.value.updatedAt);
  if (!updated.ok) {
    if (updated.reason === 'not_found') {
      return jsonResponse(404, { success: false, message: '記録が見つかりません' });
    }
    return jsonResponse(409, { success: false, message: '他の端末で更新されました。再読み込みしてください' });
  }

  return jsonResponse(200, { success: true, record: updated.record });
}

async function handleDeleteRecord(
  event: APIGatewayProxyEventV2,
  discordId: string,
  id: string,
): Promise<APIGatewayProxyStructuredResultV2> {
  const qs = event.queryStringParameters ?? {};
  const updatedAtRaw = qs.updatedAt;
  const updatedAt = updatedAtRaw !== undefined ? Number(updatedAtRaw) : NaN;

  if (updatedAtRaw === undefined || !Number.isFinite(updatedAt)) {
    return jsonResponse(400, { success: false, message: 'updatedAt を指定してください' });
  }

  const result = await deleteRecord(discordId, id, updatedAt);
  if (!result.ok) {
    if (result.reason === 'not_found') {
      return jsonResponse(404, { success: false, message: '記録が見つかりません' });
    }
    return jsonResponse(409, { success: false, message: '他の端末で更新されました。再読み込みしてください' });
  }

  return jsonResponse(200, { success: true });
}

async function handleGetSummary(
  event: APIGatewayProxyEventV2,
  discordId: string,
): Promise<APIGatewayProxyStructuredResultV2> {
  const qs = event.queryStringParameters ?? {};

  let month: string | undefined;
  if (qs.month !== undefined) {
    if (!/^\d{4}-\d{2}$/.test(qs.month)) {
      return jsonResponse(400, { success: false, message: 'month は YYYY-MM 形式で指定してください' });
    }
    month = qs.month;
  }

  // records.ts の getSummary は Phase 1 実装のため month.rank / nextThreshold を常に null で返す
  // （records.ts はランニング記録の集計ロジックのみに責務を絞る）。
  // Phase 2 分のランキング順位（leaderboard.ts）と閾値ロール（settings.ts）はここで計算して上書きする。
  const ym = month ?? monthKey(todayJst());

  const [summary, myRank, settings] = await Promise.all([
    getSummary(discordId, month),
    getMyRank('month', ym, discordId),
    getSettings(),
  ]);

  // distanceKm(= distanceM/1000) から distanceM を復元する。distanceM は保存時に整数メートルだったので、
  // Math.round で誤差なく元の値に戻せる（浮動小数点の丸め誤差は round で吸収される）。
  const monthDistanceM = Math.round(summary.month.distanceKm * 1000);

  return jsonResponse(200, {
    success: true,
    ...summary,
    month: { ...summary.month, rank: myRank ? myRank.rank : null },
    nextThreshold: pickNextThreshold(monthDistanceM, settings.thresholds),
  });
}

const RANKING_SCOPES: AggScope[] = ['month', 'week', 'total'];

async function handleGetRanking(
  event: APIGatewayProxyEventV2,
  discordId: string,
): Promise<APIGatewayProxyStructuredResultV2> {
  const qs = event.queryStringParameters ?? {};

  const scopeRaw = qs.scope ?? 'month';
  if (!RANKING_SCOPES.includes(scopeRaw as AggScope)) {
    return jsonResponse(400, { success: false, message: 'scope は month・week・total のいずれかで指定してください' });
  }
  const scope = scopeRaw as AggScope;

  let limit = 20;
  if (qs.limit !== undefined) {
    const n = Number(qs.limit);
    if (!Number.isInteger(n) || n < 1 || n > 50) {
      return jsonResponse(400, { success: false, message: 'limit は 1〜50 の整数で指定してください' });
    }
    limit = n;
  }

  const resolved = resolvePeriod(scope, qs.period);
  if (!resolved.ok) {
    return jsonResponse(400, { success: false, message: resolved.message });
  }
  const period = resolved.period ?? undefined;

  const [entries, me] = await Promise.all([
    getLeaderboard(scope, period, limit),
    getMyRank(scope, period, discordId),
  ]);

  return jsonResponse(200, { success: true, scope, period: resolved.period, entries, me });
}

async function handleGetSettings(): Promise<APIGatewayProxyStructuredResultV2> {
  const settings = await getSettings();
  // roleId は Discord 内部IDなので Web には露出させない（document/running_api.md §4）。
  const thresholds = settings.thresholds.map((t) => ({ km: t.km, roleName: t.roleName }));
  return jsonResponse(200, { success: true, thresholds });
}
