import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCourse } from '../src/core/course.js';
import { COURSE_DATA } from '../src/core/courseData.js';
import { makeConfig } from '../src/config.js';
import { createKartState, stepKart, applySpin, applyBoost } from '../src/core/kart.js';

const cfg = makeConfig();
const course = buildCourse(COURSE_DATA, cfg);

/** s の位置でコースの接線に沿った yaw を返す(直進姿勢を作るときに使う) */
function tangentYaw(s) {
  const p = course.pointAt(s);
  return Math.atan2(p.tx, p.tz);
}

/** s, lateral から kart の初期状態を作る(接線向きの姿勢) */
function kartAt(s, lateral) {
  const yaw = tangentYaw(s);
  const world = course.toWorld(s, lateral);
  return createKartState({ x: world.x, z: world.z, yaw }, course);
}

const dt = cfg.fixedDt;

test('直線でアクセルを入れ続けると2秒以内に最高速度の90%に達し、最高速度を超えない', () => {
  const k = kartAt(20, 0);
  let maxSeen = 0;
  for (let t = 0; t < 2; t += dt) {
    stepKart(k, { throttle: 1, steer: 0 }, { course, others: [] }, cfg, dt);
    maxSeen = Math.max(maxSeen, k.speed);
    assert.ok(k.speed <= cfg.kart.maxSpeed + 1e-6, `speed=${k.speed} exceeds maxSpeed`);
  }
  assert.ok(k.speed >= cfg.kart.maxSpeed * 0.9, `speed=${k.speed} did not reach 90% of maxSpeed`);
});

test('芝では最高速度の50%(±0.5m/s)に落ち着く', () => {
  const k = kartAt(20, 12); // roadHalfWidth(9) < 12 < wallLateral(15) → grass
  assert.equal(k.surface, 'grass');
  for (let t = 0; t < 1.5; t += dt) {
    stepKart(k, { throttle: 1, steer: 0 }, { course, others: [] }, cfg, dt);
  }
  const expected = cfg.kart.maxSpeed * cfg.kart.offroadMaxFactor;
  assert.ok(Math.abs(k.speed - expected) <= 0.5, `speed=${k.speed} expected≈${expected}`);
});

test('steer=+1(右)で yaw が減り、進路の右側(lateral がマイナス側)へずれる', () => {
  const k = kartAt(20, 0);
  const yaw0 = k.yaw;
  for (let t = 0; t < 1; t += dt) {
    stepKart(k, { throttle: 1, steer: 1 }, { course, others: [] }, cfg, dt);
  }
  // wrapAngle があるので単純な引き算ではなく、右へ回った(時計回り)ことを lateral のずれで確かめる
  assert.ok(k.lateral < -0.5, `lateral=${k.lateral} should have shifted to the right (negative)`);
  assert.notEqual(k.yaw, yaw0);
});

test('壁に斜めに突っ込み続けても|lateral|がwallLateralを超えず、速度が0にならない', () => {
  const k = kartAt(20, 0);
  k.speed = 20; // 最初から速度を与えておく
  const limit = COURSE_DATA.wallLateral;
  for (let i = 0; i < 300; i++) {
    stepKart(k, { throttle: 1, steer: 1 }, { course, others: [] }, cfg, dt);
    assert.ok(Math.abs(k.lateral) <= limit + 1e-6, `step ${i}: lateral=${k.lateral} exceeds wallLateral`);
    assert.ok(Math.abs(k.speed) > 0.5, `step ${i}: speed=${k.speed} dropped to ~0`);
  }
});

