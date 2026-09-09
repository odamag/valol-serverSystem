// roles.ts の単体テスト。Discord API / DynamoDB に依存しない純粋関数だけを対象にする
// （pickAchievedThreshold / hasAdminPermission）。
// node:test ランナーは使わず、node:assert のみで検証する自前ランナー形式にする
//（既存の jst.test.ts / validate.test.ts / commands.test.ts / leaderboard.test.ts と同じスタイル）。
// 実行: `ts-node test/roles.test.ts`

import assert from 'node:assert/strict';
import { hasAdminPermission, pickAchievedThreshold } from '../src/lib/roles';

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

console.log('roles.test.ts');

// ── pickAchievedThreshold ────────────────────────────────────────────
const THRESHOLDS = [
  { km: 30, roleId: 'role-30', roleName: '30km達成' },
  { km: 50, roleId: 'role-50', roleName: '50km達成' },
  { km: 100, roleId: 'role-100', roleName: '100km達成' },
];

test('pickAchievedThreshold: 達成済みのうち最大の閾値を選ぶ', () => {
  const res = pickAchievedThreshold(60_000, THRESHOLDS); // 60km
  assert.deepEqual(res, { km: 50, roleId: 'role-50', roleName: '50km達成' });
});

test('pickAchievedThreshold: 未達（最小閾値にも届かない）ならnull', () => {
  assert.equal(pickAchievedThreshold(10_000, THRESHOLDS), null); // 10km
});

test('pickAchievedThreshold: 空配列ならnull', () => {
  assert.equal(pickAchievedThreshold(100_000, []), null);
});

test('pickAchievedThreshold: ちょうど閾値ぴったりは達成扱い', () => {
  const res = pickAchievedThreshold(30_000, THRESHOLDS); // ちょうど30km
  assert.deepEqual(res, { km: 30, roleId: 'role-30', roleName: '30km達成' });
});

test('pickAchievedThreshold: 全閾値達成済みなら最大のものを選ぶ', () => {
  const res = pickAchievedThreshold(150_000, THRESHOLDS); // 150km
  assert.deepEqual(res, { km: 100, roleId: 'role-100', roleName: '100km達成' });
});

test('pickAchievedThreshold: thresholdsの順序に関わらず最大の達成済み閾値を選ぶ', () => {
  const shuffled = [THRESHOLDS[2], THRESHOLDS[0], THRESHOLDS[1]];
  const res = pickAchievedThreshold(60_000, shuffled);
  assert.deepEqual(res, { km: 50, roleId: 'role-50', roleName: '50km達成' });
});

// ── hasAdminPermission ───────────────────────────────────────────────
test('hasAdminPermission: "8"（ADMINISTRATORのみ）はtrue', () => {
  assert.equal(hasAdminPermission('8'), true);
});

test('hasAdminPermission: "0"（権限なし）はfalse', () => {
  assert.equal(hasAdminPermission('0'), false);
});

test('hasAdminPermission: ADMINISTRATORビットを含む大きな値はtrue', () => {
  // 例: 2147483647 (0x7FFFFFFF) は 0x8 ビットを含む大きな権限値
  assert.equal(hasAdminPermission('2147483647'), true);
});

test('hasAdminPermission: ADMINISTRATORビットを含まない大きな値はfalse', () => {
  // 0x8 ビットだけを除いた値（他のビットは立っている）
  const withoutAdmin = (BigInt('2147483647') & ~0x8n).toString();
  assert.equal(hasAdminPermission(withoutAdmin), false);
});

test('hasAdminPermission: undefinedはfalse', () => {
  assert.equal(hasAdminPermission(undefined), false);
});

test('hasAdminPermission: BigIntに変換できない値はfalse', () => {
  assert.equal(hasAdminPermission('not-a-number'), false);
});

// ── ロール変更が不要なケースの判定（want === have） ────────────────────
// syncThresholdRole 本体は DynamoDB/Discord API に依存するためここではテストしないが、
// その中核である「達成閾値の roleId と現在保持している roleId が一致すれば
// 何もしない」という判定ロジック自体は pickAchievedThreshold の結果だけで再現できる。
test('want===have相当: 既に達成済みロールを保持している場合は変更不要と判定できる', () => {
  const have = 'role-50';
  const achieved = pickAchievedThreshold(60_000, THRESHOLDS);
  const want = achieved?.roleId ?? null;
  assert.equal(want, have);
});

test('want===have相当: 閾値未達で保持ロールも無い場合は変更不要と判定できる', () => {
  const have: string | null = null;
  const achieved = pickAchievedThreshold(10_000, THRESHOLDS);
  const want = achieved?.roleId ?? null;
  assert.equal(want, have);
});

test('want!==have相当: 新たに閾値を達成した場合は変更が必要と判定できる', () => {
  const have: string | null = null;
  const achieved = pickAchievedThreshold(30_000, THRESHOLDS);
  const want = achieved?.roleId ?? null;
  assert.notEqual(want, have);
});

if (failures > 0) {
  console.error(`\nroles.test.ts: ${failures} failure(s)`);
  process.exit(1);
} else {
  console.log('roles.test.ts: all tests passed\n');
}
