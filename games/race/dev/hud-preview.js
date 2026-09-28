/**
 * HUD だけを確かめるページのハーネス(設計書 3節・13節、実装プラン T12)。RaceHost/RaceClient は使わず、
 * 毎フレーム偽の RenderView(設計書 10.2節)を組み立てて `hud.update()` に渡す。あわせて実際の
 * `createInput()` を動かし、`poll()` の結果を画面右下に出して、キーボード/マウス/ゲームパッドの
 * 動きを目で確かめられるようにする。ブラウザ専用なので performance.now / requestAnimationFrame を直接使う
 * (設計書 2.2節)。
 */
import { makeConfig } from '../src/config.js';
import { createHud } from '../src/ui/hud.js';
import { createInput } from '../src/game/input.js';
import { ITEMS } from '../src/core/items.js';

const cfg = makeConfig();
const PLAYER_COUNT = 8;

const hudRoot = document.getElementById('hud');
const hud = createHud(hudRoot);

// mousedown(左クリックで useItem)を拾うための対象。キャンバスがないので body を使う。
const input = createInput(document.body);

// ---- 偽のレース状態 ----
const names = Array.from({ length: PLAYER_COUNT }, (_, i) => `プレイヤー${i + 1}`);
// 全員ちがう速さで進ませて、順位表・進み具合のバーの並びが動くことを確かめる
const speeds = [0.052, 0.047, 0.055, 0.041, 0.058, 0.044, 0.05, 0.038];
const progress = speeds.map((_, i) => i * 0.03); // 少しずらしてスタート
const finishOrder = [];
const finishedSlots = new Set();
const leftSlots = new Set();

let wrongWay = false;
let boosting = false;
let spinning = false;
let graceActive = false;
let selfFinish = null; // { place, timeMs } | null

let heldItem = null; // string | null(ルーレット確定後のアイテム)
let rouletteUntil = 0; // performance.now() 基準。この時刻まではルーレット中

let countdownActive = false;
let countdownRemainingSec = 0;

let elapsedSec = 0;

function startRoulette() {
  heldItem = ITEMS[Math.floor(Math.random() * ITEMS.length)];
  rouletteUntil = performance.now() + cfg.itemBox.rouletteSec * 1000;
}

function toggleSelfFinish() {
  if (selfFinish) {
    selfFinish = null;
    finishedSlots.delete(0);
  } else {
    finishedSlots.add(0);
    finishOrder.push(0);
    selfFinish = { place: finishOrder.length, timeMs: elapsedSec * 1000 };
  }
}

function toggleLeftPlayer() {
  if (leftSlots.has(7)) leftSlots.delete(7);
  else leftSlots.add(7);
}

function startCountdown() {
  countdownActive = true;
  countdownRemainingSec = cfg.countdownSec;
}

window.addEventListener('keydown', (ev) => {
  if (ev.repeat) return;
  switch (ev.key) {
    case '1': wrongWay = !wrongWay; break;
    case '2': startRoulette(); break;
    case '3': boosting = !boosting; break;
    case '4': spinning = !spinning; break;
    case '5': toggleSelfFinish(); break;
    case '6': graceActive = !graceActive; break;
    case '7': startCountdown(); break;
    case '8': toggleLeftPlayer(); break;
  }
});

/** rank(1始まり)を各 slot について計算する。ゴール済み(着順順)→ 走っている人(進み具合順)→ DNF の順(設計書 7.2節と同じ考え方) */
function computeRanks() {
  const racing = [];
  for (let slot = 0; slot < PLAYER_COUNT; slot++) {
    if (finishedSlots.has(slot) || leftSlots.has(slot)) continue;
    racing.push(slot);
  }
  racing.sort((a, b) => progress[b] - progress[a] || a - b);

  const leftOrdered = [...leftSlots].sort((a, b) => a - b);

  const order = [...finishOrder, ...racing, ...leftOrdered];
  const rankBySlot = new Map();
  order.forEach((slot, i) => rankBySlot.set(slot, i + 1));
  return rankBySlot;
}

