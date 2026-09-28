import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAutopilot, botInput } from '../src/core/autopilot.js';
import { buildCourse } from '../src/core/course.js';
import { COURSE_DATA } from '../src/core/courseData.js';
import { makeConfig } from '../src/config.js';
import { createRng } from '../../_shared/core/rng.js';
import { wrapAngle } from '../src/core/math.js';

const cfg = makeConfig();
const course = buildCourse(COURSE_DATA, cfg);

/**
 * T6 の補足どおり、T5 の stepKart がまだないので「yaw 方向に一定速度で進むだけ」の簡単なカートを使う。
 * steer は設計書 2.1節どおり右がプラスで、右に切ると yaw が減る。
 */
function makeSimpleKart(x, z, yaw, speed) {
  return { x, z, yaw, speed, courseIndex: undefined };
}

function stepSimpleKart(kart, input, dt, turnRate) {
  kart.yaw = wrapAngle(kart.yaw - input.steer * turnRate * dt);
  const fx = Math.sin(kart.yaw);
  const fz = Math.cos(kart.yaw);
  kart.x += fx * kart.speed * dt;
  kart.z += fz * kart.speed * dt;
}

test('speedMul は 0.95〜1.05 に収まる', () => {
  for (let seed = 0; seed < 50; seed++) {
    const rng = createRng(seed);
    const bot = createAutopilot(rng, cfg);
    assert.ok(bot.speedMul >= 0.95 && bot.speedMul <= 1.05, `speedMul=${bot.speedMul}`);
  }
});

test('laneOffset は -laneOffsetMax〜+laneOffsetMax に収まる', () => {
  for (let seed = 0; seed < 50; seed++) {
    const rng = createRng(seed);
    const bot = createAutopilot(rng, cfg);
    const max = cfg.autopilot.laneOffsetMax;
    assert.ok(bot.laneOffset >= -max && bot.laneOffset <= max, `laneOffset=${bot.laneOffset}`);
  }
});

test('botInput で1周させても壁(|lateral| > 15)に触れない(laneOffset が最大のときも)', () => {
  const speed = 20;
  const dt = cfg.fixedDt;
  const turnRate = 2.6; // kart.turnRateLow 相当(簡単なカートなので固定値でよい)

  // laneOffset を最大に固定して確かめる(1つは createAutopilot の乱数任せ、もう1つは最大値を強制)
  for (const laneOffset of [cfg.autopilot.laneOffsetMax, -cfg.autopilot.laneOffsetMax]) {
    const rng = createRng(1);
    const bot = createAutopilot(rng, cfg);
    bot.laneOffset = laneOffset;

    const start = course.pointAt(0);
    const startYaw = Math.atan2(start.tx, start.tz);
    const kart = makeSimpleKart(start.x, start.z, startYaw, speed);

    let travelled = 0;
    let maxLateral = 0;
    // 1周ぶんの時間を少し余裕を見て回す
    const maxSteps = Math.ceil(((course.length / speed) * 1.5) / dt);
    for (let i = 0; i < maxSteps && travelled < course.length; i++) {
      const input = botInput(
        bot,
        kart,
        course,
        { heldItem: null, itemReady: false, targetAhead: false, targetBehind: false },
        dt
      );
      stepSimpleKart(kart, input, dt, turnRate);
      const proj = course.project(kart.x, kart.z, kart.courseIndex);
      kart.courseIndex = proj.index;
      maxLateral = Math.max(maxLateral, Math.abs(proj.lateral));
      assert.ok(Math.abs(proj.lateral) <= 15, `lateral=${proj.lateral} at step ${i}`);
      travelled += speed * dt;
    }
    assert.ok(travelled >= course.length, `travelled=${travelled} laneOffset=${laneOffset}`);
  }
});

test('アイテムを持って準備ができてから使うまでが 0.5〜2 秒の範囲', () => {
  const dt = cfg.fixedDt;
  for (let seed = 0; seed < 20; seed++) {
    const rng = createRng(seed);
    const bot = createAutopilot(rng, cfg);
    const kart = makeSimpleKart(0, 0, 0, 0);

    let elapsed = 0;
    let used = false;
    const maxSteps = Math.ceil(3 / dt);
    for (let i = 0; i < maxSteps; i++) {
      const input = botInput(
        bot,
        kart,
        course,
        { heldItem: 'Dash', itemReady: true, targetAhead: false, targetBehind: false },
        dt
      );
      elapsed += dt;
      if (input.useItem) {
        used = true;
        break;
      }
    }
    assert.equal(used, true, `seed=${seed} で使わなかった`);
    assert.ok(
      elapsed >= cfg.autopilot.itemDelayMinSec - dt && elapsed <= cfg.autopilot.itemDelayMaxSec + dt,
      `seed=${seed} elapsed=${elapsed}`
    );
  }
});

test('itemReady が false の間は使わず、true になってからカウントが始まる', () => {
  const dt = cfg.fixedDt;
  const rng = createRng(42);
  const bot = createAutopilot(rng, cfg);
  const kart = makeSimpleKart(0, 0, 0, 0);

  for (let i = 0; i < 60; i++) {
    const input = botInput(
      bot,
      kart,
      course,
      { heldItem: 'Dash', itemReady: false, targetAhead: false, targetBehind: false },
      dt
    );
    assert.equal(input.useItem, false);
  }
  assert.equal(bot.itemTimer, null);
});

test('Rocket はすぐ前に人がいれば前(backward=false)、いなくて後ろにいれば backward=true', () => {
  const dt = cfg.fixedDt;

  function untilUse(targetAhead, targetBehind) {
    const rng = createRng(7);
    const bot = createAutopilot(rng, cfg);
    const kart = makeSimpleKart(0, 0, 0, 0);
    for (let i = 0; i < Math.ceil(3 / dt); i++) {
      const input = botInput(
        bot,
        kart,
        course,
        { heldItem: 'Rocket', itemReady: true, targetAhead, targetBehind },
        dt
      );
      if (input.useItem) return input;
    }
    throw new Error('used されなかった');
  }

  assert.equal(untilUse(true, false).backward, false);
  assert.equal(untilUse(false, true).backward, true);
  assert.equal(untilUse(false, false).backward, false);
});

test('Oil は既定(backward=false)のまま使う', () => {
  const dt = cfg.fixedDt;
  const rng = createRng(3);
  const bot = createAutopilot(rng, cfg);
  const kart = makeSimpleKart(0, 0, 0, 0);
  for (let i = 0; i < Math.ceil(3 / dt); i++) {
    const input = botInput(
      bot,
      kart,
      course,
      { heldItem: 'Oil', itemReady: true, targetAhead: true, targetBehind: true },
      dt
    );
    if (input.useItem) {
      assert.equal(input.backward, false);
      return;
    }
  }
  throw new Error('used されなかった');
});
