import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ITEMS, tableFor, tableNameFor, rollItem } from '../src/core/items.js';
import { makeConfig } from '../src/config.js';
import { createRng } from '../../_shared/core/rng.js';

const cfg = makeConfig();

test('tableNameFor: rank 1 は常に leader', () => {
  assert.equal(tableNameFor(1, 0, cfg), 'leader');
  assert.equal(tableNameFor(1, 0.9, cfg), 'leader');
});

test('tableNameFor: gapRatio が farGapRatio ちょうどのときは far', () => {
  assert.equal(tableNameFor(2, cfg.items.farGapRatio, cfg), 'far');
});

test('tableNameFor: rank 2以上で gapRatio が小さいときは near', () => {
  assert.equal(tableNameFor(2, 0, cfg), 'near');
  assert.equal(tableNameFor(8, cfg.items.farGapRatio - 0.01, cfg), 'near');
});

test('tableFor はそのランク・差に対応する重みの表を返す', () => {
  assert.equal(tableFor(1, 0, cfg), cfg.items.tables.leader);
  assert.equal(tableFor(2, 0, cfg), cfg.items.tables.near);
  assert.equal(tableFor(2, cfg.items.farGapRatio, cfg), cfg.items.tables.far);
});

test('rollItem: force を渡すと必ずそれが返る(抽選しない)', () => {
  const rng = createRng(1);
  for (let i = 0; i < 50; i++) {
    assert.equal(rollItem({ rank: 1, gapRatio: 0, rng, cfg, force: 'Homing' }), 'Homing');
  }
});

test('rollItem: leader の表では Homing が出ない', () => {
  const rng = createRng(42);
  for (let i = 0; i < 20000; i++) {
    const item = rollItem({ rank: 1, gapRatio: 0, rng, cfg });
    assert.notEqual(item, 'Homing');
  }
});

test('rollItem: far の表では Oil が出ない', () => {
  const rng = createRng(43);
  for (let i = 0; i < 20000; i++) {
    const item = rollItem({ rank: 3, gapRatio: cfg.items.farGapRatio, rng, cfg });
    assert.notEqual(item, 'Oil');
  }
});

test('rollItem: 各表の割合が表の値 ±1.5 ポイント以内に収まる(20000回)', () => {
  const N = 20000;
  const cases = [
    { name: 'leader', rank: 1, gapRatio: 0 },
    { name: 'near', rank: 2, gapRatio: 0 },
    { name: 'far', rank: 2, gapRatio: cfg.items.farGapRatio },
  ];
  for (const { name, rank, gapRatio } of cases) {
    const table = cfg.items.tables[name];
    const rng = createRng(1000 + rank * 7 + Math.round(gapRatio * 100));
    const counts = Object.fromEntries(ITEMS.map((n) => [n, 0]));
    for (let i = 0; i < N; i++) {
      const item = rollItem({ rank, gapRatio, rng, cfg });
      counts[item]++;
    }
    for (const itemName of ITEMS) {
      const expectedPct = table[itemName];
      const actualPct = (counts[itemName] / N) * 100;
      assert.ok(
        Math.abs(actualPct - expectedPct) <= 1.5,
        `表=${name} アイテム=${itemName}: 期待${expectedPct}% 実際${actualPct.toFixed(2)}%`
      );
    }
  }
});
