/**
 * ボット(と検証用の自動運転)の入力(設計書 10.5節)。
 * DOM・three・Date.now・Math.random には触れない(設計書 2.2節)。乱数は渡された rng だけを使う。
 */

import { clamp, wrapAngle } from './math.js';

/**
 * ボットを1体作る。走るラインの左右のずれ(laneOffset)と速度の個体差(speedMul)を、
 * 生成時に一度だけ決めて固定する(設計書 10.5節)。
 * `botInput` は設計書どおり cfg を引数に取らないので、後で使う設定値(steerGain など)はここで Bot に持たせておく。
 * @param {ReturnType<typeof import('../../../_shared/core/rng.js').createRng>} rng このボット専用の rng(host 側で fork したもの)
 * @param {object} cfg makeConfig() が返す設定
 * @returns {object} Bot(botInput に渡す状態。呼び出し側は中身を直接いじらない)
 */
export function createAutopilot(rng, cfg) {
  const { speedJitter, laneOffsetMax } = cfg.autopilot;
  return {
    rng,
    cfg,
    speedMul: 1 + rng.range(-speedJitter, speedJitter),
    laneOffset: rng.range(-laneOffsetMax, laneOffsetMax),
    // アイテムを持ってから使うまでのカウントダウン(秒)。null は「まだ計っていない」
    itemTimer: null,
  };
}

/**
 * ボットの1フレーム分の入力を作る(設計書 10.5節)。
 * @param {object} bot createAutopilot が返した Bot(itemTimer を書き換える)
 * @param {{x:number, z:number, yaw:number, speed:number, s?:number, courseIndex?:number}} kart
 *   s がなければ course.project で求める
 * @param {ReturnType<typeof import('./course.js').buildCourse>} course
 * @param {{heldItem:?string, itemReady:boolean, targetAhead:boolean, targetBehind:boolean}} ctx
 * @param {number} dt
 * @returns {{throttle:number, steer:number, useItem:boolean, backward:boolean}}
 */
export function botInput(bot, kart, course, ctx, dt) {
  const cfg = bot.cfg.autopilot;
  const s = kart.s !== undefined && kart.s !== null
    ? kart.s
    : course.project(kart.x, kart.z, kart.courseIndex).s;

  // 目標点:少し先の、自分のレーンオフセット分ずれた位置(設計書 10.5節)
  const lookahead = cfg.lookaheadBase + cfg.lookaheadPerSpeed * Math.abs(kart.speed);
  const target = course.toWorld(s + lookahead, bot.laneOffset);
  const dx = target.x - kart.x;
  const dz = target.z - kart.z;
  const angle = wrapAngle(Math.atan2(dx, dz) - kart.yaw);
  // steer は右がプラス(設計書 2.1節)。目標が左(angle>0)にあるなら左(steer<0)に切りたいので符号を反転する
  const steer = clamp(-angle * cfg.steerGain, -1, 1);
  const throttle = Math.abs(angle) > cfg.slowAngle ? 0.5 : 1;

  const { useItem, backward } = decideItemUse(bot, cfg, ctx, dt);

  return { throttle, steer, useItem, backward };
}

/**
 * アイテムを使うかどうかを決める(設計書 10.5節)。
 * 持っていて準備ができてから rng.range(itemDelayMinSec, itemDelayMaxSec) 秒待って使う。
 * Rocket はすぐ前に人がいれば前、いなくてすぐ後ろに人がいれば backward。Oil は既定(後ろ)のまま。
 */
function decideItemUse(bot, cfg, ctx, dt) {
  if (!ctx.heldItem || !ctx.itemReady) {
    bot.itemTimer = null;
    return { useItem: false, backward: false };
  }

  if (bot.itemTimer === null) {
    // ルーレットが終わった(=持てて準備ができた)最初のフレームでカウントダウンを決める
    bot.itemTimer = bot.rng.range(cfg.itemDelayMinSec, cfg.itemDelayMaxSec);
  } else {
    bot.itemTimer -= dt;
  }

  if (bot.itemTimer > 0) {
    return { useItem: false, backward: false };
  }

  bot.itemTimer = null;
  let backward = false;
  if (ctx.heldItem === 'Rocket') {
    if (ctx.targetAhead) backward = false;
    else if (ctx.targetBehind) backward = true;
  }
  // Oil / Homing / Dash / Shield は既定のまま(design 8.3節:Homing/Dash/Shield は backward を無視する)
  return { useItem: true, backward };
}
