// 記録の作成/取得/一覧/更新/削除。DynamoDB の単一テーブルを直接操作する層。
// Web（handlers/api.ts）と Discord（worker.ts、Phase1では未実装）の両方から
// 同じ関数を呼ぶことで、集計の整合性ロジックを二重実装しない（document/running_api.md §6）。

import { randomBytes } from 'node:crypto';
import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb';
import { monthKey, todayJst, weekKey } from './jst';
import { aggSk, type AggScope, lbPk, parseRecordId, recordId as buildRecordId, recordSk, userPk } from './keys';
import type { RecordPatchInput, ValidatedRecordInput, Weather } from './validate';

export type Source = 'web' | 'discord';

/** document/running_api.md §3 の「記録オブジェクト」 */
export interface RunningRecord {
  id: string;
  runDate: string;
  distanceKm: number;
  durationS: number;
  paceSPerKm: number;
  memo: string | null;
  course: string | null;
  weather: Weather | null;
  heartRate: number | null;
  calories: number | null;
  photoUrl: string | null;
  source: Source;
  updatedAt: number;
}

// DynamoDB 上の記録アイテムの内部表現（テーブル本体に保存する形。API のレスポンス形とは別）。
interface RecordItem {
  pk: string;
  sk: string;
  type: 'RECORD';
  discordId: string;
  runDate: string;
  distanceM: number;
  durationS: number;
  paceSPerKm: number;
  memo: string | null;
  course: string | null;
  weather: Weather | null;
  heartRate: number | null;
  calories: number | null;
  photoKey: string | null;
  source: Source;
  userName: string;
  updatedAt: number;
}

interface AggItem {
  distanceM?: number;
  durationS?: number;
  runs?: number;
}

export interface PeriodSummary {
  distanceKm: number;
  durationS: number;
  runs: number;
}

export interface MeSummary {
  month: PeriodSummary & { rank: number | null };
  week: PeriodSummary;
  total: PeriodSummary;
  // 閾値ロール（roles.ts）は Phase 2 で実装するため、Phase 1 では常に null。
  nextThreshold: { km: number; remainingKm: number; roleName: string } | null;
}

function computePace(distanceM: number, durationS: number): number {
  return Math.round(durationS / (distanceM / 1000));
}

function toApiRecord(item: RecordItem, recordIdHex: string): RunningRecord {
  return {
    id: buildRecordId(item.runDate, recordIdHex),
    runDate: item.runDate,
    // 保存はメートル整数、APIの入出力は km の小数（document/running_api.md §3）
    distanceKm: item.distanceM / 1000,
    durationS: item.durationS,
    paceSPerKm: item.paceSPerKm,
    memo: item.memo,
    course: item.course,
    weather: item.weather,
    heartRate: item.heartRate,
    calories: item.calories,
    // Phase 4（S3 写真アップロード）は未実装のため常に null。
    photoUrl: null,
    source: item.source,
    updatedAt: item.updatedAt,
  };
}

// sk = "R#<runDate>#<recordIdHex>" から recordIdHex を取り出す。
// runDate 自体にハイフンはあっても "#" は含まれないため、"#" 区切りの3番目の要素で確定する。
function recordIdHexFromSk(sk: string): string {
  return sk.split('#')[2] ?? '';
}

/**
 * 集計アイテム（月/週/通算）への差分適用 Update を組み立てる。
 * createRecord（純増）・updateRecord（増減混在）・deleteRecord（純減）のすべてで共有する。
 *
 * 減算を含む場合（distanceM/durationS/runs のいずれかが負の delta）は、
 * 「現在値が減算後も0以上であること」を ConditionExpression で保証する。
 * 通常は集計値が整合しているはずだが、万一のバグやレース条件でズレていた場合に
 * 負値へドリフトさせるのではなく、その場でトランザクションを失敗させて早期に気付けるようにするため。
 */
