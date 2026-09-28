import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCourse } from '../src/core/course.js';
import { COURSE_DATA } from '../src/core/courseData.js';
import { makeConfig } from '../src/config.js';
import {
  createProgress,
  updateProgress,
  acceptCheckpoint,
  raceDistance,
  compareProgress,
  rankPlayers,
} from '../src/core/progress.js';

const cfg = makeConfig();
const course = buildCourse(COURSE_DATA, cfg);
const L = course.length;
const N = course.checkpoints.length;
const dt = cfg.fixedDt;

/** 中心線をなぞる疑似カート。s を直接進める(stepKart は使わない) */
function makeCenterlineKart(startS, speed) {
  let rawS = startS;
  const kart = { s: startS, yaw: 0, speed };
  const tangentAt = (s) => {
    const p = course.pointAt(s);
    return Math.atan2(p.tx, p.tz);
  };
  kart.yaw = tangentAt(kart.s);
  return {
    kart,
    advance(deltaSec) {
      rawS += kart.speed * deltaSec;
      let s = rawS % L;
      if (s < 0) s += L;
      kart.s = s;
      kart.yaw = tangentAt(s);
    },
  };
}

test('中心線をなぞる疑似走行で、10個のチェックポイントが順に報告され、2周でlap==2になる', () => {
  const drive = makeCenterlineKart(0, 20);
  const p = createProgress(course, 0);
  const allEvents = [];
  const totalTime = (2 * L) / 20 + 1; // 2周ぶんの時間に(次のチェックポイント間隔より短い)余裕を持たせる
  for (let t = 0; t < totalTime; t += dt) {
    drive.advance(dt);
    const events = updateProgress(p, drive.kart, course, cfg, dt);
    for (const e of events) allEvents.push(e);
  }

  // 1周ぶんは cp1..cp9, cp0 の10イベント。2周で20イベント
  assert.equal(allEvents.length, 20, `events=${JSON.stringify(allEvents)}`);
  for (let lap = 0; lap < 2; lap++) {
    for (let cp = 1; cp < N; cp++) {
      const e = allEvents[lap * N + (cp - 1)];
      assert.equal(e.cp, cp, `lap${lap} cp${cp}: got ${JSON.stringify(e)}`);
      assert.equal(e.lap, lap, `lap${lap} cp${cp}: got ${JSON.stringify(e)}`);
    }
    const gate = allEvents[lap * N + (N - 1)];
    assert.equal(gate.cp, 0);
    assert.equal(gate.lap, lap + 1);
  }
  assert.equal(p.lap, 2);
});

test('1つ飛ばすと周回にならない(nextCpが指す1つだけを見る。順番どおりでないチェックポイントは無視する)', () => {
  const p = createProgress(course, 0);
  p.nextCp = 5; // cp1 はまだ通っていない扱い
  p.prevS = 0;
  const cp1s = course.checkpoints[1].s;
  const yawAtCp1 = Math.atan2(course.pointAt(cp1s).tx, course.pointAt(cp1s).tz);
  // cp1 の s をまたいでも、nextCp=5 なので cp1 は判定対象にならない(無視される)
  const kart = { s: cp1s + 0.5, yaw: yawAtCp1, speed: 20 };
  const events = updateProgress(p, kart, course, cfg, dt);
  assert.equal(events.length, 0, `events=${JSON.stringify(events)}`);
  assert.equal(p.nextCp, 5, 'cp1 を跨いでも nextCp は進まない');
});

test('ゴールラインを後ろ向きにまたいでも周回にならない', () => {
  const p = createProgress(course, 0);
  p.nextCp = N; // 次はゴールライン
  p.lap = 0;
  p.prevS = 2; // ラインのすぐ後ろ(前向きに進んだ直後)
  const kart = { s: L - 2, yaw: 0, speed: 1 }; // 後ろ向きにまたぐ(s が大きく戻る想定)
  const events = updateProgress(p, kart, course, cfg, dt);
  assert.equal(events.length, 0);
  assert.equal(p.lap, 0);
  assert.equal(p.nextCp, N);
});

