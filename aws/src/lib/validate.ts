// 記録の入力バリデーション。
// Web（handlers/api.ts）と Discord（worker.ts、Phase1では未実装）の両方から
// 同じ関数を呼ぶことで、丸め・上限・エラーメッセージの規約がズレないようにする
// （document/running_api.md §6）。
//
// 例外ではなく判別可能ユニオン { ok: true, value } | { ok: false, message } で結果を返す。
// ハンドラ側は ok を見るだけで素直に 400 レスポンスへ変換できる。

import { isValidRunDate, todayJst } from './jst';

export type Weather = 'sunny' | 'cloudy' | 'rain' | 'snow' | 'windy' | 'indoor';

const WEATHERS: readonly Weather[] = ['sunny', 'cloudy', 'rain', 'snow', 'windy', 'indoor'];

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string };

/** POST /v1/records で作成する記録の、バリデーション済み入力（サーバー側の単位に丸め済み） */
export interface ValidatedRecordInput {
  runDate: string;
  distanceM: number;
  durationS: number;
  memo: string | null;
  course: string | null;
  weather: Weather | null;
  heartRate: number | null;
  calories: number | null;
}

/** PATCH /v1/records/<id> の部分更新。キーが存在しないフィールドは「変更しない」を意味する。 */
export interface RecordPatchInput {
  runDate?: string;
  distanceM?: number;
  durationS?: number;
  memo?: string | null;
  course?: string | null;
  weather?: Weather | null;
  heartRate?: number | null;
  calories?: number | null;
}

const CREATE_ALLOWED_FIELDS = [
  'runDate',
  'distanceKm',
  'durationS',
  'memo',
  'course',
  'weather',
  'heartRate',
  'calories',
] as const;

// PATCH では楽観ロック用の updatedAt も併せて許可する。
const UPDATE_ALLOWED_FIELDS = [...CREATE_ALLOWED_FIELDS, 'updatedAt'] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// api/arena/routes/admin.php の arenaCheckAllowedFields() と同じ思想:
// 許可されたキーの一覧と照合し、知らないキーが来たら拒否する
// （タイポや将来の互換性のないクライアントからの誤った入力を早期に検知するため）。
function checkAllowedFields(body: Record<string, unknown>, allowed: readonly string[]): string | null {
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    return `不明なフィールドが含まれています: ${unknown.join(', ')}`;
  }
  return null;
}

function validateWeather(v: unknown): ValidationResult<Weather | null> {
  if (v === undefined || v === null) {
    return { ok: true, value: null };
  }
  if (typeof v === 'string' && (WEATHERS as readonly string[]).includes(v)) {
    return { ok: true, value: v as Weather };
  }
  return { ok: false, message: '天気は sunny・cloudy・rain・snow・windy・indoor のいずれかで指定してください' };
}

function validateIntRangeOrNull(
  v: unknown,
  min: number,
  max: number,
  message: string,
): ValidationResult<number | null> {
  if (v === undefined || v === null) {
    return { ok: true, value: null };
  }
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
    return { ok: false, message };
  }
  if (v < min || v > max) {
    return { ok: false, message };
  }
  return { ok: true, value: v };
}

function validateStringOrNull(v: unknown, maxLen: number, message: string): ValidationResult<string | null> {
  if (v === undefined || v === null) {
    return { ok: true, value: null };
  }
  if (typeof v !== 'string') {
    return { ok: false, message };
  }
  if (v.length > maxLen) {
    return { ok: false, message };
  }
  return { ok: true, value: v };
}

function validateDistanceKm(v: unknown): ValidationResult<number> {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return { ok: false, message: '距離を数値で指定してください' };
  }
  if (v < 0.1 || v > 300) {
    return { ok: false, message: '距離は 0.1km 以上 300km 以下で指定してください' };
  }
  return { ok: true, value: v };
}

function validateDurationS(v: unknown): ValidationResult<number> {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
    return { ok: false, message: '時間は整数の秒数で指定してください' };
  }
  if (v < 1 || v > 86400) {
    return { ok: false, message: '時間は 1秒以上 86400秒（24時間）以下で指定してください' };
  }
  return { ok: true, value: v };
}

function validateRunDate(v: unknown): ValidationResult<string> {
  if (typeof v !== 'string' || !isValidRunDate(v)) {
    return { ok: false, message: '走行日は YYYY-MM-DD 形式の実在する日付で指定してください' };
  }
  return { ok: true, value: v };
}