function aggDeltaUpdate(params: {
  pk: string;
  scope: AggScope;
  period?: string;
  deltaDistanceM: number;
  deltaDurationS: number;
  deltaRuns: number;
  userName: string;
  now: number;
}): NonNullable<TransactWriteCommandInput['TransactItems']>[number] {
  const { pk, scope, period, deltaDistanceM, deltaDurationS, deltaRuns, userName, now } = params;

  const values: Record<string, unknown> = {
    ':g': lbPk(scope, period),
    ':n': userName,
    ':t': now,
    ':d': deltaDistanceM,
    ':s': deltaDurationS,
    ':r': deltaRuns,
  };

  let conditionExpression: string | undefined;
  if (deltaDistanceM < 0 || deltaDurationS < 0 || deltaRuns < 0) {
    values[':decD'] = deltaDistanceM < 0 ? -deltaDistanceM : 0;
    values[':decS'] = deltaDurationS < 0 ? -deltaDurationS : 0;
    values[':decR'] = deltaRuns < 0 ? -deltaRuns : 0;
    conditionExpression = 'distanceM >= :decD AND durationS >= :decS AND runs >= :decR';
  }

  return {
    Update: {
      TableName: TABLE_NAME,
      Key: { pk, sk: aggSk(scope, period) },
      UpdateExpression: 'SET gsi1pk = :g, userName = :n, updatedAt = :t ADD distanceM :d, durationS :s, runs :r',
      ...(conditionExpression ? { ConditionExpression: conditionExpression } : {}),
      ExpressionAttributeValues: values,
    },
  };
}

/** POST /v1/records。バリデーション済みの入力から記録を1件作成し、3つの集計（月/週/通算）に加算する。 */
export async function createRecord(
  discordId: string,
  userName: string,
  source: Source,
  input: ValidatedRecordInput,
): Promise<RunningRecord> {
  const recordIdHex = randomBytes(16).toString('hex');
  const now = Date.now();
  const pk = userPk(discordId);
  const sk = recordSk(input.runDate, recordIdHex);
  const paceSPerKm = computePace(input.distanceM, input.durationS);

  const item: RecordItem = {
    pk,
    sk,
    type: 'RECORD',
    discordId,
    runDate: input.runDate,
    distanceM: input.distanceM,
    durationS: input.durationS,
    paceSPerKm,
    memo: input.memo,
    course: input.course,
    weather: input.weather,
    heartRate: input.heartRate,
    calories: input.calories,
    photoKey: null,
    source,
    userName,
    updatedAt: now,
  };

  const ym = monthKey(input.runDate);
  const yw = weekKey(input.runDate);

  const transactItems: TransactWriteCommandInput['TransactItems'] = [
    {
      Put: {
        TableName: TABLE_NAME,
        Item: item,
        // 32桁のランダムhexなので衝突は天文学的に低確率だが、念のため二重作成を防ぐ。
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    },
    aggDeltaUpdate({
      pk,
      scope: 'month',
      period: ym,
      deltaDistanceM: input.distanceM,
      deltaDurationS: input.durationS,
      deltaRuns: 1,
      userName,
      now,
    }),
    aggDeltaUpdate({
      pk,
      scope: 'week',
      period: yw,
      deltaDistanceM: input.distanceM,
      deltaDurationS: input.durationS,
      deltaRuns: 1,
      userName,
      now,
    }),
    aggDeltaUpdate({
      pk,
      scope: 'total',
      deltaDistanceM: input.distanceM,
      deltaDurationS: input.durationS,
      deltaRuns: 1,
      userName,
      now,
    }),
  ];

  await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));

  return toApiRecord(item, recordIdHex);
}

export interface ListRecordsResult {
  records: RunningRecord[];
  nextCursor: string | null;
}

function encodeCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): Record<string, unknown> | null {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    const obj: unknown = JSON.parse(json);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      return obj as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** GET /v1/records。新しい順で一覧を返す。 */
export async function listRecords(
  discordId: string,
  limit: number,
  cursor: string | null,
): Promise<ListRecordsResult> {
  const pk = userPk(discordId);

  let exclusiveStartKey: Record<string, unknown> | undefined;
  if (cursor) {
    const decoded = decodeCursor(cursor);
    // 細工されたカーソル対策: 復号後に pk が自分自身のものであることを検証する。
    // 一致しなければエラーにはせず、無視して先頭から返す（他人のページ位置を覗き見できないようにする）。
    if (decoded && decoded.pk === pk) {
      exclusiveStartKey = decoded;
    }
  }

  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': pk, ':prefix': 'R#' },
      ScanIndexForward: false,
      Limit: limit,
      ExclusiveStartKey: exclusiveStartKey,
    }),
  );

  const items = (res.Items ?? []) as RecordItem[];
  const records = items.map((item) => toApiRecord(item, recordIdHexFromSk(item.sk)));
  const nextCursor = res.LastEvaluatedKey ? encodeCursor(res.LastEvaluatedKey) : null;

  return { records, nextCursor };
}

export type UpdateRecordResult =
  | { ok: true; record: RunningRecord }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'conflict' };

/**
 * PATCH /v1/records/<id>。差分適用。
 *
 * 月と週は必ず独立に判定する（monthKey(old) === monthKey(new) の結果を週の判定に流用しない）。
 * 理由: 同じ月内でも週をまたぐケース（例: 2026-09-30 → 2026-09-28 は月は同じだが週が違う）や、
 * 逆に月をまたいでも週が同じケース（例: 2026-09-30 → 2026-10-01 は月は違うが週は同じ）があるため、
 * 「月が変わった＝週も変わった」という前提は成り立たない。
 */
