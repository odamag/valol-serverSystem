// jst.ts の単体テスト。
// node:test ランナーは ESM ローダー周りで壊れやすいため使わず、node:assert だけで検証する
// 自前ランナー形式にする（失敗したら process.exit(1)）。
// 実行: `ts-node test/jst.test.ts`（aws/tsconfig.json は module: commonjs）

import assert from 'node:assert/strict';
import { isValidRunDate, monthKey, todayJst, weekKey } from '../src/lib/jst';

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

console.log('jst.test.ts');

// ── todayJst ───────────────────────────────────────────────────────
// Date.UTC() で組み立てた「純粋な UTC エポックミリ秒」を入力にすることで、
// テスト実行マシンのローカルタイムゾーンに一切依存せず検証できる。
test('todayJst: UTC 14:59:59 は JST では同日の23:59:59', () => {
  const ms = Date.UTC(2026, 8, 9, 14, 59, 59); // 2026-09-09T14:59:59Z
  assert.equal(todayJst(ms), '2026-09-09');
});

test('todayJst: UTC 15:00:00 は JST では翌日の0:00:00（日付繰り上がり）', () => {
  const ms = Date.UTC(2026, 8, 9, 15, 0, 0); // 2026-09-09T15:00:00Z -> 2026-09-10T00:00:00+09:00
  assert.equal(todayJst(ms), '2026-09-10');
});

test('todayJst: 年をまたぐ繰り上がり（UTC大晦日15:00 -> JST元日0:00）', () => {
  const ms = Date.UTC(2025, 11, 31, 15, 0, 0);
  assert.equal(todayJst(ms), '2026-01-01');
});

test('todayJst: 年またぎ直前（UTC大晦日14:59:59 -> JSTでも大晦日）', () => {
  const ms = Date.UTC(2025, 11, 31, 14, 59, 59);
  assert.equal(todayJst(ms), '2025-12-31');
});

test('todayJst: うるう年2月末日をまたぐ', () => {
  const ms = Date.UTC(2024, 1, 29, 15, 0, 0); // 2024-02-29T15:00Z -> JST 2024-03-01
  assert.equal(todayJst(ms), '2024-03-01');
});

// ── monthKey ───────────────────────────────────────────────────────
test('monthKey: 通常の日付', () => {
  assert.equal(monthKey('2026-09-09'), '2026-09');
});

test('monthKey: 月末日', () => {
  assert.equal(monthKey('2026-01-31'), '2026-01');
});

test('monthKey: 別の年', () => {
  assert.equal(monthKey('1999-12-25'), '1999-12');
});

// ── weekKey（既知の正解） ─────────────────────────────────────────
test('weekKey: 2026-01-01（木）-> 2026-W01', () => {
  assert.equal(weekKey('2026-01-01'), '2026-W01');
});

test('weekKey: 2024-12-30（月）-> 2025-W01（年末だが翌年の第1週）', () => {
  assert.equal(weekKey('2024-12-30'), '2025-W01');
});

test('weekKey: 2021-01-01（金）-> 2020-W53（年始だが前年の第53週）', () => {
  assert.equal(weekKey('2021-01-01'), '2020-W53');
});

test('weekKey: 2026-09-28（月）〜2026-10-04（日）は同じ週キー', () => {
  const week = weekKey('2026-09-28');
  assert.equal(weekKey('2026-09-29'), week);
  assert.equal(weekKey('2026-09-30'), week);
  assert.equal(weekKey('2026-10-01'), week);
  assert.equal(weekKey('2026-10-02'), week);
  assert.equal(weekKey('2026-10-03'), week);
  assert.equal(weekKey('2026-10-04'), week);
});

test('weekKey: 2026-09-30 と 2026-10-01 は同じ週キーだが違う月キー（差分適用の重要ケース）', () => {
  assert.equal(weekKey('2026-09-30'), weekKey('2026-10-01'));
  assert.notEqual(monthKey('2026-09-30'), monthKey('2026-10-01'));
});

