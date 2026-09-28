/**
 * カートの状態と `stepKart()`(設計書 6節)。物理エンジンは使わず、自前の簡易なアーケード挙動。
 * DOM・three・乱数・時刻には触れない(設計書 2.2節)。
 */

import { clamp, lerp, wrapAngle } from './math.js';

/**
 * @typedef {object} KartState
 * @property {number} x
 * @property {number} z
 * @property {number} yaw
 * @property {number} speed          - スカラー(後退はマイナス)。速度の向きは常に yaw(グリップ走行)
 * @property {number} courseIndex    - project() のヒント
 * @property {number} s
 * @property {number} lateral
 * @property {'road'|'grass'|'wall'} surface
 * @property {number} spinT          - スピンの残り時間
 * @property {number} invulnT        - 被弾しない残り時間(スピン中 + 1.0秒)
 * @property {number} spinVisual     - 見た目の回転角(描画だけに使う)
 * @property {number} boostT
 * @property {number} boostBonus
 */

/**
 * `pose`({x, z, yaw})とコースから初期状態を作る(設計書 6.1節)。
 * @param {{x:number, z:number, yaw:number}} pose
 * @param {import('./course.js').Course} course
 * @returns {KartState}
 */
export function createKartState(pose, course) {
  const proj = course.project(pose.x, pose.z);
  return {
    x: pose.x,
    z: pose.z,
    yaw: pose.yaw,
    speed: 0,
    courseIndex: proj.index,
    s: proj.s,
    lateral: proj.lateral,
    surface: course.surfaceAt(proj.lateral),
    spinT: 0,
    invulnT: 0,
    spinVisual: 0,
    boostT: 0,
    boostBonus: 0,
  };
}

/** value を rate*dt だけ target に近づける(overshoot しない) */
function approach(value, target, rate, dt) {
  if (value < target) return Math.min(target, value + rate * dt);
  if (value > target) return Math.max(target, value - rate * dt);
  return value;
}

/**
 * 1ステップぶんカートを進める(設計書 6.2節)。
 * @param {KartState} k
 * @param {{throttle:number, steer:number}} input
 * @param {{course: import('./course.js').Course, rubberBonus?: number, maxSpeedMul?: number, others?: Array<{x:number,z:number}>}} env
 * @param {object} cfg
 * @param {number} dt
 * @returns {{wallHit: boolean, kartHit: boolean}}
 */