test('逆向きに走るとwrongWayになる', () => {
  const p = createProgress(course, 20);
  const tangent = course.pointAt(20);
  const backwardYaw = Math.atan2(-tangent.tx, -tangent.tz);
  const kart = { s: 20, yaw: backwardYaw, speed: cfg.wrongWay.minSpeed + 1 };

  let holdTime = 0;
  while (holdTime < cfg.wrongWay.holdSec) {
    updateProgress(p, kart, course, cfg, dt);
    holdTime += dt;
  }
  assert.equal(p.wrongWay, true);

  // 前向きに戻すとすぐ false に戻る
  kart.yaw = Math.atan2(tangent.tx, tangent.tz);
  updateProgress(p, kart, course, cfg, dt);
  assert.equal(p.wrongWay, false);
});

test('acceptCheckpoint は順番どおりの報告だけを受け付ける', () => {
  const hostProg = { lap: 0, nextCp: 1 };
  assert.equal(acceptCheckpoint(hostProg, 0, 2, N), false); // cp1 を飛ばした報告は無視
  assert.equal(hostProg.nextCp, 1);

  assert.equal(acceptCheckpoint(hostProg, 0, 1, N), true);
  assert.equal(hostProg.nextCp, 2);

  // nextCp を N まで進める
  for (let cp = 2; cp < N; cp++) {
    assert.equal(acceptCheckpoint(hostProg, 0, cp, N), true);
  }
  assert.equal(hostProg.nextCp, N);

  // ゴールラインは lap が +1 された報告のみ
  assert.equal(acceptCheckpoint(hostProg, 0, 0, N), false);
  assert.equal(acceptCheckpoint(hostProg, 1, 0, N), true);
  assert.equal(hostProg.lap, 1);
  assert.equal(hostProg.nextCp, 1);
});

test('raceDistanceはゴールラインの前後で連続している', () => {
  const before = raceDistance(0, N, L - 0.5, L, N);
  const after = raceDistance(1, 1, 0.5, L, N);
  assert.ok(Math.abs(after - before) < 1.5, `before=${before} after=${after}`);
});

test('compareProgressは周回→チェックポイント→距離の順で比べる', () => {
  // 周回が違えば、それだけで決まる
  assert.ok(compareProgress({ lap: 2, nextCp: 1, s: 0 }, { lap: 1, nextCp: 9, s: 700 }, L, N) > 0);

  // 周回が同じならチェックポイント数
  assert.ok(compareProgress({ lap: 0, nextCp: 5, s: 0 }, { lap: 0, nextCp: 2, s: 0 }, L, N) > 0);

  // 周回・チェックポイントが同じなら距離(近い方が前)
  const cp1s = course.checkpoints[1].s;
  const a = { lap: 0, nextCp: 1, s: cp1s - 1 }; // 次のチェックポイントまで1m
  const b = { lap: 0, nextCp: 1, s: cp1s - 10 }; // 次のチェックポイントまで10m
  assert.ok(compareProgress(a, b, L, N) > 0, 'a の方が近いので前のはず');

  // 完全に同じなら 0
  assert.equal(compareProgress(a, a, L, N), 0);
});

test('rankPlayersはゴール→走行中→抜けた人の順で、完全に同じならslotの小さい方が前', () => {
  const entries = [
    { slot: 3, lap: 1, nextCp: 1, s: 0, finishedAt: 1000, left: false },
    { slot: 1, lap: 1, nextCp: 1, s: 0, finishedAt: 500, left: false },
    { slot: 0, lap: 1, nextCp: 5, s: 100, finishedAt: null, left: false },
    { slot: 2, lap: 1, nextCp: 8, s: 100, finishedAt: null, left: false },
    { slot: 4, lap: 0, nextCp: 3, s: 50, finishedAt: null, left: true },
    { slot: 5, lap: 0, nextCp: 3, s: 50, finishedAt: null, left: true }, // slot4 と完全に同じ進み具合
  ];
  const ranking = rankPlayers(entries, L, N);
  assert.deepEqual(ranking, [1, 3, 2, 0, 4, 5]);
});