test('weekKey: 週の境界（日曜から月曜への切り替わり）', () => {
  // 2026-09-27（日）は前の週、2026-09-28（月）は次の週
  assert.notEqual(weekKey('2026-09-27'), weekKey('2026-09-28'));
});

test('weekKey: 2019-12-30（月）-> 2020-W01', () => {
  assert.equal(weekKey('2019-12-30'), '2020-W01');
});

test('weekKey: 2023-01-01（日）-> 2022-W52（年始だが前年の最終週）', () => {
  assert.equal(weekKey('2023-01-01'), '2022-W52');
});

test('weekKey: うるう年をまたぐ週（2024-02-29はうるう日）', () => {
  // 2024-02-29（木）は同じ週の月曜(2/26)〜日曜(3/3)と同じ週キーになる
  assert.equal(weekKey('2024-02-29'), weekKey('2024-02-26'));
  assert.equal(weekKey('2024-02-29'), weekKey('2024-03-03'));
});

// ── isValidRunDate ─────────────────────────────────────────────────
test('isValidRunDate: 通常の実在日付', () => {
  assert.equal(isValidRunDate('2026-09-09'), true);
});

test('isValidRunDate: 存在しない日付（2月30日）を弾く', () => {
  assert.equal(isValidRunDate('2026-02-30'), false);
});

test('isValidRunDate: 存在しない日付（4月31日）を弾く', () => {
  assert.equal(isValidRunDate('2026-04-31'), false);
});

test('isValidRunDate: うるう年の2/29は有効', () => {
  assert.equal(isValidRunDate('2024-02-29'), true);
});

test('isValidRunDate: 平年の2/29は無効（2026年はうるう年ではない）', () => {
  assert.equal(isValidRunDate('2026-02-29'), false);
});

test('isValidRunDate: 400で割り切れる年（2000年）の2/29は有効', () => {
  assert.equal(isValidRunDate('2000-02-29'), true);
});

test('isValidRunDate: 100で割り切れるが400で割り切れない年（1900年）の2/29は無効', () => {
  assert.equal(isValidRunDate('1900-02-29'), false);
});

test('isValidRunDate: 不正な月（13月）を弾く', () => {
  assert.equal(isValidRunDate('2026-13-01'), false);
});

test('isValidRunDate: 不正な月（0月）を弾く', () => {
  assert.equal(isValidRunDate('2026-00-10'), false);
});

test('isValidRunDate: フォーマット不正（ハイフンなし）を弾く', () => {
  assert.equal(isValidRunDate('20260909'), false);
});

test('isValidRunDate: フォーマット不正（ゼロ埋めなし）を弾く', () => {
  assert.equal(isValidRunDate('2026-9-9'), false);
});

test('isValidRunDate: 空文字を弾く', () => {
  assert.equal(isValidRunDate(''), false);
});

test('isValidRunDate: JSTの今日は有効', () => {
  assert.equal(isValidRunDate(todayJst()), true);
});

test('isValidRunDate: JSTの明日までは許容する', () => {
  const tomorrow = todayJst(Date.now() + 24 * 60 * 60 * 1000);
  assert.equal(isValidRunDate(tomorrow), true);
});

test('isValidRunDate: JSTの明後日は未来日すぎるため弾く', () => {
  const dayAfterTomorrow = todayJst(Date.now() + 2 * 24 * 60 * 60 * 1000);
  assert.equal(isValidRunDate(dayAfterTomorrow), false);
});

test('isValidRunDate: 過去の日付は許容する', () => {
  assert.equal(isValidRunDate('2000-01-01'), true);
});

if (failures > 0) {
  console.error(`\njst.test.ts: ${failures} failure(s)`);
  process.exit(1);
} else {
  console.log('jst.test.ts: all tests passed\n');
}
