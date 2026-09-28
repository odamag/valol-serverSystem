import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProjectile, stepProjectile, isHit } from '../src/core/projectiles.js';
import { buildCourse } from '../src/core/course.js';
import { COURSE_DATA } from '../src/core/courseData.js';
import { makeConfig } from '../src/config.js';

const cfg = makeConfig();
const course = buildCourse(COURSE_DATA, cfg);

/** コース上の s=0 の点で、中心線に沿った yaw(pointAt の接線から)を求める */
function centerlinePose(s, lateral = 0) {
  const p = course.pointAt(s);
  const yaw = Math.atan2(p.tx, p.tz);
  const world = course.toWorld(s, lateral);
  return { x: world.x, z: world.z, yaw };
}

// COURSE_DATA の中心線はどこもカーブしていて(このコースの区間には45秒/50mの角度変化のような
// 急カーブが多く、真っすぐな長い区間がない)、寿命(3秒・135m)ぶん直進させると必ず壁に当たってしまう。
// 「壁に当たらなければ寿命で消える」ことだけを確かめたいので、この1件だけ直線のコースで検証する。
function makeStraightCourse(length) {
  return {
    length,
    pointAt(s) {
      return { x: 0, z: s, tx: 0, tz: 1 };
    },
    toWorld(s, lateral) {
      return { x: lateral, z: s };
    },
    project(x, z) {
      return { s: z, lateral: x, index: 0, tx: 0, tz: 1 };
    },
    surfaceAt(lateral) {
      const a = Math.abs(lateral);
      if (a <= 9) return 'road';
      if (a < 15) return 'grass';
      return 'wall';
    },
  };
}

test('Rocket は直線で進み、寿命(3秒)で expired になる', () => {
  const straightCourse = makeStraightCourse(100000);
  const pose = { x: 0, z: 0, yaw: 0 };
  const p = createProjectile('Rocket', 0, pose, { id: 1 }, cfg, straightCourse);
  assert.equal(p.type, 'Rocket');
  assert.equal(p.active, true);

  let result = 'alive';
  const dt = cfg.fixedDt;
  let steps = 0;
  const maxSteps = Math.ceil(cfg.items.rocket.lifeSec / dt) + 5;
  while (result === 'alive' && steps < maxSteps) {
    result = stepProjectile(p, { course: straightCourse }, cfg, dt);
    steps++;
  }
  assert.equal(result, 'expired');
  const elapsed = steps * dt;
  assert.ok(Math.abs(elapsed - cfg.items.rocket.lifeSec) < 0.05, `elapsed=${elapsed}`);
});

test('Rocket は壁(|lateral| >= wallLateral)に届くと wall になる', () => {
  // s=0 で真横(lateral 方向)を向かせて、道路の外へまっすぐ飛ばす
  const p0 = course.pointAt(0);
  const leftYaw = Math.atan2(p0.tz, -p0.tx); // leftVec 方向を向く yaw(forwardVec(yaw) = leftVec(0) となるように)
  const pose = { x: p0.x, z: p0.z, yaw: leftYaw };
  const p = createProjectile('Rocket', 0, pose, { id: 2 }, cfg, course);

  let result = 'alive';
  const dt = cfg.fixedDt;
  let steps = 0;
  const maxSteps = Math.ceil(cfg.items.rocket.lifeSec / dt) + 5;
  while (result === 'alive' && steps < maxSteps) {
    result = stepProjectile(p, { course }, cfg, dt);
    steps++;
  }
  assert.equal(result, 'wall');
});

test('Rocket を backward で撃つと逆向きに進む', () => {
  const pose = centerlinePose(100);
  const forward = createProjectile('Rocket', 0, pose, { id: 3, backward: false }, cfg, course);
  const backward = createProjectile('Rocket', 0, pose, { id: 4, backward: true }, cfg, course);

  // 向き(yaw)が反転していること
  const diff = Math.abs(forward.yaw - backward.yaw);
  const normDiff = Math.min(diff, Math.abs(diff - Math.PI * 2));
  assert.ok(Math.abs(normDiff - Math.PI) < 1e-9, `diff=${normDiff}`);

  const dt = cfg.fixedDt;
  const beforeS = backward.s;
  stepProjectile(backward, { course }, cfg, dt);
  // s が (0付近から)減る方向、つまり後ろ向きに動いたことを弧長で確かめる
  let ds = backward.s - beforeS;
  if (ds > course.length / 2) ds -= course.length;
  if (ds < -course.length / 2) ds += course.length;
  assert.ok(ds < 0, `ds=${ds}`);
});

