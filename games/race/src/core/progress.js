/**
 * チェックポイント・周回・逆走・順位(設計書 7節)。DOM・three・乱数・時刻には触れない(設計書 2.2節)。
 */

import { forwardVec } from './math.js';

/**
 * @typedef {object} Progress
 * @property {number} lap
 * @property {number} nextCp    - 1..N。N は「次はゴールライン(cp0)」を表す
 * @property {number} prevS
 * @property {number} wrongWayT
 * @property {boolean} wrongWay
 */

/**
 * オーナー側の周回管理の初期状態を作る(設計書 7.1節)。
 * @param {import('./course.js').Course} course
 * @param {number} startS
 * @returns {Progress}
 */
export function createProgress(course, startS) {
  return { lap: 0, nextCp: 1, prevS: startS, wrongWayT: 0, wrongWay: false };
}

/**
 * オーナー側で毎ステップ呼ぶ。チェックポイント・周回の通過を検出して `p` を進め、逆走の判定も更新する。
 * @param {Progress} p
 * @param {import('./kart.js').KartState} kart
 * @param {import('./course.js').Course} course
 * @param {object} cfg
 * @param {number} dt
 * @returns {Array<{lap:number, cp:number}>}
 */
export function updateProgress(p, kart, course, cfg, dt) {
  const N = course.checkpoints.length;
  const L = course.length;
  const s = kart.s;
  const prevS = p.prevS;
  const events = [];

  // 投影が飛んだとき(s - prevS の大きさが30mを超えるとき)は通過と見なさない(設計書 7.1節)
  if (p.nextCp < N && Math.abs(s - prevS) <= 30) {
    const k = p.nextCp;
    const sk = course.checkpoints[k].s;
    if (prevS < sk && sk <= s) {
      p.nextCp = k + 1;
      events.push({ lap: p.lap, cp: k });
    }
  } else if (p.nextCp === N) {
    // cp0(ゴールライン)は、ラインをまたいで s が一周したかどうかで判定する
    if (prevS > L - 30 && s < 30) {
      p.lap += 1;
      p.nextCp = 1;
      events.push({ lap: p.lap, cp: 0 });
    }
  }

  // 逆走判定:前方ベクトルと接線の内積が dotThreshold 未満、かつ speed > minSpeed の状態が holdSec 続いたら true
  const tangent = course.pointAt(kart.s);
  const fwd = forwardVec(kart.yaw);
  const dot = fwd.x * tangent.tx + fwd.z * tangent.tz;
  if (dot < cfg.wrongWay.dotThreshold && kart.speed > cfg.wrongWay.minSpeed) {
    p.wrongWayT += dt;
    if (p.wrongWayT >= cfg.wrongWay.holdSec) p.wrongWay = true;
  } else {
    p.wrongWayT = 0;
    p.wrongWay = false;
  }

  p.prevS = s;
  return events;
}

/**
 * ホスト側で、オーナーから報告されたチェックポイントの通過を検証して受け付ける(設計書 7.2節)。
 * @param {{lap:number, nextCp:number}} hostProg
 * @param {number} lap
 * @param {number} cp
 * @param {number} N
 * @returns {boolean}
 */
export function acceptCheckpoint(hostProg, lap, cp, N) {
  if (hostProg.nextCp === N) {
    // 次はゴールライン(cp0)。報告は新しい周回番号であること
    if (cp === 0 && lap === hostProg.lap + 1) {
      hostProg.lap = lap;
      hostProg.nextCp = 1;
      return true;
    }
    return false;
  }
  if (cp === hostProg.nextCp && lap === hostProg.lap) {
    hostProg.nextCp = cp + 1;
    return true;
  }
  return false;
}

/** nextCp が指す次のチェックポイントまでの、コース座標での距離(s' 基準) */
function distanceToNext(nextCp, s, L, N) {
  if (nextCp === N) return L - s;
  const sk = (nextCp * L) / N;
  return sk - s;
}

/**
 * `lap * L + s'` を返す(設計書 7.2節)。ゴールラインの手前・直後で連続になるように s' を選ぶ。
 * @param {number} lap
 * @param {number} nextCp
 * @param {number} s
 * @param {number} L
 * @param {number} N
 * @returns {number}
 */
export function raceDistance(lap, nextCp, s, L, N) {
  let sPrime = s;
  if (nextCp === 1 && s > L / 2) sPrime = s - L;
  else if (nextCp === N && s < L / 2) sPrime = s + L;
  return lap * L + sPrime;
}

/**
 * a が前なら正(設計書 7.2節)。(1) lap、(2) 通過したチェックポイント数、(3) 次のチェックポイントまでの距離、の順で比べる。
 * @param {{lap:number, nextCp:number, s:number}} a
 * @param {{lap:number, nextCp:number, s:number}} b
 * @param {number} L
 * @param {number} N
 * @returns {number}
 */
export function compareProgress(a, b, L, N) {
  if (a.lap !== b.lap) return a.lap - b.lap;
  const passedA = a.nextCp - 1;
  const passedB = b.nextCp - 1;
  if (passedA !== passedB) return passedA - passedB;
  const dA = distanceToNext(a.nextCp, a.s, L, N);
  const dB = distanceToNext(b.nextCp, b.s, L, N);
  return dB - dA;
}

/**
 * 順位順の slot の配列を返す(設計書 7.2節)。
 * (1) ゴールした人を finishedAt の早い順、(2) 走っている人を compareProgress の順、
 * (3) 抜けた人を最後(抜けた時点の進み具合の順)。完全に同じなら slot の小さい方を前。
 * @param {Array<{slot:number, lap:number, nextCp:number, s:number, finishedAt:number|null, left:boolean}>} entries
 * @param {number} L
 * @param {number} N
 * @returns {number[]}
 */
export function rankPlayers(entries, L, N) {
  const finished = entries.filter((e) => !e.left && e.finishedAt != null);
  const racing = entries.filter((e) => !e.left && e.finishedAt == null);
  const left = entries.filter((e) => e.left);

  finished.sort((a, b) => {
    if (a.finishedAt !== b.finishedAt) return a.finishedAt - b.finishedAt;
    return a.slot - b.slot;
  });

  const byProgress = (a, b) => {
    const c = compareProgress(b, a, L, N); // a が前なら負(先に来る)
    if (c !== 0) return c;
    return a.slot - b.slot;
  };
  racing.sort(byProgress);
  left.sort(byProgress);

  return [...finished, ...racing, ...left].map((e) => e.slot);
}
