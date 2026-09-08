// leaderboard.ts の単体テスト。DynamoDB に依存しない純粋関数だけを対象にする
// （buildLeaderboardEntries / applyTieBreak / isValidPeriod / resolvePeriod / pickNextThreshold）。
// node:test ランナーは使わず、node:assert のみで検証する自前ランナー形式にする
//（既存の jst.test.ts / validate.test.ts / commands.test.ts と同じスタイル）。実行: `ts-node test/leaderboard.test.ts`

import assert from 'node:assert/strict';
import {
  applyTieBreak,
  buildLeaderboardEntries,
  isValidPeriod,
  pickNextThreshold,
  resolvePeriod,
} from '../src/lib/leaderboard';

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

console.log('leaderboard.test.ts');

// ── applyTieBreak ────────────────────────────────────────────────────
test('applyTieBreak: 同距離2件はrunsが少ないほうが上位になる', () => {
  const items = [
    { distanceM: 10000, runs: 5 },
    { distanceM: 10000, runs: 2 },
  ];
  const sorted = applyTieBreak(items);
  assert.equal(sorted[0].runs, 2);
  assert.equal(sorted[1].runs, 5);
});

test('applyTieBreak: 異なる距離は距離の降順を維持する', () => {
  const items = [
    { distanceM: 5000, runs: 1 },
    { distanceM: 20000, runs: 10 },
    { distanceM: 10000, runs: 3 },
  ];
  const sorted = applyTieBreak(items);
  assert.deepEqual(
    sorted.map((i) => i.distanceM),
    [20000, 10000, 5000],
  );
});

// ── buildLeaderboardEntries ──────────────────────────────────────────
test('buildLeaderboardEntries: runs===0 のアイテムは除外される', () => {
  const entries = buildLeaderboardEntries([
    { pk: 'U#1', distanceM: 10000, durationS: 3000, runs: 3, userName: 'A' },
    { pk: 'U#2', distanceM: 0, durationS: 0, runs: 0, userName: 'B' }, // 記録全削除の残骸
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].discordId, '1');
});

test('buildLeaderboardEntries: 同距離のtie-breakと順位付けが正しい', () => {
  const entries = buildLeaderboardEntries([
    { pk: 'U#a', distanceM: 10000, durationS: 3000, runs: 5, userName: 'A' },
    { pk: 'U#b', distanceM: 10000, durationS: 3000, runs: 2, userName: 'B' },
    { pk: 'U#c', distanceM: 20000, durationS: 6000, runs: 4, userName: 'C' },
  ]);
  assert.deepEqual(
    entries.map((e) => ({ rank: e.rank, discordId: e.discordId })),
    [
      { rank: 1, discordId: 'c' },
      { rank: 2, discordId: 'b' },
      { rank: 3, discordId: 'a' },
    ],
  );
  assert.equal(entries[0].distanceKm, 20);
});

// ── isValidPeriod ────────────────────────────────────────────────────
test('isValidPeriod: 2026-09（month）は妥当', () => {
  assert.equal(isValidPeriod('month', '2026-09'), true);
});

test('isValidPeriod: 2026-W37（week）は妥当', () => {
  assert.equal(isValidPeriod('week', '2026-W37'), true);
});

test('isValidPeriod: 2026-13（month）は不正（月が13）', () => {
  assert.equal(isValidPeriod('month', '2026-13'), false);
});

test('isValidPeriod: 2026-W54（week）は不正（週が54）', () => {
  assert.equal(isValidPeriod('week', '2026-W54'), false);
});

test('isValidPeriod: totalは常に妥当扱い', () => {
  assert.equal(isValidPeriod('total', 'anything'), true);
});

// ── resolvePeriod ────────────────────────────────────────────────────
test('resolvePeriod: scope=totalはperiodを無視してnullを返す', () => {
  const res = resolvePeriod('total', '2026-09');
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.period, null);
});

test('resolvePeriod: 省略時はJSTの当月を使う（month）', () => {
  const now = Date.UTC(2026, 8, 9, 3, 0, 0); // 2026-09-09T03:00:00Z -> JST 2026-09-09
  const res = resolvePeriod('month', undefined, now);
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.period, '2026-09');
});

test('resolvePeriod: 不正な形式は日本語エラーになる', () => {
  const res = resolvePeriod('month', '2026-13');
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.message, /YYYY-MM/);
});

// ── pickNextThreshold ────────────────────────────────────────────────
test('pickNextThreshold: 未達の最小閾値が選ばれる', () => {
  const thresholds = [
    { km: 30, roleName: '30km達成' },
    { km: 50, roleName: '50km達成' },
    { km: 100, roleName: '100km達成' },
  ];
  const res = pickNextThreshold(42500, thresholds); // 42.5km
  assert.deepEqual(res, { km: 50, remainingKm: 7.5, roleName: '50km達成' });
});

test('pickNextThreshold: 全達成済みならnull', () => {
  const thresholds = [{ km: 30, roleName: '30km達成' }];
  assert.equal(pickNextThreshold(50000, thresholds), null);
});

test('pickNextThreshold: 閾値が空配列ならnull', () => {
  assert.equal(pickNextThreshold(10000, []), null);
});

test('pickNextThreshold: thresholdsの順序に関わらず最小の未達閾値を選ぶ', () => {
  const thresholds = [
    { km: 100, roleName: '100km達成' },
    { km: 30, roleName: '30km達成' },
    { km: 50, roleName: '50km達成' },
  ];
  const res = pickNextThreshold(0, thresholds);
  assert.deepEqual(res, { km: 30, remainingKm: 30, roleName: '30km達成' });
});

if (failures > 0) {
  console.error(`\nleaderboard.test.ts: ${failures} failure(s)`);
  process.exit(1);
} else {
  console.log('leaderboard.test.ts: all tests passed\n');
}
