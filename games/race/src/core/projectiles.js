/**
 * 弾(Rocket / Homing)と油(Oil)の生成・移動・当たり判定(設計書 8.3〜8.5節)。
 * ホストだけが動かす。DOM・three・Date.now・Math.random には触れない(設計書 2.2節)。
 */

import { clamp, lerp, wrapAngle, forwardVec, dist2 } from './math.js';

/**
 * アイテムを使った瞬間の弾/油を作る(設計書 8.3・8.4節)。
 * - Rocket:前方(backward なら後方)に spawnOffset 離して作る。向きは yaw(backward なら yaw + π)。
 * - Homing:前方に作る。backward は無視する。targetSlot は呼び出し側(ホスト)が決めて渡す。
 * - Oil:既定では後方 dropOffset の位置に置いてすぐ有効。backward のときは前方へ投げる(throwSec かけて throwDistance 先へ)。
 * @param {'Rocket'|'Homing'|'Oil'} type
 * @param {number} owner 投げた人の slot
 * @param {{x:number, z:number, yaw:number}} pose 投げた人のカートの位置と向き
 * @param {{id:*, backward?:boolean, targetSlot?:number|null}} opts
 * @param {object} cfg makeConfig() が返す設定
 * @param {ReturnType<typeof import('./course.js').buildCourse>} course
 * @returns {object} Projectile(設計書 8.4節)
 */
export function createProjectile(type, owner, pose, opts, cfg, course) {
  const { id, backward = false, targetSlot = null } = opts || {};

  if (type === 'Rocket') {
    const icfg = cfg.items.rocket;
    // backward は「既定(前)と逆」なので、後ろ向きに撃つときは yaw を反転させるだけでよい
    const dirYaw = backward ? wrapAngle(pose.yaw + Math.PI) : pose.yaw;
    const dir = forwardVec(dirYaw);
    const x = pose.x + dir.x * icfg.spawnOffset;
    const z = pose.z + dir.z * icfg.spawnOffset;
    const proj = course.project(x, z);
    return {
      id,
      type,
      owner,
      x,
      z,
      yaw: dirYaw,
      age: 0,
      life: icfg.lifeSec,
      active: true,
      courseIndex: proj.index,
      s: proj.s,
    };
  }

  if (type === 'Homing') {
    const icfg = cfg.items.homing;
    const dir = forwardVec(pose.yaw);
    const x = pose.x + dir.x * icfg.spawnOffset;
    const z = pose.z + dir.z * icfg.spawnOffset;
    const proj = course.project(x, z);
    return {
      id,
      type,
      owner,
      x,
      z,
      yaw: pose.yaw,
      age: 0,
      life: icfg.lifeSec,
      active: true,
      courseIndex: proj.index,
      s: proj.s,
      targetSlot,
    };
  }

  if (type === 'Oil') {
    const icfg = cfg.items.oil;
    if (backward) {
      // 既定(後ろに置く)と逆なので前へ投げる。throwSec かけて throwDistance 先まで直線で動く
      const dir = forwardVec(pose.yaw);
      const startX = pose.x;
      const startZ = pose.z;
      const targetX = pose.x + dir.x * icfg.throwDistance;
      const targetZ = pose.z + dir.z * icfg.throwDistance;
      const proj = course.project(startX, startZ);
      return {
        id,
        type,
        owner,
        x: startX,
        z: startZ,
        yaw: pose.yaw,
        age: 0,
        life: icfg.lifeSec,
        active: false,
        courseIndex: proj.index,
        s: proj.s,
        throwFrom: { x: startX, z: startZ },
        throwTo: { x: targetX, z: targetZ },
      };
    }
    // 既定:すぐ後ろに置いて即有効
    const dir = forwardVec(pose.yaw);
    const x = pose.x - dir.x * icfg.dropOffset;
    const z = pose.z - dir.z * icfg.dropOffset;
    const proj = course.project(x, z);
    return {
      id,
      type,
      owner,
      x,
      z,
      yaw: pose.yaw,
      age: 0,
      life: icfg.lifeSec,
      active: true,
      courseIndex: proj.index,
      s: proj.s,
    };
  }

  throw new Error(`unknown projectile type: ${type}`);
}

