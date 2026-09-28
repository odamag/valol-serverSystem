/**
 * HUD(設計書 13節)。キャンバスの上に重ねる HTML。`root`(= `ctx.dom.hudRoot`、`#hud`)の中に
 * 自分で DOM を作り、`update(view)` では前フレームと比べて変わった所だけ書き換える
 * (innerHTML を毎フレーム作り直さない。設計書 10.3節の `render()` から毎フレーム呼ばれるため)。
 * ブラウザ専用(DOM に触れる。設計書 2.2節)。
 */
import { clamp } from '../core/math.js';
import { ITEMS } from '../core/items.js';

const ROULETTE_INTERVAL_MS = 60; // ルーレット中、アイコンを切り替える間隔(設計書 13節)

/** アイテム名 → HUD に出す短い表示(アイコン用の画像は用意しないので絵文字で代用) */
const ITEM_LABEL = {
  Dash: '⚡ DASH',
  Rocket: '🚀 ROCKET',
  Homing: '🎯 HOMING',
  Oil: '🛢 OIL',
  Shield: '🛡 SHIELD',
};

/** rank(1始まり)→ "1st" / "2nd" / "3rd" / "4th"… */
function ordinal(n) {
  if (n == null) return '-';
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/** 秒 → "m:ss"(切り上げ。0未満にしない) */
function formatClock(sec) {
  const s = Math.max(0, Math.ceil(sec || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function colorToCss(color) {
  return `#${(color >>> 0).toString(16).padStart(6, '0')}`;
}

const MAX_PLAYERS = 8;

/**
 * @param {HTMLElement} root `ctx.dom.hudRoot`
 * @returns {{ update(view: object): void, dispose(): void }}
 */
export function createHud(root) {
  root.innerHTML = '';
  root.classList.add('hud-root');

  // ---- DOM は最初に1回だけ作る ----
  const topLeft = el('div', 'hud-topleft');
  const lapEl = el('div', 'hud-lap');
  const rankEl = el('div', 'hud-rank');
  const timeEl = el('div', 'hud-time');
  const graceEl = el('div', 'hud-grace');
  graceEl.hidden = true;
  topLeft.append(lapEl, rankEl, timeEl, graceEl);

  const standingsEl = el('div', 'hud-standings');
  const standingRows = [];
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const row = el('div', 'hud-standing-row');
    const rankSpan = el('span', 'hud-standing-rank');
    const colorSpan = el('span', 'hud-standing-color');
    const nameSpan = el('span', 'hud-standing-name');
    const statusSpan = el('span', 'hud-standing-status');
    row.append(rankSpan, colorSpan, nameSpan, statusSpan);
    row.hidden = true;
    standingsEl.appendChild(row);
    standingRows.push({ row, rankSpan, colorSpan, nameSpan, statusSpan, last: {} });
  }

  const itemBox = el('div', 'hud-itembox');
  const itemIcon = el('div', 'hud-item-icon');
  const itemReverse = el('div', 'hud-item-reverse');
  itemReverse.textContent = '↩'; // ↩
  itemReverse.hidden = true;
  itemBox.append(itemIcon, itemReverse);

  const bottom = el('div', 'hud-bottom');
  const speedEl = el('div', 'hud-speed');
  const progressBar = el('div', 'hud-progressbar');
  const progressTrack = el('div', 'hud-progresstrack');
  progressBar.appendChild(progressTrack);
  const progressMarkers = [];
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const marker = el('div', 'hud-progress-marker');
    marker.hidden = true;
    progressTrack.appendChild(marker);
    progressMarkers.push(marker);
  }
  bottom.append(speedEl, progressBar);

  const center = el('div', 'hud-center');
  const countdownEl = el('div', 'hud-countdown');
  countdownEl.hidden = true;
  const wrongWayEl = el('div', 'hud-wrongway');
  wrongWayEl.textContent = 'WRONG WAY';
  wrongWayEl.hidden = true;
  const effectEl = el('div', 'hud-effect');
  effectEl.hidden = true;
  const finishEl = el('div', 'hud-finish');
  finishEl.hidden = true;
  center.append(countdownEl, wrongWayEl, effectEl, finishEl);

  const rearViewEl = el('div', 'hud-rearview');
  rearViewEl.textContent = 'REAR VIEW';
  rearViewEl.hidden = true;

  root.append(topLeft, standingsEl, itemBox, bottom, center, rearViewEl);

  function el(tag, className) {
    const e = document.createElement(tag);
    e.className = className;
    return e;
  }

  // ---- 前フレームとの比較用のキャッシュ(値が同じなら DOM に触らない) ----
  const last = {};
  function setText(node, key, text) {
    if (last[key] !== text) {
      node.textContent = text;
      last[key] = text;
    }
  }
  function setHidden(node, key, hidden) {
    if (last[key] !== hidden) {
      node.hidden = hidden;
      last[key] = hidden;
    }
  }

  // ルーレット演出用の状態(hud.js はブラウザ専用なので performance.now を直接使ってよい。設計書 2.2節)
  let lastFrameMs = null;
  let rouletteAccumMs = 0;
  let rouletteIndex = 0;

  function update(view) {
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    const dt = lastFrameMs != null ? Math.max(0, now - lastFrameMs) : 0;
    lastFrameMs = now;

    const phase = view ? view.phase : 'countdown';
    const hud = view ? view.hud : null;
    const lookBack = !!(view && view.lookBack);
    const selfSlot = view && view.self ? view.self.slot : null;

    // 左上:LAP、順位、残り時間、grace の残り秒数
    if (hud) {
      setText(lapEl, 'lap', `LAP ${hud.lap}/${hud.laps}`);
      setText(rankEl, 'rank', `${ordinal(hud.rank)} / ${hud.playerCount}`);
      setText(timeEl, 'time', `残り ${formatClock(hud.timeLeftSec)}`);
      const hasGrace = hud.graceLeftSec != null;
      setHidden(graceEl, 'graceHidden', !hasGrace);
      if (hasGrace) setText(graceEl, 'grace', `あと ${Math.ceil(hud.graceLeftSec)} 秒で終了`);
    }

    // 順位表(rank の昇順。rank が未確定の人は末尾)
    if (hud) {
      const sorted = hud.standings.slice().sort((a, b) => {
        const ra = a.rank == null ? Infinity : a.rank;
        const rb = b.rank == null ? Infinity : b.rank;
        if (ra !== rb) return ra - rb;
        return a.slot - b.slot;
      });
      for (let i = 0; i < standingRows.length; i++) {
        const refs = standingRows[i];
        const entry = sorted[i];
        if (!entry) {
          if (refs.last.hidden !== true) { refs.row.hidden = true; refs.last.hidden = true; }
          continue;
        }
        if (refs.last.hidden !== false) { refs.row.hidden = false; refs.last.hidden = false; }
        const rankText = ordinal(entry.rank);
        if (refs.last.rank !== rankText) { refs.rankSpan.textContent = rankText; refs.last.rank = rankText; }
        const colorCss = colorToCss(entry.color);
        if (refs.last.color !== colorCss) { refs.colorSpan.style.background = colorCss; refs.last.color = colorCss; }
        if (refs.last.name !== entry.name) { refs.nameSpan.textContent = entry.name; refs.last.name = entry.name; }
        const statusText = entry.status === 'finished' ? '✓' : entry.status === 'left' ? 'DNF' : '';
        if (refs.last.status !== statusText) { refs.statusSpan.textContent = statusText; refs.last.status = statusText; }
        const isSelf = entry.slot === selfSlot;
        if (refs.last.self !== isSelf) { refs.row.classList.toggle('hud-standing-self', isSelf); refs.last.self = isSelf; }
      }
    }

    // 右上:アイテムの枠(ルーレット中は60msごとにアイコンを切り替える)。後ろを見ている間は「↩」を添える
    if (hud) {
      const rouletteActive = hud.rouletteLeft > 0;
      if (rouletteActive) {
        rouletteAccumMs += dt;
        if (last.rouletteActive !== true || rouletteAccumMs >= ROULETTE_INTERVAL_MS) {
          rouletteAccumMs = 0;
          rouletteIndex = (rouletteIndex + 1) % ITEMS.length;
          setText(itemIcon, 'itemIcon', ITEM_LABEL[ITEMS[rouletteIndex]]);
        }
        if (last.rouletteActive !== true) itemBox.classList.add('hud-itembox-rolling');
      } else {
        rouletteAccumMs = 0;
        if (last.rouletteActive !== false) itemBox.classList.remove('hud-itembox-rolling');
        setText(itemIcon, 'itemIcon', hud.item ? ITEM_LABEL[hud.item] : '');
      }
      last.rouletteActive = rouletteActive;
      setHidden(itemBox, 'itemBoxHidden', !hud.item && !rouletteActive);
      setHidden(itemReverse, 'itemReverseHidden', !lookBack);
    }

    // 下:速度、進み具合のバー(全員のマーカー。自分を大きく)
    if (hud) {
      setText(speedEl, 'speed', `${Math.round(hud.speedKmh)} km/h`);
      for (let i = 0; i < progressMarkers.length; i++) {
        const marker = progressMarkers[i];
        const entry = hud.standings[i];
        if (!entry) {
          if (!marker.hidden) marker.hidden = true;
          continue;
        }
        if (marker.hidden) marker.hidden = false;
        marker.style.left = `${clamp(entry.progress, 0, 1) * 100}%`;
        marker.style.background = colorToCss(entry.color);
        marker.classList.toggle('hud-progress-marker-self', entry.slot === selfSlot);
      }
    }

    // 中央:カウントダウン、WRONG WAY、BOOST!/SPIN!、FINISH!
    const showCountdown = phase === 'countdown' && view && view.countdown != null;
    setHidden(countdownEl, 'countdownHidden', !showCountdown);
    if (showCountdown) {
      setText(countdownEl, 'countdown', view.countdown > 0 ? String(view.countdown) : 'GO!');
    }

    if (hud) {
      const showWrongWay = !!hud.wrongWay && phase === 'racing';
      setHidden(wrongWayEl, 'wrongWayHidden', !showWrongWay);
      wrongWayEl.classList.toggle('hud-blink', showWrongWay);

      let effectText = '';
      if (hud.spinLeft > 0) effectText = 'SPIN!';
      else if (hud.boostLeft > 0) effectText = 'BOOST!';
      setHidden(effectEl, 'effectHidden', !effectText);
      if (effectText) setText(effectEl, 'effect', effectText);

      const finishText = hud.finish ? `FINISH! ${ordinal(hud.finish.place)}` : '';
      setHidden(finishEl, 'finishHidden', !finishText);
      if (finishText) setText(finishEl, 'finish', finishText);
    }

    // 上中央:後ろを見ている間だけ REAR VIEW
    setHidden(rearViewEl, 'rearHidden', !lookBack);
  }

  function dispose() {
    root.innerHTML = '';
  }

  return { update, dispose };
}
