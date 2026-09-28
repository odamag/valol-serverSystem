/**
 * 相手プレイヤーのカートや弾・油の位置を、受け取ったスナップショットから補間する(設計書 9.5節)。
 * DOM・three・Date.now などは使わない(設計書 2.2節)。時刻はすべて引数で受け取る。
 */

import { lerp, lerpAngle, forwardVec } from '../core/math.js';

/**
 * スナップショットのリングバッファを作る。1台のカート、または1個のオブジェクトにつき1つ使う。
 * @param {{ maxLen?: number, extrapolateMaxMs: number }} opts
 */
export function createSnapshotBuffer({ maxLen = 30, extrapolateMaxMs }) {
  /** @type {Array<object>} ts の昇順で並ぶ */
  const buf = [];

  /**
   * スナップショットを1つ追加する。ts 順に入る前提。
   * 直近より古い(または同じ)ts は、順序が乱れて補間できないので捨てる。
   * @param {{ ts: number, x: number, z: number, yaw: number, [key: string]: any }} snap
   */
  function push(snap) {
    const last = buf[buf.length - 1];
    if (last && snap.ts <= last.ts) return; // 古い ts は捨てる
    buf.push(snap);
    if (buf.length > maxLen) buf.shift(); // 古い方から捨てて上限を守る
  }

  /** バッファを空にする */
  function clear() {
    buf.length = 0;
  }

  /** 最後に push したスナップショットをそのまま返す(補間しない)。ないなら null */
  function latest() {
    return buf.length > 0 ? buf[buf.length - 1] : null;
  }

  /**
   * `ts` を除く全フィールドについて、a から b への値を作る。
   * yaw は最短経路の角度補間、数値はそのまま線形補間、それ以外(boolean など)は
   * renderTs 以前で最新の値(= a、前側のスナップショット)を使う。
   * @param {object} a 前側(ts <= renderTs)
   * @param {object} b 後ろ側(ts >= renderTs)。省略すると a をそのまま複製する
   * @param {number} t 0〜1
   */
  function blend(a, b, t) {
    const out = {};
    const keys = new Set(Object.keys(a));
    if (b) for (const k of Object.keys(b)) keys.add(k);
    for (const key of keys) {
      if (key === 'ts') continue;
      const av = a[key];
      const bv = b ? b[key] : undefined;
      if (key === 'yaw' && typeof av === 'number' && typeof bv === 'number') {
        out.yaw = lerpAngle(av, bv, t);
      } else if (typeof av === 'number' && typeof bv === 'number') {
        out[key] = lerp(av, bv, t);
      } else {
        out[key] = av; // 数値でない、または後ろ側にない値は前側を使う
      }
    }
    return out;
  }

  /**
   * renderTs の時点の状態を補間して返す。
   * @param {number} renderTs `hostNow - interpDelayMs`
   * @returns {object | null}
   */
  function sample(renderTs) {
    if (buf.length === 0) return null;
    if (buf.length === 1) return blend(buf[0], null, 0);

    const first = buf[0];
    if (renderTs <= first.ts) return blend(first, null, 0);

    const last = buf[buf.length - 1];
    if (renderTs >= last.ts) {
      // 最新より先:speed があれば forwardVec(yaw) * speed で x, z だけ外挿する。
      // 上限(extrapolateMaxMs)を超えたら、それ以上は進めない。
      const elapsedMs = Math.min(renderTs - last.ts, extrapolateMaxMs);
      const out = blend(last, null, 0);
      if (typeof last.speed === 'number') {
        const dt = elapsedMs / 1000;
        const fwd = forwardVec(last.yaw);
        out.x = last.x + fwd.x * last.speed * dt;
        out.z = last.z + fwd.z * last.speed * dt;
      }
      return out;
    }

    // 前後のスナップショットを探して線形補間する。
    for (let i = 0; i < buf.length - 1; i++) {
      const a = buf[i];
      const b = buf[i + 1];
      if (renderTs >= a.ts && renderTs <= b.ts) {
        const span = b.ts - a.ts;
        const t = span > 0 ? (renderTs - a.ts) / span : 0;
        return blend(a, b, t);
      }
    }
    // 理論上ここには来ない(念のため最新を返す)
    return blend(last, null, 0);
  }

  return { push, sample, clear, latest };
}
