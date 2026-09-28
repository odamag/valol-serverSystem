/**
 * キーボード・マウス・ゲームパッドの入力(設計書 10.6節)。ブラウザ専用(DOM・navigator に触れる)。
 * `poll()` は `game.js` の `update()` から固定ステップを回す前に1回だけ呼ばれる想定(裏タブで render が
 * 止まっても、最後に押していた入力が残り続けないようにするため。詳しくは game.js 側のコメントを参照)。
 */
import { clamp } from '../core/math.js';

const GAMEPAD_DEADZONE = 0.15;
const GAMEPAD_BACKWARD_THRESHOLD = 0.5;

/**
 * @param {EventTarget & { addEventListener: Function }} target マウスクリックを拾う要素(canvas 想定)
 * @returns {{ poll(): { throttle:number, steer:number, useItem:boolean, backward:boolean, lookBack:boolean }, dispose(): void }}
 */
export function createInput(target) {
  // 押しっぱなしで見る必要があるキー。W/S/A/D と矢印キーは別のキーとして持ち、poll() のたびに OR で合成する
  // (例:S と ArrowDown を両方押してから片方だけ離しても、もう片方が押されている限り効き続けるように)。
  const keysHeld = {
    w: false, arrowUp: false,
    s: false, arrowDown: false,
    a: false, arrowLeft: false,
    d: false, arrowRight: false,
    c: false,
  };
  // useItem は「押した瞬間だけ true」。poll をまたいで取りこぼさないよう、次の poll() まで立てておく
  // (1フレームの間に何度も押されても、poll 1回につき1回の true として扱う)。
  let keyboardUseItemPending = false;
  let mouseUseItemPending = false;
  // Gamepad API はイベントを発火しないので、poll のたびに読み直して前回の状態と比べ、エッジを自分で作る。
  let prevGamepadUseItemHeld = false;

  function isTextEntryFocused() {
    const el = typeof document !== 'undefined' ? document.activeElement : null;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable === true;
  }

  /** フォーカスを失った・タブが裏に回ったときに、押しているキーをすべて離した扱いにする(設計書 10.6節)。 */
  function releaseAll() {
    keysHeld.w = false; keysHeld.arrowUp = false;
    keysHeld.s = false; keysHeld.arrowDown = false;
    keysHeld.a = false; keysHeld.arrowLeft = false;
    keysHeld.d = false; keysHeld.arrowRight = false;
    keysHeld.c = false;
    keyboardUseItemPending = false;
    mouseUseItemPending = false;
  }

  function onKeyDown(ev) {
    const key = ev.key;
    const isArrow = key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight';
    const isSpace = key === ' ' || key === 'Spacebar';
    // ロビーで名前を打てるように、input/textarea にフォーカスがあるときは既定動作を止めない。
    if ((isArrow || isSpace) && !isTextEntryFocused()) {
      ev.preventDefault();
    }
    switch (key) {
      case 'w': case 'W': keysHeld.w = true; break;
      case 'ArrowUp': keysHeld.arrowUp = true; break;
      case 's': case 'S': keysHeld.s = true; break;
      case 'ArrowDown': keysHeld.arrowDown = true; break;
      case 'a': case 'A': keysHeld.a = true; break;
      case 'ArrowLeft': keysHeld.arrowLeft = true; break;
      case 'd': case 'D': keysHeld.d = true; break;
      case 'ArrowRight': keysHeld.arrowRight = true; break;
      case 'c': case 'C': keysHeld.c = true; break;
      default:
        if (isSpace && !ev.repeat) keyboardUseItemPending = true;
    }
  }

  function onKeyUp(ev) {
    switch (ev.key) {
      case 'w': case 'W': keysHeld.w = false; break;
      case 'ArrowUp': keysHeld.arrowUp = false; break;
      case 's': case 'S': keysHeld.s = false; break;
      case 'ArrowDown': keysHeld.arrowDown = false; break;
      case 'a': case 'A': keysHeld.a = false; break;
      case 'ArrowLeft': keysHeld.arrowLeft = false; break;
      case 'd': case 'D': keysHeld.d = false; break;
      case 'ArrowRight': keysHeld.arrowRight = false; break;
      case 'c': case 'C': keysHeld.c = false; break;
    }
  }

  function onMouseDown(ev) {
    if (ev.button === 0) mouseUseItemPending = true;
  }

  function onBlur() {
    releaseAll();
  }

  function onVisibilityChange() {
    if (typeof document !== 'undefined' && document.hidden) releaseAll();
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }
  target.addEventListener('mousedown', onMouseDown);

  function readGamepad() {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    for (const gp of pads) {
      if (gp) return gp;
    }
    return null;
  }

  function poll() {
    const kbThrottle = (keysHeld.w || keysHeld.arrowUp ? 1 : 0) - (keysHeld.s || keysHeld.arrowDown ? 1 : 0);
    const kbSteer = (keysHeld.d || keysHeld.arrowRight ? 1 : 0) - (keysHeld.a || keysHeld.arrowLeft ? 1 : 0);
    // backward は「S を押している」だけを見る(設計書 10.6節の表どおり。ArrowDown では backward にしない)。
    const kbBackward = keysHeld.s;
    const kbLookBack = keysHeld.c;

    const gp = readGamepad();
    let gpThrottle = 0;
    let gpSteer = 0;
    let gpUseItemHeld = false;
    let gpBackward = false;
    let gpLookBack = false;
    if (gp) {
      const rt = gp.buttons[7] ? gp.buttons[7].value : 0;
      const lt = gp.buttons[6] ? gp.buttons[6].value : 0;
      gpThrottle = rt - lt;
      const axisX = gp.axes[0] || 0;
      gpSteer = Math.abs(axisX) > GAMEPAD_DEADZONE ? axisX : 0;
      gpUseItemHeld = !!(gp.buttons[0] && gp.buttons[0].pressed);
      gpLookBack = !!(gp.buttons[2] && gp.buttons[2].pressed);
      const axisY = gp.axes[1] || 0;
      gpBackward = axisY > GAMEPAD_BACKWARD_THRESHOLD;
    }
    // throttle/steer はキーボードとゲームパッドの「大きい方」を使う(設計書 10.6節)。
    const throttle = Math.abs(gpThrottle) > Math.abs(kbThrottle) ? gpThrottle : kbThrottle;
    const steer = Math.abs(gpSteer) > Math.abs(kbSteer) ? gpSteer : kbSteer;

    const gamepadUseItemEdge = gpUseItemHeld && !prevGamepadUseItemHeld;
    prevGamepadUseItemHeld = gpUseItemHeld;

    const useItem = keyboardUseItemPending || mouseUseItemPending || gamepadUseItemEdge;
    keyboardUseItemPending = false;
    mouseUseItemPending = false;

    return {
      throttle: clamp(throttle, -1, 1),
      steer: clamp(steer, -1, 1),
      useItem,
      backward: kbBackward || gpBackward,
      lookBack: kbLookBack || gpLookBack,
    };
  }

  function dispose() {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
    target.removeEventListener('mousedown', onMouseDown);
  }

  return { poll, dispose };
}