export async function updateRecord(
  discordId: string,
  userName: string,
  id: string,
  patch: RecordPatchInput,
  expectedUpdatedAt: number,
): Promise<UpdateRecordResult> {
  const parsed = parseRecordId(id);
  if (!parsed) return { ok: false, reason: 'not_found' };

  const pk = userPk(discordId);
  const oldSk = recordSk(parsed.runDate, parsed.recordIdHex);

  const got = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { pk, sk: oldSk }, ConsistentRead: true }));
  const oldItem = got.Item as RecordItem | undefined;
  if (!oldItem) return { ok: false, reason: 'not_found' };
  if (oldItem.updatedAt !== expectedUpdatedAt) return { ok: false, reason: 'conflict' };

  const now = Date.now();
  const newRunDate = patch.runDate ?? oldItem.runDate;
  const newDistanceM = patch.distanceM ?? oldItem.distanceM;
  const newDurationS = patch.durationS ?? oldItem.durationS;

  const newItem: RecordItem = {
    ...oldItem,
    sk: recordSk(newRunDate, parsed.recordIdHex),
    runDate: newRunDate,
    distanceM: newDistanceM,
    durationS: newDurationS,
    paceSPerKm: computePace(newDistanceM, newDurationS),
    memo: patch.memo !== undefined ? patch.memo : oldItem.memo,
    course: patch.course !== undefined ? patch.course : oldItem.course,
    weather: patch.weather !== undefined ? patch.weather : oldItem.weather,
    heartRate: patch.heartRate !== undefined ? patch.heartRate : oldItem.heartRate,
    calories: patch.calories !== undefined ? patch.calories : oldItem.calories,
    userName,
    updatedAt: now,
  };

  const oldYm = monthKey(oldItem.runDate);
  const newYm = monthKey(newRunDate);
  const oldYw = weekKey(oldItem.runDate);
  const newYw = weekKey(newRunDate);

  const deltaDistanceM = newDistanceM - oldItem.distanceM;
  const deltaDurationS = newDurationS - oldItem.durationS;

  const transactItems: TransactWriteCommandInput['TransactItems'] = [];

  if (newRunDate !== oldItem.runDate) {
    // 走行日が変わる場合は sk が変わるため、旧アイテムの Delete + 新アイテムの Put が必要
    // （DynamoDB は主キーを直接変更する Update をサポートしないため）。
    transactItems.push({
      Delete: {
        TableName: TABLE_NAME,
        Key: { pk, sk: oldSk },
        ConditionExpression: 'updatedAt = :expected',
        ExpressionAttributeValues: { ':expected': expectedUpdatedAt },
      },
    });
    transactItems.push({
      Put: {
        TableName: TABLE_NAME,
        Item: newItem,
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    });
  } else {
    transactItems.push({
      Update: {
        TableName: TABLE_NAME,
        Key: { pk, sk: oldSk },
        UpdateExpression:
          'SET distanceM = :dm, durationS = :ds, paceSPerKm = :pace, memo = :memo, course = :course, weather = :weather, heartRate = :hr, calories = :cal, userName = :n, updatedAt = :t',
        ConditionExpression: 'updatedAt = :expected',
        ExpressionAttributeValues: {
          ':dm': newItem.distanceM,
          ':ds': newItem.durationS,
          ':pace': newItem.paceSPerKm,
          ':memo': newItem.memo,
          ':course': newItem.course,
          ':weather': newItem.weather,
          ':hr': newItem.heartRate,
          ':cal': newItem.calories,
          ':n': userName,
          ':t': now,
          ':expected': expectedUpdatedAt,
        },
      },
    });
  }

  // 月（週とは独立に判定する。理由は関数コメント参照）
  if (newYm === oldYm) {
    if (deltaDistanceM !== 0 || deltaDurationS !== 0) {
      transactItems.push(
        aggDeltaUpdate({ pk, scope: 'month', period: newYm, deltaDistanceM, deltaDurationS, deltaRuns: 0, userName, now }),
      );
    }
  } else {
    transactItems.push(
      aggDeltaUpdate({
        pk,
        scope: 'month',
        period: oldYm,
        deltaDistanceM: -oldItem.distanceM,
        deltaDurationS: -oldItem.durationS,
        deltaRuns: -1,
        userName,
        now,
      }),
    );
    transactItems.push(
      aggDeltaUpdate({
        pk,
        scope: 'month',
        period: newYm,
        deltaDistanceM: newDistanceM,
        deltaDurationS: newDurationS,
        deltaRuns: 1,
        userName,
        now,
      }),
    );
  }

  // 週（月とは独立に判定する。理由は関数コメント参照）
  if (newYw === oldYw) {
    if (deltaDistanceM !== 0 || deltaDurationS !== 0) {
      transactItems.push(
        aggDeltaUpdate({ pk, scope: 'week', period: newYw, deltaDistanceM, deltaDurationS, deltaRuns: 0, userName, now }),
      );
    }
  } else {
    transactItems.push(
      aggDeltaUpdate({
        pk,
        scope: 'week',
        period: oldYw,
        deltaDistanceM: -oldItem.distanceM,
        deltaDurationS: -oldItem.durationS,
        deltaRuns: -1,
        userName,
        now,
      }),
    );
    transactItems.push(
      aggDeltaUpdate({
        pk,
        scope: 'week',
        period: newYw,
        deltaDistanceM: newDistanceM,
        deltaDurationS: newDurationS,
        deltaRuns: 1,
        userName,
        now,
      }),
    );
  }

  // 通算は走行日に関わらず常に同じ1パーティションなので、期間の分割は起こらない（距離・時間の差分のみ反映）。
  if (deltaDistanceM !== 0 || deltaDurationS !== 0) {
    transactItems.push(
      aggDeltaUpdate({ pk, scope: 'total', deltaDistanceM, deltaDurationS, deltaRuns: 0, userName, now }),
    );
  }

  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (err) {
    if (err instanceof TransactionCanceledException || err instanceof ConditionalCheckFailedException) {
      // 記録アイテムの updatedAt 不一致（他端末での更新）または集計の整合性チェック失敗。
      // どちらも「他の端末で更新されました」として扱う（前者が本来の想定ケース）。
      return { ok: false, reason: 'conflict' };
    }
    throw err;
  }

  return { ok: true, record: toApiRecord(newItem, parsed.recordIdHex) };
}