test('スピン中は入力が効かず減速し、1.2秒後に元に戻る。スピン中と終了後1秒はapplySpinがfalseを返す', () => {
  const k = kartAt(20, 0);
  k.speed = 20;
  const yawBefore = k.yaw;

  assert.equal(applySpin(k, cfg), true);
  assert.equal(applySpin(k, cfg), false); // スピン中はもう一度当たっても false

  let elapsed = 0;
  while (elapsed < cfg.spin.durationSec) {
    stepKart(k, { throttle: 1, steer: 1 }, { course, others: [] }, cfg, dt);
    elapsed += dt;
  }
  assert.ok(k.spinT === 0, 'スピンは終わっているはず');
  assert.ok(k.speed < 20 * 0.1, `speed=${k.speed} should have decayed a lot`);
  assert.equal(k.yaw, yawBefore, 'スピン中は steer を無視するので yaw は変わらない');

  // 終了直後(invulnAfterSec 以内)はまだ無敵
  assert.equal(applySpin(k, cfg), false);

  let remaining = cfg.spin.invulnAfterSec + dt; // 浮動小数の誤差で1歩足りなくならないよう余裕を持たせる
  while (remaining > 0) {
    stepKart(k, { throttle: 0, steer: 0 }, { course, others: [] }, cfg, dt);
    remaining -= dt;
  }
  assert.equal(applySpin(k, cfg), true, '無敵が切れたら再びスピンできる');
});

test('ブーストで最高速度が+40%になり、時間が切れると戻る。重ねがけは長い方の時間・大きい方の率になる', () => {
  const k = kartAt(20, 0);
  k.speed = cfg.kart.maxSpeed; // すでに通常の最高速度にいる状態から始める

  applyBoost(k, cfg.boostPad.durationSec, cfg.boostPad.bonus); // durationSec=1.0, bonus=0.40
  assert.equal(k.boostT, cfg.boostPad.durationSec);
  assert.equal(k.boostBonus, cfg.boostPad.bonus);

  // 重ねがけ:短く弱いブーストを足しても変わらない
  applyBoost(k, 0.2, 0.1);
  assert.equal(k.boostT, cfg.boostPad.durationSec);
  assert.equal(k.boostBonus, cfg.boostPad.bonus);
  // 長く強いブーストを足すと更新される
  applyBoost(k, 5, 0.9);
  assert.equal(k.boostT, 5);
  assert.equal(k.boostBonus, 0.9);

  // 通常のブースト量(+40%)だけを見るテストをやり直す
  const k2 = kartAt(20, 0);
  k2.speed = cfg.kart.maxSpeed;
  applyBoost(k2, cfg.boostPad.durationSec, cfg.boostPad.bonus);
  const boostedMax = cfg.kart.maxSpeed * (1 + cfg.boostPad.bonus);
  let elapsed = 0;
  while (elapsed < cfg.boostPad.durationSec) {
    stepKart(k2, { throttle: 1, steer: 0 }, { course, others: [] }, cfg, dt);
    assert.ok(k2.speed <= boostedMax + 1e-6, `speed=${k2.speed} exceeds boosted max ${boostedMax}`);
    elapsed += dt;
  }
  assert.ok(k2.speed > cfg.kart.maxSpeed + 1, `speed=${k2.speed} should exceed normal maxSpeed while boosted`);

  // ブースト終了後、通常の最高速度まで戻る
  for (let t = 0; t < 2; t += dt) {
    stepKart(k2, { throttle: 1, steer: 0 }, { course, others: [] }, cfg, dt);
  }
  assert.ok(Math.abs(k2.speed - cfg.kart.maxSpeed) < 1, `speed=${k2.speed} should settle back to maxSpeed`);
});

test('3台を同じ場所に置いてothersを与えると互いに2*radius以上離れる', () => {
  const karts = [kartAt(20, -0.2), kartAt(20, 0), kartAt(20, 0.2)];
  for (let i = 0; i < 60; i++) {
    const positions = karts.map((k) => ({ x: k.x, z: k.z }));
    for (let idx = 0; idx < karts.length; idx++) {
      const others = positions.filter((_, j) => j !== idx);
      stepKart(karts[idx], { throttle: 0, steer: 0 }, { course, others }, cfg, dt);
    }
  }
  const minDist = cfg.kart.radius * 2;
  for (let i = 0; i < karts.length; i++) {
    for (let j = i + 1; j < karts.length; j++) {
      const dx = karts[i].x - karts[j].x;
      const dz = karts[i].z - karts[j].z;
      const d = Math.sqrt(dx * dx + dz * dz);
      assert.ok(d >= minDist - 1e-6, `karts ${i},${j} distance=${d} should be >= ${minDist}`);
    }
  }
});