/** Rocket:直進し、壁に触れたら 'wall'、寿命が来たら 'expired' */
function stepRocket(p, ctx, cfg, dt) {
  const icfg = cfg.items.rocket;
  const dir = forwardVec(p.yaw);
  p.x += dir.x * icfg.speed * dt;
  p.z += dir.z * icfg.speed * dt;

  const proj = ctx.course.project(p.x, p.z, p.courseIndex);
  p.s = proj.s;
  p.courseIndex = proj.index;

  if (ctx.course.surfaceAt(proj.lateral) === 'wall') return 'wall';
  if (p.age >= p.life) return 'expired';
  return 'alive';
}

/** Homing:毎ステップ目標点へ turnRate で向きを回してから進む。壁は無視する */
function stepHoming(p, ctx, cfg, dt) {
  const icfg = cfg.items.homing;

  let targetX;
  let targetZ;
  if (ctx.targetPos) {
    const d2 = dist2(p.x, p.z, ctx.targetPos.x, ctx.targetPos.z);
    if (d2 <= icfg.directRange * icfg.directRange) {
      targetX = ctx.targetPos.x;
      targetZ = ctx.targetPos.z;
    }
  }
  if (targetX === undefined) {
    // 目標がいない・遠いときはコースに沿って追いかける
    const pt = ctx.course.pointAt(p.s + icfg.guideAhead);
    targetX = pt.x;
    targetZ = pt.z;
  }

  const desiredYaw = Math.atan2(targetX - p.x, targetZ - p.z);
  const diff = wrapAngle(desiredYaw - p.yaw);
  const maxStep = icfg.turnRate * dt;
  p.yaw = wrapAngle(p.yaw + clamp(diff, -maxStep, maxStep));

  const dir = forwardVec(p.yaw);
  p.x += dir.x * icfg.speed * dt;
  p.z += dir.z * icfg.speed * dt;

  const proj = ctx.course.project(p.x, p.z, p.courseIndex);
  p.s = proj.s;
  p.courseIndex = proj.index;

  if (p.age >= p.life) return 'expired';
  return 'alive';
}

/** Oil:投げられている間は throwFrom→throwTo を throwSec かけて直線移動し、着地したら active になる */
function stepOil(p, ctx, cfg, dt) {
  if (p.throwFrom && !p.active) {
    const icfg = cfg.items.oil;
    const t = clamp(p.age / icfg.throwSec, 0, 1);
    p.x = lerp(p.throwFrom.x, p.throwTo.x, t);
    p.z = lerp(p.throwFrom.z, p.throwTo.z, t);
    if (t >= 1) p.active = true;

    const proj = ctx.course.project(p.x, p.z, p.courseIndex);
    p.s = proj.s;
    p.courseIndex = proj.index;
  }

  if (p.age >= p.life) return 'expired';
  return 'alive';
}

/**
 * 弾/油を dt だけ進める(設計書 8.4節)。ホストが fixedDt ごとにすべての弾に対して呼ぶ。
 * @param {object} p Projectile(createProjectile が返したもの。呼び出し側が state を書き換える)
 * @param {{course: ReturnType<typeof import('./course.js').buildCourse>, targetPos?: {x:number, z:number}}} ctx
 * @param {object} cfg
 * @param {number} dt
 * @returns {'alive'|'expired'|'wall'}
 */
export function stepProjectile(p, ctx, cfg, dt) {
  p.age += dt;
  if (p.type === 'Rocket') return stepRocket(p, ctx, cfg, dt);
  if (p.type === 'Homing') return stepHoming(p, ctx, cfg, dt);
  if (p.type === 'Oil') return stepOil(p, ctx, cfg, dt);
  throw new Error(`unknown projectile type: ${p.type}`);
}

/**
 * カート(kartX, kartZ)が弾/油に当たっているか(設計書 8.4・8.5節)。
 * `p.active` が false(Oil の投擲中など)のときは常に false。
 * @param {object} p Projectile
 * @param {number} kartX
 * @param {number} kartZ
 * @param {object} cfg
 * @returns {boolean}
 */
export function isHit(p, kartX, kartZ, cfg) {
  if (!p.active) return false;
  const itemKey = p.type.toLowerCase();
  const objRadius = cfg.items[itemKey].radius;
  const rSum = cfg.kart.radius + objRadius;
  return dist2(p.x, p.z, kartX, kartZ) < rSum * rSum;
}
