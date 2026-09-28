import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp, lerp, wrapAngle, lerpAngle, forwardVec, leftVec, dist2 } from '../src/core/math.js';
import { RaceConfig, makeConfig } from '../src/config.js';

test('clamp は範囲に収める', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
});

test('lerp は線形補間', () => {
  assert.equal(lerp(0, 10, 0), 0);
  assert.equal(lerp(0, 10, 1), 10);
  assert.equal(lerp(0, 10, 0.5), 5);
  assert.equal(lerp(10, 20, -1), 0); // 外挿もそのまま計算する
});

test('wrapAngle は (-π, π] に収める', () => {
  const twoPi = Math.PI * 2;
  assert.ok(Math.abs(wrapAngle(0) - 0) < 1e-9);
  assert.ok(Math.abs(wrapAngle(Math.PI) - Math.PI) < 1e-9);
  assert.ok(wrapAngle(Math.PI + 0.001) <= Math.PI && wrapAngle(Math.PI + 0.001) > -Math.PI);
  assert.ok(Math.abs(wrapAngle(twoPi) - 0) < 1e-9);
  assert.ok(Math.abs(wrapAngle(-twoPi) - 0) < 1e-9);
  assert.ok(Math.abs(wrapAngle(3 * Math.PI) - Math.PI) < 1e-9);
  // -π ちょうどは含まれない(open at -π)。極僅かに超えても範囲内に収まること
  const wrapped = wrapAngle(-Math.PI - 0.0001);
  assert.ok(wrapped > -Math.PI && wrapped <= Math.PI);
});

test('lerpAngle は π をまたいでも近い向きに補間する', () => {
  // 3.0 rad と -3.0 rad は、2π を挟んだ方が近い(差は 2π - 6 ≈ 0.283)
  const a = 3.0;
  const b = -3.0;
  const mid = lerpAngle(a, b, 0.5);
  // 遠回り(0付近)ではなく、πをまたいだ側(±πの近く)に来るはず
  assert.ok(Math.abs(mid) > 2.5, `mid=${mid} は π 付近であるべき`);
});

test('forwardVec(0) = (0, 1)', () => {
  const f = forwardVec(0);
  assert.ok(Math.abs(f.x - 0) < 1e-9);
  assert.ok(Math.abs(f.z - 1) < 1e-9);
});

test('leftVec(0) = (1, 0)', () => {
  const l = leftVec(0);
  assert.ok(Math.abs(l.x - 1) < 1e-9);
  assert.ok(Math.abs(l.z - 0) < 1e-9);
});

test('forwardVec と leftVec は yaw=π/2 で直交し、左90度になる', () => {
  const yaw = Math.PI / 2;
  const f = forwardVec(yaw);
  const l = leftVec(yaw);
  const dot = f.x * l.x + f.z * l.z;
  assert.ok(Math.abs(dot) < 1e-9, `内積=${dot} は0であるべき(直交)`);
});

test('dist2 は距離の2乗を返す', () => {
  assert.equal(dist2(0, 0, 3, 4), 25);
  assert.equal(dist2(1, 1, 1, 1), 0);
});

test('makeConfig は overrides なしで RaceConfig と同じ値を返し、元は変えない', () => {
  const cfg = makeConfig();
  assert.deepEqual(cfg, RaceConfig);
  assert.notEqual(cfg, RaceConfig); // 参照は別(コピー)
});

test('makeConfig は overrides を深くマージし、RaceConfig 自体は変えない', () => {
  const before = JSON.parse(JSON.stringify(RaceConfig));
  const cfg = makeConfig({ laps: 5, kart: { maxSpeed: 40 } });

  assert.equal(cfg.laps, 5);
  assert.equal(cfg.kart.maxSpeed, 40);
  // マージしなかった値は元のまま引き継がれる
  assert.equal(cfg.kart.accel, RaceConfig.kart.accel);
  assert.equal(cfg.finishRule, RaceConfig.finishRule);

  // 元の RaceConfig は変わっていない
  assert.deepEqual(RaceConfig, before);
  assert.equal(RaceConfig.laps, 2);
  assert.equal(RaceConfig.kart.maxSpeed, 26);
});

test('makeConfig が返すコピーを書き換えても RaceConfig に影響しない', () => {
  const cfg = makeConfig();
  cfg.laps = 999;
  cfg.kart.maxSpeed = 1;
  cfg.colors.push(0x000000);
  assert.equal(RaceConfig.laps, 2);
  assert.equal(RaceConfig.kart.maxSpeed, 26);
  assert.equal(RaceConfig.colors.length, 8);
});