test('Homing は 30m 以上先の目標をコースに沿って追いかけ、8秒以内に isHit になる', () => {
  const pose = centerlinePose(0);
  const p = createProjectile('Homing', 0, pose, { id: 5, targetSlot: 1 }, cfg, course);

  // 目標は中心線上を s=40 から 20m/s で走る(30m 以上先からスタート)
  let targetS = 40;
  const targetSpeed = 20;
  const dt = cfg.fixedDt;

  let result = 'alive';
  let hit = false;
  const maxSteps = Math.ceil(cfg.items.homing.lifeSec / dt) + 5;
  for (let i = 0; i < maxSteps && result === 'alive'; i++) {
    targetS += targetSpeed * dt;
    const targetPos = course.pointAt(targetS);
    result = stepProjectile(p, { course, targetPos }, cfg, dt);
    if (isHit(p, targetPos.x, targetPos.z, cfg)) {
      hit = true;
      break;
    }
  }
  assert.equal(hit, true, `result=${result}`);
});

test('Homing は目標なしのときコースに沿って飛び、8秒で消える', () => {
  const pose = centerlinePose(200);
  const p = createProjectile('Homing', 0, pose, { id: 6, targetSlot: null }, cfg, course);

  const dt = cfg.fixedDt;
  let result = 'alive';
  let steps = 0;
  const maxSteps = Math.ceil(cfg.items.homing.lifeSec / dt) + 5;
  while (result === 'alive' && steps < maxSteps) {
    result = stepProjectile(p, { course }, cfg, dt);
    steps++;
  }
  assert.equal(result, 'expired');
  const elapsed = steps * dt;
  assert.ok(Math.abs(elapsed - cfg.items.homing.lifeSec) < 0.05, `elapsed=${elapsed}`);

  // 壁は無視するはずなので、コース沿いに飛んでいれば lateral は小さいままのはず
  const proj = course.project(p.x, p.z);
  assert.ok(Math.abs(proj.lateral) < 5, `lateral=${proj.lateral}`);
});

test('Oil を前に投げると throwSec の間 active=false、throwDistance 先で止まって有効になり、15秒で消える', () => {
  const pose = centerlinePose(0);
  const p = createProjectile('Oil', 0, pose, { id: 7, backward: true }, cfg, course);
  assert.equal(p.active, false);

  const dt = cfg.fixedDt;
  const icfg = cfg.items.oil;

  // throwSec の直前まで active=false のまま
  let steps = 0;
  const throwSteps = Math.floor(icfg.throwSec / dt);
  for (let i = 0; i < throwSteps - 1; i++) {
    stepProjectile(p, { course }, cfg, dt);
    assert.equal(p.active, false);
    steps++;
  }

  // 着地するまで進める
  let result = 'alive';
  while (p.active === false && result === 'alive') {
    result = stepProjectile(p, { course }, cfg, dt);
    steps++;
  }
  assert.equal(p.active, true);

  // throwDistance 先で止まっていること
  const dx = p.x - pose.x;
  const dz = p.z - pose.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  assert.ok(Math.abs(dist - icfg.throwDistance) < 0.5, `dist=${dist}`);

  // 残りの寿命ぶん進めて expired になることを確かめる
  while (result === 'alive') {
    result = stepProjectile(p, { course }, cfg, dt);
    steps++;
  }
  assert.equal(result, 'expired');
  const elapsed = steps * dt;
  assert.ok(Math.abs(elapsed - icfg.lifeSec) < 0.05, `elapsed=${elapsed}`);
});

test('Oil を既定(後ろに置く)で使うとすぐ active=true になる', () => {
  const pose = centerlinePose(50);
  const p = createProjectile('Oil', 0, pose, { id: 8 }, cfg, course);
  assert.equal(p.active, true);
  const icfg = cfg.items.oil;
  const dx = p.x - pose.x;
  const dz = p.z - pose.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  assert.ok(Math.abs(dist - icfg.dropOffset) < 0.5, `dist=${dist}`);
});

test('isHit は active な弾と kart.radius + 弾の radius 未満の距離で true になる', () => {
  const pose = centerlinePose(0);
  const p = createProjectile('Rocket', 0, pose, { id: 9 }, cfg, course);
  const rSum = cfg.kart.radius + cfg.items.rocket.radius;
  assert.equal(isHit(p, p.x, p.z, cfg), true);
  assert.equal(isHit(p, p.x + rSum + 1, p.z, cfg), false);

  // active=false のときは常に false
  const oil = createProjectile('Oil', 0, pose, { id: 10, backward: true }, cfg, course);
  assert.equal(isHit(oil, oil.x, oil.z, cfg), false);
});