export function stepKart(k, input, env, cfg, dt) {
  const kartCfg = cfg.kart;
  const course = env.course;
  const rubberBonus = env.rubberBonus ?? 0;
  const maxSpeedMul = env.maxSpeedMul ?? 1;
  const others = env.others ?? [];

  // 1. タイマー
  k.spinT = Math.max(0, k.spinT - dt);
  k.invulnT = Math.max(0, k.invulnT - dt);
  k.boostT = Math.max(0, k.boostT - dt);
  if (k.boostT === 0) k.boostBonus = 0;

  // 2. スピン中は入力を無視する
  let throttle = input.throttle;
  let steer = input.steer;
  if (k.spinT > 0) {
    throttle = 0;
    steer = 0;
    k.speed *= Math.exp(-cfg.spin.decelRate * dt);
    k.spinVisual += ((Math.PI * 2 * cfg.spin.visualTurns) / cfg.spin.durationSec) * dt;
  } else {
    k.spinVisual = 0;
  }

  // 3. 最高速度と加速度
  let vmax = kartCfg.maxSpeed * maxSpeedMul * (1 + k.boostBonus + rubberBonus);
  if (k.surface === 'grass') vmax *= kartCfg.offroadMaxFactor;
  const accel = k.boostT > 0 ? kartCfg.accel * cfg.boost.accelMul : kartCfg.accel;

  // 4. 速度
  if (throttle > 0) {
    if (k.speed < 0) {
      k.speed = approach(k.speed, 0, kartCfg.brakeDecel, dt);
    } else if (k.speed < vmax) {
      // vmax 未満のときだけ加速する。すでに vmax 以上(直前まで芝でなかった等)なら、
      // ここでいきなり切り詰めず、下の overSpeedDecel の処理に任せる。
      k.speed = Math.min(vmax, k.speed + accel * throttle * dt);
    }
  } else if (throttle < 0) {
    if (k.speed > 0) {
      k.speed = approach(k.speed, 0, kartCfg.brakeDecel * Math.abs(throttle), dt);
    } else {
      k.speed = approach(k.speed, -kartCfg.reverseMaxSpeed, kartCfg.reverseAccel, dt);
    }
  } else {
    k.speed = approach(k.speed, 0, kartCfg.coastDecel, dt);
  }
  // vmax を超えているときは、いきなり切り詰めずに overSpeedDecel で近づける(芝に入った直後など)
  if (k.speed > vmax) {
    k.speed = approach(k.speed, vmax, kartCfg.overSpeedDecel, dt);
  }

  // 5. 旋回
  if (Math.abs(k.speed) > 0.5) {
    const rate =
      lerp(kartCfg.turnRateLow, kartCfg.turnRateHigh, clamp(Math.abs(k.speed) / kartCfg.maxSpeed, 0, 1)) *
      clamp(Math.abs(k.speed) / kartCfg.turnFullSpeed, 0, 1);
    const sign = k.speed >= 0 ? 1 : -1;
    k.yaw = wrapAngle(k.yaw - steer * rate * dt * sign);
  }

  // 6. 移動
  k.x += Math.sin(k.yaw) * k.speed * dt;
  k.z += Math.cos(k.yaw) * k.speed * dt;

  // 7. 投影
  const proj = course.project(k.x, k.z, k.courseIndex);
  k.s = proj.s;
  k.lateral = proj.lateral;
  k.courseIndex = proj.index;
  k.surface = course.surfaceAt(proj.lateral);

  let wallHit = false;
  let kartHit = false;

  // 8. 壁
  const wallLateral = course.wallLateral;
  const limit = wallLateral - kartCfg.radius;
  if (Math.abs(k.lateral) > limit) {
    wallHit = true;
    const sign = k.lateral >= 0 ? 1 : -1;
    const newLateral = sign * limit;
    const pos = course.toWorld(k.s, newLateral);
    k.x = pos.x;
    k.z = pos.z;
    k.lateral = newLateral;
    k.surface = course.surfaceAt(newLateral);

    // 速度ベクトルを接線・法線成分に分けて、法線成分だけ跳ね返す
    const vx = Math.sin(k.yaw) * k.speed;
    const vz = Math.cos(k.yaw) * k.speed;
    const tx = proj.tx;
    const tz = proj.tz;
    const nx = proj.tz; // 左方向 = 法線(lateral の向き)
    const nz = -proj.tx;
    const vt = vx * tx + vz * tz;
    const vn = vx * nx + vz * nz;
    const newVn = -vn * kartCfg.wallRestitution;
    const vpx = tx * vt + nx * newVn;
    const vpz = tz * vt + nz * newVn;
    const speedSign = k.speed >= 0 ? 1 : -1;
    const newSpeed = Math.sqrt(vpx * vpx + vpz * vpz) * kartCfg.wallSpeedKeep;
    // 後退中は向きが逆になる(forward(yaw) * speed = v になるように yaw を選ぶ)
    const dirX = speedSign * vpx;
    const dirZ = speedSign * vpz;
    if (Math.abs(dirX) > 1e-9 || Math.abs(dirZ) > 1e-9) {
      k.yaw = wrapAngle(Math.atan2(dirX, dirZ));
    }
    k.speed = speedSign * newSpeed;
  }

  // 9. カートどうし(重なりの半分だけ自分を押し離す。相手も同じ規則で動くので合わせてちょうど離れる)
  for (const other of others) {
    const dx = k.x - other.x;
    const dz = k.z - other.z;
    const d2 = dx * dx + dz * dz;
    const minDist = kartCfg.radius * 2;
    if (d2 < minDist * minDist && d2 > 1e-12) {
      const d = Math.sqrt(d2);
      const overlap = minDist - d;
      const push = overlap / 2;
      k.x += (dx / d) * push;
      k.z += (dz / d) * push;
      k.speed *= kartCfg.kartPushSpeedKeep;
      kartHit = true;
    }
  }

  return { wallHit, kartHit };
}

/**
 * スピンを与える(設計書 6.3節)。invulnT > 0 のあいだは何もしないで false を返す。
 * @param {KartState} k
 * @param {object} cfg
 * @returns {boolean}
 */
export function applySpin(k, cfg) {
  if (k.invulnT > 0) return false;
  k.spinT = cfg.spin.durationSec;
  k.invulnT = cfg.spin.durationSec + cfg.spin.invulnAfterSec;
  return true;
}

/**
 * ブーストを与える(設計書 6.3節)。重ねがけでは長い方の時間・大きい方の率になる。
 * @param {KartState} k
 * @param {number} durationSec
 * @param {number} bonus
 */
export function applyBoost(k, durationSec, bonus) {
  k.boostT = Math.max(k.boostT, durationSec);
  k.boostBonus = Math.max(k.boostBonus, bonus);
}