/** POST /v1/records の入力を検証する。 */
export function validateCreateRecord(body: unknown): ValidationResult<ValidatedRecordInput> {
  if (!isPlainObject(body)) {
    return { ok: false, message: 'リクエストボディの形式が正しくありません' };
  }

  const fieldsErr = checkAllowedFields(body, CREATE_ALLOWED_FIELDS);
  if (fieldsErr) return { ok: false, message: fieldsErr };

  if (body.distanceKm === undefined) {
    return { ok: false, message: '距離を入力してください' };
  }
  const distance = validateDistanceKm(body.distanceKm);
  if (!distance.ok) return distance;

  if (body.durationS === undefined) {
    return { ok: false, message: '時間を入力してください' };
  }
  const duration = validateDurationS(body.durationS);
  if (!duration.ok) return duration;

  const runDate = body.runDate === undefined ? { ok: true as const, value: todayJst() } : validateRunDate(body.runDate);
  if (!runDate.ok) return runDate;

  const weather = validateWeather(body.weather);
  if (!weather.ok) return weather;

  const heartRate = validateIntRangeOrNull(body.heartRate, 30, 250, '心拍数は 30〜250 の範囲で指定してください');
  if (!heartRate.ok) return heartRate;

  const calories = validateIntRangeOrNull(body.calories, 1, 10000, '消費カロリーは 1〜10000 の範囲で指定してください');
  if (!calories.ok) return calories;

  const memo = validateStringOrNull(body.memo, 500, 'メモは500文字以内で入力してください');
  if (!memo.ok) return memo;

  const course = validateStringOrNull(body.course, 100, 'コース名は100文字以内で入力してください');
  if (!course.ok) return course;

  return {
    ok: true,
    value: {
      runDate: runDate.value,
      // 丸めの規約（document/running_api.md §3）: distanceKm → distanceM は Math.round(km * 1000)
      distanceM: Math.round(distance.value * 1000),
      durationS: duration.value,
      memo: memo.value,
      course: course.value,
      weather: weather.value,
      heartRate: heartRate.value,
      calories: calories.value,
    },
  };
}

/** PATCH /v1/records/<id> の入力を検証する。存在するキーだけを部分更新の対象にする。 */
export function validateUpdateRecord(
  body: unknown,
): ValidationResult<{ patch: RecordPatchInput; updatedAt: number }> {
  if (!isPlainObject(body)) {
    return { ok: false, message: 'リクエストボディの形式が正しくありません' };
  }

  const fieldsErr = checkAllowedFields(body, UPDATE_ALLOWED_FIELDS);
  if (fieldsErr) return { ok: false, message: fieldsErr };

  if (typeof body.updatedAt !== 'number' || !Number.isFinite(body.updatedAt)) {
    return { ok: false, message: 'updatedAt を指定してください' };
  }

  const patch: RecordPatchInput = {};

  if (body.runDate !== undefined) {
    const runDate = validateRunDate(body.runDate);
    if (!runDate.ok) return runDate;
    patch.runDate = runDate.value;
  }

  if (body.distanceKm !== undefined) {
    const distance = validateDistanceKm(body.distanceKm);
    if (!distance.ok) return distance;
    patch.distanceM = Math.round(distance.value * 1000);
  }

  if (body.durationS !== undefined) {
    const duration = validateDurationS(body.durationS);
    if (!duration.ok) return duration;
    patch.durationS = duration.value;
  }

  if ('weather' in body) {
    const weather = validateWeather(body.weather);
    if (!weather.ok) return weather;
    patch.weather = weather.value;
  }

  if ('heartRate' in body) {
    const heartRate = validateIntRangeOrNull(body.heartRate, 30, 250, '心拍数は 30〜250 の範囲で指定してください');
    if (!heartRate.ok) return heartRate;
    patch.heartRate = heartRate.value;
  }

  if ('calories' in body) {
    const calories = validateIntRangeOrNull(body.calories, 1, 10000, '消費カロリーは 1〜10000 の範囲で指定してください');
    if (!calories.ok) return calories;
    patch.calories = calories.value;
  }

  if ('memo' in body) {
    const memo = validateStringOrNull(body.memo, 500, 'メモは500文字以内で入力してください');
    if (!memo.ok) return memo;
    patch.memo = memo.value;
  }

  if ('course' in body) {
    const course = validateStringOrNull(body.course, 100, 'コース名は100文字以内で入力してください');
    if (!course.ok) return course;
    patch.course = course.value;
  }

  return { ok: true, value: { patch, updatedAt: body.updatedAt } };
}
