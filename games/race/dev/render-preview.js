/**
 * 描画だけを確かめるページ(設計書 3節、実装プラン T7)。ゲームのロジック(RaceHost/RaceClient)は使わず、
 * `buildCourse` で作ったコースの上を自分のカートが中心線に沿って走り、ほかの7台をその後ろに並べて、
 * 毎フレーム `RenderView`(設計書 10.2節)を組み立てて `renderer.render()` に渡すだけのハーネス。
 * ブラウザ専用のファイルなので performance.now / requestAnimationFrame を直接使ってよい(設計書 2.2節)。
 */
import { buildCourse } from '../src/core/course.js';
import { COURSE_DATA } from '../src/core/courseData.js';
import { makeConfig } from '../src/config.js';
import { createRenderer } from '../src/render/renderer.js';

const cfg = makeConfig();
const course = buildCourse(COURSE_DATA, cfg);

const PLAYER_COUNT = 8;
const roster = [];
for (let slot = 0; slot < PLAYER_COUNT; slot++) {
  roster.push({
    slot,
    name: `プレイヤー${slot + 1}`,
    kind: slot === 0 ? 'human' : 'bot',
    local: true,
  });
}

const canvas = document.getElementById('game');
const renderer = createRenderer(canvas, course, cfg, roster);

// キー操作(設計書 実装プラン T7):1=スピン、2=ブースト、3=シールドの見た目を切り替える。C は押している間だけ後方視点。
const toggles = { spin: false, boost: false, shield: false };
let lookBack = false;
window.addEventListener('keydown', (ev) => {
  if (ev.repeat) return;
  if (ev.key === '1') toggles.spin = !toggles.spin;
  else if (ev.key === '2') toggles.boost = !toggles.boost;
  else if (ev.key === '3') toggles.shield = !toggles.shield;
  else if (ev.key === 'c' || ev.key === 'C') lookBack = true;
});
window.addEventListener('keyup', (ev) => {
  if (ev.key === 'c' || ev.key === 'C') lookBack = false;
});
window.addEventListener('blur', () => {
  lookBack = false;
});

/** s(コース座標)と lateral(横方向のずれ)からカート表示用の位置と向きを作る */
function poseAt(s, lateral) {
  const p = course.pointAt(s);
  const pos = course.toWorld(s, lateral);
  const yaw = Math.atan2(p.tx, p.tz);
  return { x: pos.x, z: pos.z, yaw };
}

const SELF_SPEED = 20; // m/s(元仕様の目安の速度で走らせる)
const SPIN_TURNS_PER_SEC = (Math.PI * 2 * cfg.spin.visualTurns) / cfg.spin.durationSec;

let baseS = 0;
let spinVisual = 0;
let lastT = performance.now();

/** 8台ぶんの RenderView を組み立てる */
function buildView(dt) {
  baseS += SELF_SPEED * dt;
  if (toggles.spin) spinVisual += SPIN_TURNS_PER_SEC * dt;
  else spinVisual = 0;

  const selfPose = poseAt(baseS, 0);
  const self = {
    slot: 0,
    x: selfPose.x,
    z: selfPose.z,
    yaw: selfPose.yaw,
    spinVisual,
    boosting: toggles.boost,
    shield: toggles.shield,
    speed: SELF_SPEED,
    color: cfg.colors[0],
  };

  // ほかの7台を自分の前後に並べる(前方にも置くことで、通常視点でも複数台が見えることを確かめる)。
  const others = [];
  const gaps = [12, 24, 36, -9, -18, -27, -36];
  for (let slot = 1; slot < PLAYER_COUNT; slot++) {
    const gap = gaps[slot - 1];
    const lateral = slot % 2 === 0 ? 3 : -3;
    const pose = poseAt(baseS + gap, lateral);
    others.push({
      slot,
      x: pose.x,
      z: pose.z,
      yaw: pose.yaw,
      spinVisual: 0,
      boosting: false,
      shield: false,
      finished: slot === PLAYER_COUNT - 1, // 1台はゴール済み(半透明)にする
      color: cfg.colors[slot],
      name: `プレイヤー${slot + 1}`,
    });
  }

  // ダミーの弾(Rocket・Homing・Oil)を並べる(設計書 実装プラン T7)
  const rocketPose = poseAt(baseS + 15, 0);
  const homingPose = poseAt(baseS + 25, -3);
  const oilPlacedPose = poseAt(baseS - 6, 2);
  const oilThrownPose = poseAt(baseS + 10, 5);
  const objects = [
    { id: 'demo-rocket', type: 'Rocket', x: rocketPose.x, z: rocketPose.z, yaw: rocketPose.yaw, active: true },
    { id: 'demo-homing', type: 'Homing', x: homingPose.x, z: homingPose.z, yaw: homingPose.yaw, active: true },
    { id: 'demo-oil-a', type: 'Oil', x: oilPlacedPose.x, z: oilPlacedPose.z, yaw: oilPlacedPose.yaw, active: true },
    // 投げている途中の油(active: false)。浮いて見えることを確かめる
    { id: 'demo-oil-b', type: 'Oil', x: oilThrownPose.x, z: oilThrownPose.z, yaw: oilThrownPose.yaw, active: false },
  ];

  // アイテムボックス:最初の2個だけ無効にして、表示が切り替わることを確かめる
  const boxes = course.itemBoxes.map((box) => box.id >= 2);

  return {
    phase: 'racing',
    countdown: null,
    lookBack,
    self,
    others,
    objects,
    boxes,
    hud: null, // このプレビューでは HUD は確かめない
  };
}

function frame(now) {
  const dt = Math.min(0.1, Math.max(0, (now - lastT) / 1000));
  lastT = now;
  renderer.resize();
  const view = buildView(dt);
  renderer.render(view, dt);
  requestAnimationFrame(frame);
}

requestAnimationFrame((now) => {
  lastT = now;
  requestAnimationFrame(frame);
});
