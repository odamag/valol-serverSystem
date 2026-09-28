import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSnapshotBuffer } from '../src/game/interp.js';

test('2つのスナップショットの中間を正しく補間する', () => {
  const buf = createSnapshotBuffer({ extrapolateMaxMs: 200 });
  buf.push({ ts: 1000, x: 0, z: 0, yaw: 0, speed: 10, active: true });
  buf.push({ ts: 1100, x: 10, z: 20, yaw: 0, speed: 12, active: false });

  const s = buf.sample(1050);
  assert.ok(s);
  assert.equal(s.x, 5);
  assert.equal(s.z, 10);
  assert.equal(s.speed, 11);
  // 数値でないものは renderTs 以前で最新(= 前側)の値を使う
  assert.equal(s.active, true);
});

test('yaw が π をまたいでも近い向きに補間する', () => {
  const buf = createSnapshotBuffer({ extrapolateMaxMs: 200 });
  // 3.0 から -3.0 への最短経路は、π をまたいで進む向き
  buf.push({ ts: 0, x: 0, z: 0, yaw: 3.0, speed: 0 });
  buf.push({ ts: 100, x: 0, z: 0, yaw: -3.0, speed: 0 });

  const s = buf.sample(50);
  // 3.0 と -3.0 の最短経路の中間は ±π 付近(3.0 + 0.5*wrapAngle(-3.0-3.0))
  assert.ok(Math.abs(Math.abs(s.yaw) - Math.PI) < 0.05);
});

test('extrapolateMaxMs を超えて外挿しない', () => {
  const buf = createSnapshotBuffer({ extrapolateMaxMs: 200 });
  buf.push({ ts: 900, x: 0, z: -1, yaw: 0, speed: 10 });
  buf.push({ ts: 1000, x: 0, z: 0, yaw: 0, speed: 10 }); // yaw=0 → forward = (0,1)

  const within = buf.sample(1150); // 150ms 経過(上限内)
  assert.ok(Math.abs(within.z - 1.5) < 1e-9);

  const over = buf.sample(1500); // 500ms 経過だが上限 200ms で止まる
  assert.ok(Math.abs(over.z - 2.0) < 1e-9);

  const wayOver = buf.sample(10000); // さらに先でも同じ(上限で止まったまま)
  assert.ok(Math.abs(wayOver.z - 2.0) < 1e-9);
});

test('古い ts のスナップショットは捨てる', () => {
  const buf = createSnapshotBuffer({ extrapolateMaxMs: 200 });
  buf.push({ ts: 1000, x: 0, z: 0, yaw: 0, speed: 0 });
  buf.push({ ts: 900, x: 999, z: 999, yaw: 0, speed: 0 }); // 古いので捨てられる
  buf.push({ ts: 1000, x: 999, z: 999, yaw: 0, speed: 0 }); // 同じ ts も捨てられる(昇順でない)
  buf.push({ ts: 1100, x: 5, z: 5, yaw: 0, speed: 0 });

  assert.equal(buf.latest().ts, 1100);
  const s = buf.sample(1050);
  // 900/1000(重複)の不正なスナップショットは無視され、1000→1100 の間で補間される
  assert.ok(Math.abs(s.x - 2.5) < 1e-9);
});

test('スナップショットが1つしかないときはそれを返す', () => {
  const buf = createSnapshotBuffer({ extrapolateMaxMs: 200 });
  buf.push({ ts: 1000, x: 1, z: 2, yaw: 0.5, speed: 3, active: true });
  const s = buf.sample(5000);
  assert.equal(s.x, 1);
  assert.equal(s.z, 2);
  assert.equal(s.yaw, 0.5);
  assert.equal(s.active, true);
});

test('空なら null を返す', () => {
  const buf = createSnapshotBuffer({ extrapolateMaxMs: 200 });
  assert.equal(buf.sample(1000), null);
});

test('renderTs が最古より前なら最古のスナップショットを返す', () => {
  const buf = createSnapshotBuffer({ extrapolateMaxMs: 200 });
  buf.push({ ts: 1000, x: 1, z: 2, yaw: 0, speed: 0 });
  buf.push({ ts: 1100, x: 5, z: 5, yaw: 0, speed: 0 });
  const s = buf.sample(500);
  assert.equal(s.x, 1);
  assert.equal(s.z, 2);
});

test('speed のないスナップショットは外挿せずに止まる', () => {
  const buf = createSnapshotBuffer({ extrapolateMaxMs: 200 });
  buf.push({ ts: 1000, x: 3, z: 4, yaw: 0, active: true });
  const s = buf.sample(1150);
  assert.equal(s.x, 3);
  assert.equal(s.z, 4);
});

test('maxLen を超えたら古いものから捨てる', () => {
  const buf = createSnapshotBuffer({ maxLen: 3, extrapolateMaxMs: 200 });
  buf.push({ ts: 1000, x: 0, z: 0, yaw: 0, speed: 0 });
  buf.push({ ts: 1010, x: 1, z: 0, yaw: 0, speed: 0 });
  buf.push({ ts: 1020, x: 2, z: 0, yaw: 0, speed: 0 });
  buf.push({ ts: 1030, x: 3, z: 0, yaw: 0, speed: 0 });
  // 最初(ts=1000)は捨てられているはずなので、それより前を要求すると次に古い(1010)を返す
  const s = buf.sample(500);
  assert.equal(s.x, 1);
});

test('clear() でバッファが空になる', () => {
  const buf = createSnapshotBuffer({ extrapolateMaxMs: 200 });
  buf.push({ ts: 1000, x: 1, z: 2, yaw: 0, speed: 0 });
  buf.clear();
  assert.equal(buf.sample(1000), null);
  assert.equal(buf.latest(), null);
});
