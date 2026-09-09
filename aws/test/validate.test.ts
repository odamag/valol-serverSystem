// validate.ts の単体テスト。
// node:test ランナーは使わず、node:assert のみで検証する自前ランナー形式にする
//（失敗したら process.exit(1)）。実行: `ts-node test/validate.test.ts`

import assert from 'node:assert/strict';
import { todayJst } from '../src/lib/jst';
import { validateCreateRecord, validateUpdateRecord } from '../src/lib/validate';

let failures = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok - ${name}`);
  } catch (err) {
    failures++;
    console.error(`  NG - ${name}`);
    console.error(err instanceof Error ? err.message : err);
  }
}

console.log('validate.test.ts');

// ── validateCreateRecord: 正常系 ──────────────────────────────────
test('create: 最小の正常入力（距離と時間のみ）', () => {
  const res = validateCreateRecord({ distanceKm: 5.2, durationS: 1590 });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.distanceM, 5200);
    assert.equal(res.value.durationS, 1590);
    assert.equal(res.value.runDate, todayJst());
    assert.equal(res.value.memo, null);
    assert.equal(res.value.course, null);
    assert.equal(res.value.weather, null);
    assert.equal(res.value.heartRate, null);
    assert.equal(res.value.calories, null);
  }
});

test('create: 全フィールドを指定した正常入力', () => {
  const res = validateCreateRecord({
    runDate: '2026-09-01',
    distanceKm: 10,
    durationS: 3000,
    memo: 'いい天気だった',
    course: '皇居一周',
    weather: 'sunny',
    heartRate: 150,
    calories: 500,
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.deepEqual(res.value, {
      runDate: '2026-09-01',
      distanceM: 10000,
      durationS: 3000,
      memo: 'いい天気だった',
      course: '皇居一周',
      weather: 'sunny',
      heartRate: 150,
      calories: 500,
    });
  }
});

test('create: 距離のkm->m丸めはMath.round(km*1000)', () => {
  const res = validateCreateRecord({ distanceKm: 5.2005, durationS: 100 });
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.value.distanceM, 5201); // 5200.5 -> round -> 5201 (5200.5は四捨五入で5201)
});

// ── validateCreateRecord: 距離のバリデーション ────────────────────
test('create: 距離の下限境界値0.1kmは有効', () => {
  assert.equal(validateCreateRecord({ distanceKm: 0.1, durationS: 60 }).ok, true);
});

test('create: 距離の上限境界値300kmは有効', () => {
  assert.equal(validateCreateRecord({ distanceKm: 300, durationS: 60 }).ok, true);
});

test('create: 距離が0.1km未満は無効', () => {
  const res = validateCreateRecord({ distanceKm: 0.05, durationS: 60 });
  assert.equal(res.ok, false);
});

test('create: 距離が300km超は無効', () => {
  const res = validateCreateRecord({ distanceKm: 300.1, durationS: 60 });
  assert.equal(res.ok, false);
});

test('create: 距離が未指定は無効', () => {
  assert.equal(validateCreateRecord({ durationS: 60 }).ok, false);
});

test('create: 距離が文字列は無効', () => {
  assert.equal(validateCreateRecord({ distanceKm: '5.2', durationS: 60 }).ok, false);
});

// ── validateCreateRecord: 時間のバリデーション ────────────────────
test('create: 時間の下限境界値1秒は有効', () => {
  assert.equal(validateCreateRecord({ distanceKm: 1, durationS: 1 }).ok, true);
});

test('create: 時間の上限境界値86400秒は有効', () => {
  assert.equal(validateCreateRecord({ distanceKm: 1, durationS: 86400 }).ok, true);
});

test('create: 時間が0秒は無効', () => {
  assert.equal(validateCreateRecord({ distanceKm: 1, durationS: 0 }).ok, false);
});

test('create: 時間が86401秒は無効', () => {
  assert.equal(validateCreateRecord({ distanceKm: 1, durationS: 86401 }).ok, false);
});

test('create: 時間が整数でない（小数）は無効', () => {
  assert.equal(validateCreateRecord({ distanceKm: 1, durationS: 60.5 }).ok, false);
});

test('create: 時間が未指定は無効', () => {
  assert.equal(validateCreateRecord({ distanceKm: 1 }).ok, false);
});

// ── validateCreateRecord: runDate ─────────────────────────────────
test('create: runDate省略時はJSTの今日になる', () => {
  const res = validateCreateRecord({ distanceKm: 1, durationS: 60 });
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.value.runDate, todayJst());
});

test('create: runDateが不正な日付は無効', () => {
  assert.equal(validateCreateRecord({ distanceKm: 1, durationS: 60, runDate: '2026-02-30' }).ok, false);
});

// ── validateCreateRecord: weather ─────────────────────────────────
test('create: weatherの全許可値が有効', () => {
  for (const w of ['sunny', 'cloudy', 'rain', 'snow', 'windy', 'indoor']) {
    const res = validateCreateRecord({ distanceKm: 1, durationS: 60, weather: w });
    assert.equal(res.ok, true, `weather=${w} should be valid`);
  }
});

test('create: weatherがnullは有効', () => {
  assert.equal(validateCreateRecord({ distanceKm: 1, durationS: 60, weather: null }).ok, true);
});

test('create: weatherが不正な文字列は無効', () => {
  assert.equal(validateCreateRecord({ distanceKm: 1, durationS: 60, weather: 'typhoon' }).ok, false);
});

// ── validateCreateRecord: heartRate / calories ────────────────────
test('create: heartRateの境界値30と250は有効', () => {
  assert.equal(validateCreateRecord({ distanceKm: 1, durationS: 60, heartRate: 30 }).ok, true);
  assert.equal(validateCreateRecord({ distanceKm: 1, durationS: 60, heartRate: 250 }).ok, true);
});

test('create: heartRateが範囲外は無効', () => {
  assert.equal(validateCreateRecord({ distanceKm: 1, durationS: 60, heartRate: 29 }).ok, false);
  assert.equal(validateCreateRecord({ distanceKm: 1, durationS: 60, heartRate: 251 }).ok, false);
});

test('create: caloriesの境界値1と10000は有効', () => {
  assert.equal(validateCreateRecord({ distanceKm: 1, durationS: 60, calories: 1 }).ok, true);
  assert.equal(validateCreateRecord({ distanceKm: 1, durationS: 60, calories: 10000 }).ok, true);
});

test('create: caloriesが範囲外は無効', () => {
  assert.equal(validateCreateRecord({ distanceKm: 1, durationS: 60, calories: 0 }).ok, false);
  assert.equal(validateCreateRecord({ distanceKm: 1, durationS: 60, calories: 10001 }).ok, false);
});

// ── validateCreateRecord: memo / course ───────────────────────────
test('create: memoが500文字ちょうどは有効', () => {
  assert.equal(validateCreateRecord({ distanceKm: 1, durationS: 60, memo: 'a'.repeat(500) }).ok, true);
});

test('create: memoが501文字は無効', () => {
  assert.equal(validateCreateRecord({ distanceKm: 1, durationS: 60, memo: 'a'.repeat(501) }).ok, false);
});

test('create: courseが100文字ちょうどは有効', () => {
  assert.equal(validateCreateRecord({ distanceKm: 1, durationS: 60, course: 'a'.repeat(100) }).ok, true);
});

test('create: courseが101文字は無効', () => {
  assert.equal(validateCreateRecord({ distanceKm: 1, durationS: 60, course: 'a'.repeat(101) }).ok, false);
});

// ── validateCreateRecord: 未知のフィールド ────────────────────────
test('create: 未知のフィールドは無効（400相当）', () => {
  const res = validateCreateRecord({ distanceKm: 1, durationS: 60, foo: 'bar' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.message, /foo/);
});

test('create: ボディがオブジェクトでない場合は無効', () => {
  assert.equal(validateCreateRecord('not an object').ok, false);
  assert.equal(validateCreateRecord(null).ok, false);
  assert.equal(validateCreateRecord([1, 2, 3]).ok, false);
});

// ── validateUpdateRecord ───────────────────────────────────────────
test('update: updatedAtのみでも有効（部分更新なので空パッチ）', () => {
  const res = validateUpdateRecord({ updatedAt: 1234567890 });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.deepEqual(res.value.patch, {});
    assert.equal(res.value.updatedAt, 1234567890);
  }
});

test('update: updatedAtが未指定は無効', () => {
  assert.equal(validateUpdateRecord({ distanceKm: 5 }).ok, false);
});

test('update: 指定したフィールドのみpatchに含まれる（他は変更しない）', () => {
  const res = validateUpdateRecord({ updatedAt: 1, memo: '更新後のメモ' });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.deepEqual(res.value.patch, { memo: '更新後のメモ' });
  }
});

test('update: weatherをnullに変更するパッチ', () => {
  const res = validateUpdateRecord({ updatedAt: 1, weather: null });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.patch.weather, null);
    assert.ok('weather' in res.value.patch);
  }
});

test('update: distanceKmはdistanceMに変換されてpatchに入る', () => {
  const res = validateUpdateRecord({ updatedAt: 1, distanceKm: 3.5 });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.patch.distanceM, 3500);
    assert.ok(!('distanceKm' in res.value.patch));
  }
});

test('update: 距離が範囲外は無効', () => {
  assert.equal(validateUpdateRecord({ updatedAt: 1, distanceKm: 0 }).ok, false);
  assert.equal(validateUpdateRecord({ updatedAt: 1, distanceKm: 301 }).ok, false);
});

test('update: runDateが不正な日付は無効', () => {
  assert.equal(validateUpdateRecord({ updatedAt: 1, runDate: '2026-13-40' }).ok, false);
});

test('update: 未知のフィールドは無効', () => {
  const res = validateUpdateRecord({ updatedAt: 1, unknownField: 'x' });
  assert.equal(res.ok, false);
});

test('update: ボディがオブジェクトでない場合は無効', () => {
  assert.equal(validateUpdateRecord(42).ok, false);
});

if (failures > 0) {
  console.error(`\nvalidate.test.ts: ${failures} failure(s)`);
  process.exit(1);
} else {
  console.log('validate.test.ts: all tests passed\n');
}
