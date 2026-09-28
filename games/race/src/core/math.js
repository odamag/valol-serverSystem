/**
 * ゲームロジック全体で使う小さな数学関数。DOM・three・乱数には触れない(設計書 2.2節)。
 * 座標系は設計書 2.1節:XZ平面、Y上。yaw=0 で +Z を向く。
 */

/** value を [min, max] に収める */
export function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** a と b を t(0〜1想定だが外挿もそのまま計算する)で線形補間する */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** 角度(ラジアン)を (-π, π] に収める */
export function wrapAngle(angle) {
  let a = angle % (Math.PI * 2);
  if (a <= -Math.PI) a += Math.PI * 2;
  if (a > Math.PI) a -= Math.PI * 2;
  return a;
}

/** 角度 a から b への最短経路で線形補間する(π をまたいでも近い向きに回る) */
export function lerpAngle(a, b, t) {
  const diff = wrapAngle(b - a);
  return wrapAngle(a + diff * t);
}

/**
 * 前方ベクトル。yaw=0 のとき +Z を向く(設計書 2.1節)。
 * @returns {{x:number, z:number}}
 */
export function forwardVec(yaw) {
  return { x: Math.sin(yaw), z: Math.cos(yaw) };
}

/**
 * 左方向ベクトル。左がプラス(設計書 2.1節)。
 * @returns {{x:number, z:number}}
 */
export function leftVec(yaw) {
  return { x: Math.cos(yaw), z: -Math.sin(yaw) };
}

/**
 * XZ平面上の2点間の距離の2乗。sqrt を避けたい距離の比較(当たり判定など)に使う。
 * 実際の距離が欲しいときは `Math.sqrt(dist2(...))` を呼ぶ。
 */
export function dist2(x1, z1, x2, z2) {
  const dx = x2 - x1;
  const dz = z2 - z1;
  return dx * dx + dz * dz;
}