export type DeleteRecordResult = { ok: true } | { ok: false; reason: 'not_found' } | { ok: false; reason: 'conflict' };

/** DELETE /v1/records/<id>。3つの集計から減算しつつ記録を削除する。 */
export async function deleteRecord(
  discordId: string,
  id: string,
  expectedUpdatedAt: number,
): Promise<DeleteRecordResult> {
  const parsed = parseRecordId(id);
  if (!parsed) return { ok: false, reason: 'not_found' };

  const pk = userPk(discordId);
  const sk = recordSk(parsed.runDate, parsed.recordIdHex);

  const got = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { pk, sk }, ConsistentRead: true }));
  const item = got.Item as RecordItem | undefined;
  if (!item) return { ok: false, reason: 'not_found' };
  if (item.updatedAt !== expectedUpdatedAt) return { ok: false, reason: 'conflict' };

  const now = Date.now();
  const ym = monthKey(item.runDate);
  const yw = weekKey(item.runDate);

  const transactItems: TransactWriteCommandInput['TransactItems'] = [
    {
      Delete: {
        TableName: TABLE_NAME,
        Key: { pk, sk },
        ConditionExpression: 'updatedAt = :expected',
        ExpressionAttributeValues: { ':expected': expectedUpdatedAt },
      },
    },
    aggDeltaUpdate({
      pk,
      scope: 'month',
      period: ym,
      deltaDistanceM: -item.distanceM,
      deltaDurationS: -item.durationS,
      deltaRuns: -1,
      userName: item.userName,
      now,
    }),
    aggDeltaUpdate({
      pk,
      scope: 'week',
      period: yw,
      deltaDistanceM: -item.distanceM,
      deltaDurationS: -item.durationS,
      deltaRuns: -1,
      userName: item.userName,
      now,
    }),
    aggDeltaUpdate({
      pk,
      scope: 'total',
      deltaDistanceM: -item.distanceM,
      deltaDurationS: -item.durationS,
      deltaRuns: -1,
      userName: item.userName,
      now,
    }),
  ];

  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (err) {
    if (err instanceof TransactionCanceledException || err instanceof ConditionalCheckFailedException) {
      return { ok: false, reason: 'conflict' };
    }
    throw err;
  }

  return { ok: true };
}

async function getAggregate(discordId: string, scope: AggScope, period?: string): Promise<PeriodSummary> {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { pk: userPk(discordId), sk: aggSk(scope, period) } }),
  );
  const item = res.Item as AggItem | undefined;
  return {
    distanceKm: (item?.distanceM ?? 0) / 1000,
    durationS: item?.durationS ?? 0,
    runs: item?.runs ?? 0,
  };
}

/** 指定した月の集計を取得する（GET /v1/me/summary などから使う）。 */
export async function getMonthlyAggregate(discordId: string, ym: string): Promise<PeriodSummary> {
  return getAggregate(discordId, 'month', ym);
}

/** GET /v1/me/summary。month 省略時は JST の当月。週は常に JST の「今週」。 */
export async function getSummary(discordId: string, monthOverride?: string): Promise<MeSummary> {
  const today = todayJst();
  const ym = monthOverride ?? monthKey(today);
  const yw = weekKey(today);

  const [month, week, total] = await Promise.all([
    getAggregate(discordId, 'month', ym),
    getAggregate(discordId, 'week', yw),
    getAggregate(discordId, 'total'),
  ]);

  return {
    // ランキング（rank）は Phase 2 で GSI1 を使って実装する。Phase 1 では常に null。
    month: { ...month, rank: null },
    week,
    total,
    // 閾値ロール（roles.ts）も Phase 2 実装のため常に null。
    nextThreshold: null,
  };
}
