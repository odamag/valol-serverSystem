import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { jsonResponse } from '../lib/respond';
import { verifyHmac } from '../lib/verify-hmac';
import { validateCreateRecord, validateUpdateRecord } from '../lib/validate';
import { createRecord, deleteRecord, getSummary, listRecords, setRecordPhotoKey, updateRecord } from '../lib/records';
import { monthKey, todayJst } from '../lib/jst';
import { ddb, TABLE_NAME } from '../lib/ddb';
import { type AggScope, parseRecordId, recordSk, userPk } from '../lib/keys';
import { getLeaderboard, getMyRank, pickNextThreshold, resolvePeriod } from '../lib/leaderboard';
import { getSettings } from '../lib/settings';
import { syncThresholdRole } from '../lib/roles';
import { commitPhoto, createPhotoUploadPost, deletePhoto, isAllowedImageContentType } from '../lib/s3';

// フロントエンド（ブラウザ）が PHP プロキシ（api/running/index.php）経由で叩く Web API（ANY /v1/{proxy+}）。
//
// 重要な設計原則: すべての DynamoDB 操作の PK（U#<discordId>）は、必ず verifyHmac() が
// HMAC 署名の検証を通して確定させた discordId から作る。クライアントがリクエストボディや
// パス・クエリパラメータで discordId を渡せる経路は一切作らない
// （PHP プロキシ側も同様に、セッションから解決した discordId のみを署名対象にしている）。

const RECORD_ID_PATTERN = '[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9a-f]{32}';
const RECORD_PATH_RE = new RegExp(`^/v1/records/(${RECORD_ID_PATTERN})$`);
const PHOTO_URL_PATH_RE = new RegExp(`^/v1/records/(${RECORD_ID_PATTERN})/photo-url$`);
const PHOTO_COMMIT_PATH_RE = new RegExp(`^/v1/records/(${RECORD_ID_PATTERN})/photo$`);

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

    const photoUrlMatch = PHOTO_URL_PATH_RE.exec(path);
    if (photoUrlMatch && method === 'POST') {
      return await handleCreatePhotoUrl(event, discordId, photoUrlMatch[1]);
    }

    const photoCommitMatch = PHOTO_COMMIT_PATH_RE.exec(path);
    if (photoCommitMatch && method === 'POST') {
      return await handleCommitPhoto(event, discordId, photoCommitMatch[1]);
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

  // ロール同期はベストエフォート: 記録は既にコミット済みのため、ここで失敗しても
  // 記録の保存自体を巻き戻してはいけない。ログにだけ残し、レスポンスは成功のまま返す。
  try {
    await syncThresholdRole(discordId, record.runDate);
  } catch (err) {
    console.error('[api] syncThresholdRole failed after createRecord', err);
  }

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

  // ロール同期はベストエフォート（理由は handleCreateRecord 参照）。
  // runDate が変わる編集では新旧どちらの月が当月かでロールへの影響が変わりうるため、
  // 編集前後両方の runDate で同期を試みる（syncThresholdRole 自身が当月以外はスキップする）。
  // 編集前の runDate は id（"<runDate>_<hex>" 形式。runDate 変更時は id 自体が変わるため、
  // ここで受け取った id が編集前のもの）から復元できる。
  try {
    const oldParsed = parseRecordId(id);
    if (oldParsed) {
      await syncThresholdRole(discordId, oldParsed.runDate);
    }
    await syncThresholdRole(discordId, updated.record.runDate);
  } catch (err) {
    console.error('[api] syncThresholdRole failed after updateRecord', err);
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

  // ロール同期はベストエフォート（理由は handleCreateRecord 参照）。
  const parsed = parseRecordId(id);
  if (parsed) {
    try {
      await syncThresholdRole(discordId, parsed.runDate);
    } catch (err) {
      console.error('[api] syncThresholdRole failed after deleteRecord', err);
    }
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

/**
 * POST /v1/records/<id>/photo-url。document/running_api.md §5 のステップ1。
 * 記録の存在を確認してから署名を発行する（存在しない/他人の記録IDに対して
 * 署名付きアップロード枠を発行してしまうと、無意味なアップロード先を量産されてしまうため）。
 */
async function handleCreatePhotoUrl(
  event: APIGatewayProxyEventV2,
  discordId: string,
  id: string,
): Promise<APIGatewayProxyStructuredResultV2> {
  const body = parseJsonBody(event);
  if (body === undefined || typeof body !== 'object' || body === null) {
    return jsonResponse(400, { success: false, message: 'リクエストボディの形式が正しくありません' });
  }

  const contentType = (body as Record<string, unknown>).contentType;
  if (!isAllowedImageContentType(contentType)) {
    return jsonResponse(400, { success: false, message: '画像は PNG・JPEG・WebP のいずれかで指定してください' });
  }

  const parsed = parseRecordId(id);
  if (!parsed) {
    return jsonResponse(404, { success: false, message: '記録が見つかりません' });
  }

  const got = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: userPk(discordId), sk: recordSk(parsed.runDate, parsed.recordIdHex) },
    }),
  );
  if (!got.Item) {
    return jsonResponse(404, { success: false, message: '記録が見つかりません' });
  }

  const upload = await createPhotoUploadPost(discordId, id, contentType);
  return jsonResponse(200, {
    success: true,
    upload: { url: upload.url, fields: upload.fields },
    key: upload.key,
  });
}

/**
 * POST /v1/records/<id>/photo。document/running_api.md §5 のステップ3。
 * commitPhoto で tmp/ の一時オブジェクトを検証・確定し、記録に photoKey を保存する。
 * 既に写真が設定済み（差し替え）だった場合は、放置すると課金対象のゴミになる古いオブジェクトを削除する。
 */
async function handleCommitPhoto(
  event: APIGatewayProxyEventV2,
  discordId: string,
  id: string,
): Promise<APIGatewayProxyStructuredResultV2> {
  const body = parseJsonBody(event);
  if (body === undefined || typeof body !== 'object' || body === null) {
    return jsonResponse(400, { success: false, message: 'リクエストボディの形式が正しくありません' });
  }

  const key = (body as Record<string, unknown>).key;
  if (typeof key !== 'string') {
    return jsonResponse(400, { success: false, message: 'key を指定してください' });
  }

  const committed = await commitPhoto(discordId, id, key);
  if (!committed.ok) {
    return jsonResponse(400, { success: false, message: committed.message });
  }

  const result = await setRecordPhotoKey(discordId, id, committed.key);
  if (!result.ok) {
    // 確定は成功したのに記録が見つからない（削除と競合した等）場合、S3 にゴミを残さないよう掃除する。
    try {
      await deletePhoto(committed.key);
    } catch (err) {
      console.error('[api] failed to clean up orphaned photo', err);
    }
    return jsonResponse(404, { success: false, message: '記録が見つかりません' });
  }

  if (result.oldPhotoKey) {
    // 差し替え時の古い写真の削除はベストエフォート: 失敗しても記録の更新自体（DynamoDB）は
    // 既にコミット済みのため巻き戻さず、ログにだけ残す。
    try {
      await deletePhoto(result.oldPhotoKey);
    } catch (err) {
      console.error('[api] failed to delete old photo after replace', err);
    }
  }

  return jsonResponse(200, { success: true, record: result.record });
}