/** 偽の RenderView を1つ作る(設計書 10.2節) */
function buildView(dtSec) {
  const nowMs = performance.now();

  if (countdownActive) {
    countdownRemainingSec -= dtSec;
    if (countdownRemainingSec <= 0) countdownActive = false;
  } else {
    elapsedSec += dtSec;
    for (let slot = 0; slot < PLAYER_COUNT; slot++) {
      if (finishedSlots.has(slot) || leftSlots.has(slot)) continue;
      progress[slot] = Math.min(1, progress[slot] + speeds[slot] * dtSec);
      if (progress[slot] >= 1 && slot !== 0) {
        // 自分(slot 0)は「5」キーで明示的にゴールさせる(FINISH! の表示を確かめるため)。
        finishedSlots.add(slot);
        finishOrder.push(slot);
      } else if (progress[slot] >= 1 && slot === 0 && !selfFinish) {
        progress[slot] = 0.999; // 自分だけは 100% で足踏みさせて、5キーでの切り替えを試せるようにする
      }
    }
  }

  const rankBySlot = computeRanks();

  const standings = [];
  for (let slot = 0; slot < PLAYER_COUNT; slot++) {
    const left = leftSlots.has(slot);
    const finished = finishedSlots.has(slot);
    standings.push({
      slot,
      name: names[slot],
      color: cfg.colors[slot],
      rank: rankBySlot.get(slot) ?? null,
      status: left ? 'left' : finished ? 'finished' : 'racing',
      progress: progress[slot],
    });
  }

  const rouletteLeft = Math.max(0, rouletteUntil - nowMs);

  const laps = cfg.laps;
  const lap = Math.min(laps, Math.floor(progress[0] * laps) + 1);

  const hudView = {
    lap,
    laps,
    rank: rankBySlot.get(0) ?? null,
    playerCount: PLAYER_COUNT,
    item: rouletteLeft > 0 ? null : heldItem,
    rouletteLeft,
    speedKmh: countdownActive ? 0 : 60 + Math.sin(nowMs / 400) * 40,
    wrongWay,
    boostLeft: boosting ? 1 : 0,
    spinLeft: spinning ? 1 : 0,
    finish: selfFinish,
    timeLeftSec: Math.max(0, cfg.timeLimitSec - elapsedSec),
    graceLeftSec: graceActive ? Math.max(0, cfg.finishGraceSec - (elapsedSec % cfg.finishGraceSec)) : null,
    standings,
  };

  const inp = input.poll();

  const phase = countdownActive ? 'countdown' : selfFinish ? 'finished' : 'racing';

  return {
    view: {
      phase,
      countdown: countdownActive ? Math.max(0, Math.ceil(countdownRemainingSec)) : null,
      lookBack: inp.lookBack,
      self: {
        slot: 0,
        x: 0, z: 0, yaw: 0,
        spinVisual: 0,
        boosting,
        shield: false,
        speed: hudView.speedKmh / 3.6,
        color: cfg.colors[0],
      },
      others: [],
      objects: [],
      boxes: [],
      hud: hudView,
    },
    inp,
  };
}

const pollInfoEl = document.getElementById('pollInfo');
function renderPollInfo(inp) {
  pollInfoEl.textContent =
    `throttle: ${inp.throttle.toFixed(2)}\n` +
    `steer:    ${inp.steer.toFixed(2)}\n` +
    `useItem:  ${inp.useItem}\n` +
    `backward: ${inp.backward}\n` +
    `lookBack: ${inp.lookBack}`;
}

let lastT = performance.now();
function frame(now) {
  const dt = Math.min(0.1, Math.max(0, (now - lastT) / 1000));
  lastT = now;
  const { view, inp } = buildView(dt);
  hud.update(view);
  renderPollInfo(inp);
  requestAnimationFrame(frame);
}

requestAnimationFrame((now) => {
  lastT = now;
  requestAnimationFrame(frame);
});
