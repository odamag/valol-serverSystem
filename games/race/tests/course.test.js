import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCourse } from '../src/core/course.js';
import { COURSE_DATA } from '../src/core/courseData.js';
import { makeConfig } from '../src/config.js';
import { leftVec } from '../src/core/math.js';

const cfg = makeConfig();
const course = buildCourse(COURSE_DATA, cfg);

test('course.length は 600〜800m', () => {
  assert.ok(course.length >= 600 && course.length <= 800, `length=${course.length}`);
});

test('project(pointAt(s)) は s が元の s と 0.5m 以内、lateral が 0 に近い(ゴールラインをまたぐ所も含む)', () => {
  const L = course.length;
  const samples = 200;
  for (let i = 0; i < samples; i++) {
    const s = (i / samples) * L;
    const p = course.pointAt(s);
    const proj = course.project(p.x, p.z);
    let diff = Math.abs(proj.s - s);
    diff = Math.min(diff, L - diff); // 周回をまたぐ場合
    assert.ok(diff <= 0.5, `s=${s} proj.s=${proj.s} diff=${diff}`);
    assert.ok(Math.abs(proj.lateral) < 0.5, `s=${s} lateral=${proj.lateral}`);
  }

  // ゴールラインをまたぐ付近(s=0 の直前・直後)
  for (const s of [0, 0.001, L - 0.001, L]) {
    const p = course.pointAt(s);
    const proj = course.project(p.x, p.z);
    let diff = Math.abs(proj.s - (s % L));
    diff = Math.min(diff, L - diff);
    assert.ok(diff <= 0.5, `s=${s} proj.s=${proj.s}`);
  }
});

test('toWorld(s, 5) を project すると lateral ≈ +5(左がプラス、leftVec と向きが合う)', () => {
  const s = 100;
  const world = course.toWorld(s, 5);
  const proj = course.project(world.x, world.z);
  assert.ok(Math.abs(proj.lateral - 5) < 0.5, `lateral=${proj.lateral}`);

  // leftVec との向きの一致:接線から yaw を求め、leftVec(yaw) が course の左方向と同じ符号になること
  const p = course.pointAt(s);
  const yaw = Math.atan2(p.tx, p.tz);
  const left = leftVec(yaw);
  // course の左方向は (tz, -tx)
  assert.ok(Math.abs(left.x - p.tz) < 1e-9 && Math.abs(left.z - -p.tx) < 1e-9);
});

test('チェックポイントが10個で、checkpoints[0].s === 0、等間隔', () => {
  assert.equal(course.checkpoints.length, 10);
  assert.equal(course.checkpoints[0].s, 0);
  const step = course.length / 10;
  for (let k = 0; k < 10; k++) {
    assert.ok(Math.abs(course.checkpoints[k].s - k * step) < 1e-6);
  }
});

test('gridPose(0..7) の8か所が互いに3m以上離れていて、すべて道路の上、sが0より大きくcp1より手前', () => {
  const poses = [];
  for (let i = 0; i < 8; i++) poses.push(course.gridPose(i));

  for (let i = 0; i < 8; i++) {
    for (let j = i + 1; j < 8; j++) {
      const dx = poses[i].x - poses[j].x;
      const dz = poses[i].z - poses[j].z;
      const d = Math.sqrt(dx * dx + dz * dz);
      assert.ok(d >= 3, `pose ${i},${j} distance=${d}`);
    }
  }

  const cp1s = course.checkpoints[1].s;
  for (let i = 0; i < 8; i++) {
    const proj = course.project(poses[i].x, poses[i].z);
    assert.equal(course.surfaceAt(proj.lateral), 'road', `grid ${i} surface`);
    assert.ok(proj.s > 0, `grid ${i} s=${proj.s} should be > 0`);
    assert.ok(proj.s < cp1s, `grid ${i} s=${proj.s} should be < cp1.s=${cp1s}`);
  }
});

test('中心線の曲率半径の最小値が壁の位置(15m)より大きい(カーブの内側で壁が折り返さない)', () => {
  const n = course.n;
  let minR = Infinity;
  for (let i = 0; i < n; i++) {
    const iPrev = (i - 1 + n) % n;
    const iNext = (i + 1) % n;
    const dx1 = course.xs[i] - course.xs[iPrev];
    const dz1 = course.zs[i] - course.zs[iPrev];
    const dx2 = course.xs[iNext] - course.xs[i];
    const dz2 = course.zs[iNext] - course.zs[i];
    const a1 = Math.atan2(dx1, dz1);
    const a2 = Math.atan2(dx2, dz2);
    let dth = a2 - a1;
    while (dth > Math.PI) dth -= Math.PI * 2;
    while (dth < -Math.PI) dth += Math.PI * 2;
    const ds = (Math.hypot(dx1, dz1) + Math.hypot(dx2, dz2)) / 2;
    if (ds < 1e-9) continue;
    const curvature = Math.abs(dth) / ds;
    if (curvature > 1e-9) {
      const r = 1 / curvature;
      if (r < minR) minR = r;
    }
  }
  assert.ok(minR > COURSE_DATA.wallLateral, `minR=${minR}`);
});

test('hintIndex つきの project を中心線に沿って1周ぶん続けて呼ぶと s が単調に進む(ゴールで一周する所を除く)', () => {
  const L = course.length;
  let hint = 0;
  let prevS = null;
  let wraps = 0;
  const steps = 500;
  for (let i = 0; i <= steps; i++) {
    // i === steps で s が L(= 0 に正規化)になり、ゴールラインをまたぐ
    const s = (i / steps) * L;
    const p = course.pointAt(s);
    const proj = course.project(p.x, p.z, hint);
    hint = proj.index;
    if (prevS !== null) {
      if (proj.s < prevS) {
        // ゴールラインをまたいだときだけ許される(s が大きく下がるとき)
        wraps++;
        assert.ok(prevS > L - 5 && proj.s < 5, `unexpected non-monotonic step at i=${i}: prevS=${prevS} s=${proj.s}`);
      } else {
        assert.ok(proj.s - prevS < L / 2, `jumped too far at i=${i}`);
      }
    }
    prevS = proj.s;
  }
  assert.equal(wraps, 1, `expected exactly one wrap, got ${wraps}`);
});

test('アイテムボックスが15個、id = row * 5 + col', () => {
  assert.equal(course.itemBoxes.length, 15);
  for (const box of course.itemBoxes) {
    const col = box.id % 5;
    const row = (box.id - col) / 5;
    assert.equal(box.row, row);
    assert.equal(box.id, row * 5 + col);
  }
});
