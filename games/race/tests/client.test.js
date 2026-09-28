import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCourse } from '../src/core/course.js';
import { COURSE_DATA } from '../src/core/courseData.js';
import { makeConfig } from '../src/config.js';
import { createKartState } from '../src/core/kart.js';
import { RaceClient } from '../src/game/client.js';

const cfg = makeConfig();
const course = buildCourse(COURSE_DATA, cfg);
const dt = cfg.fixedDt;

/** [{slot,name,kind,local}] の小さな名簿を作る(自分 + n-1 人) */
function makeRoster(n) {
  const roster = [];
  for (let i = 0; i < n; i++) {
    roster.push({ slot: i, name: `P${i}`, kind: i === 0 ? 'human' : 'bot', local: true });
  }
  return roster;
}

/** RaceClient を作り、送ったメッセージとログを記録する */
function makeClient({ slot = 0, controller = 'human', seed = 1, roster = makeRoster(3) } = {}) {
  const sent = [];
  const logs = [];
  const client = new RaceClient({
    slot,
    cfg,
    course,
    roster,
    send: (m) => sent.push(m),
    controller,
    seed,
    log: (event, fields) => logs.push({ event, fields }),
  });
  return { client, sent, logs, roster };
}

/** grid を全 slot に均等に割り当てた roundStart メッセージを作る */
function roundStartMsg(roster, startAt) {
  const grid = roster.map((p, i) => ({ slot: p.slot, gridIndex: i }));
  return { t: 'roundStart', startAt, laps: cfg.laps, grid };
}

test('startAt前は入力しても動かず、countdownが3→2→1と減る。startAt後は動く', () => {
  const { client, roster } = makeClient();
  // roundStart を受け取るまではカートを置かない
  assert.equal(client.getView().phase, 'countdown');
  assert.equal(client.getView().countdown, null);

  const startAt = 3000;
  client.handleMessage(roundStartMsg(roster, startAt));
  assert.ok(client.kart, 'roundStart の grid から自分のカートが置かれる');

  let now = 0;
  const seenCountdowns = [];
  while (now < startAt) {
    client.update(now, dt, { throttle: 1, steer: 0, useItem: false, backward: false, lookBack: false });
    seenCountdowns.push(client.getView().countdown);
    now += dt * 1000;
  }
  assert.equal(client.kart.speed, 0, 'startAt前はthrottleを入れても速度が0のまま');
  assert.ok(seenCountdowns.includes(3));
  assert.ok(seenCountdowns.includes(2));
  assert.ok(seenCountdowns.includes(1));

  client.update(startAt, dt, { throttle: 1, steer: 0, useItem: false, backward: false, lookBack: false });
  assert.equal(client.getView().phase, 'racing');
  assert.ok(client.kart.speed > 0, 'startAt以降はthrottleが効いて速度が出る');
});

test('roundStart.gridの自分の位置から始まる', () => {
  const { client, roster } = makeClient({ slot: 1 });
  const grid = [{ slot: 0, gridIndex: 3 }, { slot: 1, gridIndex: 5 }, { slot: 2, gridIndex: 0 }];
  client.handleMessage({ t: 'roundStart', startAt: 1000, laps: cfg.laps, grid });
  const expected = course.gridPose(5);
  assert.ok(Math.abs(client.kart.x - expected.x) < 1e-6);
  assert.ok(Math.abs(client.kart.z - expected.z) < 1e-6);
});

test('kartStateがsendHzの間隔で送られ、tsがホスト時刻になっている', () => {
  const { client, sent, roster } = makeClient();
  client.handleMessage(roundStartMsg(roster, 0));
  let now = 0;
  for (let i = 0; i < 120; i++) {
    client.update(now, dt, { throttle: 1, steer: 0, useItem: false, backward: false, lookBack: false });
    now += dt * 1000;
  }
  const kartStates = sent.filter((m) => m.t === 'kartState');
  assert.ok(kartStates.length >= 3, `kartStateが複数回送られること(${kartStates.length}回)`);
  const intervalMs = 1000 / cfg.net.sendHz;
  for (let i = 1; i < kartStates.length; i++) {
    const gap = kartStates[i].ts - kartStates[i - 1].ts;
    assert.ok(gap >= intervalMs - 1e-6, `送信間隔がsendHzどおり(gap=${gap})`);
  }
  for (const ks of kartStates) {
    assert.equal(typeof ks.ts, 'number');
  }
});

test('チェックポイントを通るとreportCheckpointが送られる', () => {
  const { client, sent, logs, roster } = makeClient();
  client.handleMessage(roundStartMsg(roster, 0));
  // 最初のチェックポイント(cp=1)の少し手前に置き直して、直進で確実にまたがせる
  const cp1 = course.checkpoints[1];
  const p = course.pointAt(cp1.s - 2);
  const yaw = Math.atan2(p.tx, p.tz);
  client.kart = createKartState({ x: p.x, z: p.z, yaw }, course);
  client.progress = { lap: 0, nextCp: 1, prevS: client.kart.s, wrongWayT: 0, wrongWay: false };

  let now = 1000;
  for (let i = 0; i < 60; i++) {
    client.update(now, dt, { throttle: 1, steer: 0, useItem: false, backward: false, lookBack: false });
    now += dt * 1000;
  }
  const reported = sent.filter((m) => m.t === 'reportCheckpoint');
  assert.ok(reported.some((m) => m.lap === 0 && m.cp === 1));
  assert.ok(logs.some((l) => l.event === 'checkpoint'));
});

test('パッドを踏むと自分でapplyBoostし、ログにboostPadが出る', () => {
  const { client, logs, roster } = makeClient();
  client.handleMessage(roundStartMsg(roster, 0));
  const pad = course.boostPads[0];
  const world = course.toWorld(pad.s, pad.lateral);
  const p = course.pointAt(pad.s);
  const yaw = Math.atan2(p.tx, p.tz);
  client.kart = createKartState({ x: world.x, z: world.z, yaw }, course);

  client.update(1000, dt, { throttle: 0, steer: 0, useItem: false, backward: false, lookBack: false });
  assert.ok(client.kart.boostT > 0, 'ブーストパッドでboostTが立つ');
  assert.ok(logs.some((l) => l.event === 'boostPad' && l.fields.padId === pad.id));
});

test('ボックスに触れるとrequestPickupが1回だけ送られる。itemGrantedの後、rouletteMsが過ぎるまで使えない', () => {
  const { client, sent, roster } = makeClient();
  client.handleMessage(roundStartMsg(roster, 0));
  const box = course.itemBoxes[0];
  const world = course.toWorld(box.s, box.lateral);
  const p = course.pointAt(box.s);
  const yaw = Math.atan2(p.tx, p.tz);
  client.kart = createKartState({ x: world.x, z: world.z, yaw }, course);

  client.update(1000, dt, { throttle: 0, steer: 0, useItem: false, backward: false, lookBack: false });
  client.update(1000 + dt * 1000, dt, { throttle: 0, steer: 0, useItem: false, backward: false, lookBack: false });
  const pickups = sent.filter((m) => m.t === 'requestPickup' && m.boxId === box.id);
  assert.equal(pickups.length, 1, 'requestPickupは1回だけ');

  client.handleMessage({ t: 'itemGranted', slot: 0, item: 'Dash', rouletteMs: 800 });
  client.update(1000, dt, { throttle: 0, steer: 0, useItem: true, backward: false, lookBack: false });
  assert.equal(sent.filter((m) => m.t === 'requestUseItem').length, 0, 'ルーレット中は使えない');

  client.update(1000 + 900, dt, { throttle: 0, steer: 0, useItem: true, backward: false, lookBack: false });
  assert.equal(sent.filter((m) => m.t === 'requestUseItem').length, 1, 'rouletteMsが過ぎたら使える');
});

test('objStateで受け取った弾に当たるとreportHitが1回だけ送られる。applySpinはslotが自分のときだけ効く', () => {
  const { client, sent, roster } = makeClient();
  client.handleMessage(roundStartMsg(roster, 0));
  client.update(1000, dt, { throttle: 0, steer: 0, useItem: false, backward: false, lookBack: false });

  client.handleMessage({ t: 'spawnObj', id: 42, type: 'Rocket', owner: 1, x: client.kart.x, z: client.kart.z, yaw: 0, active: true });
  client.update(1000 + dt * 1000, dt, { throttle: 0, steer: 0, useItem: false, backward: false, lookBack: false });
  const hits = sent.filter((m) => m.t === 'reportHit');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].objId, 42);

  // 二度目は送らない
  client.update(1000 + dt * 2000, dt, { throttle: 0, steer: 0, useItem: false, backward: false, lookBack: false });
  assert.equal(sent.filter((m) => m.t === 'reportHit').length, 1);

  // applySpin: 自分あてなら効く
  assert.equal(client.kart.spinT, 0);
  client.handleMessage({ t: 'applySpin', slot: 0 });
  assert.ok(client.kart.spinT > 0);

  // ほかの人あては何も起きない(別インスタンスで確認)
  const { client: other } = makeClient({ slot: 0 });
  other.handleMessage(roundStartMsg(roster, 0));
  other.handleMessage({ t: 'applySpin', slot: 1 });
  assert.equal(other.kart.spinT, 0);
});

test('kartsで受け取ったほかのプレイヤーがgetView().othersに補間されて出る。playerLeftで消える', () => {
  const { client, roster } = makeClient({ slot: 0, roster: makeRoster(3) });
  client.handleMessage(roundStartMsg(roster, 0));
  client.update(1000, dt, { throttle: 0, steer: 0, useItem: false, backward: false, lookBack: false });

  client.handleMessage({
    t: 'karts',
    ts: client._now,
    list: [
      { slot: 0, x: 0, z: 0, yaw: 0, speed: 0, spinT: 0, boostT: 0, finished: false },
      { slot: 1, x: 10, z: 20, yaw: 0.5, speed: 5, spinT: 0, boostT: 0, finished: false },
      { slot: 2, x: -5, z: 8, yaw: 1.0, speed: 3, spinT: 0, boostT: 0, finished: false },
    ],
  });
  let view = client.getView();
  assert.equal(view.others.length, 2);
  const s1 = view.others.find((o) => o.slot === 1);
  assert.ok(s1);
  assert.ok(Math.abs(s1.x - 10) < 1e-6);
  assert.ok(Math.abs(s1.z - 20) < 1e-6);

  client.playerLeft(1);
  view = client.getView();
  assert.equal(view.others.length, 1);
  assert.ok(!view.others.some((o) => o.slot === 1));
});

test('ゴール後はautopilotで流れ、アイテムを使わず、当たりを報告しない', () => {
  const { client, sent, roster } = makeClient();
  client.handleMessage(roundStartMsg(roster, 0));
  client.update(1000, dt, { throttle: 0, steer: 0, useItem: false, backward: false, lookBack: false });

  client.handleMessage({ t: 'itemGranted', slot: 0, item: 'Rocket', rouletteMs: 0 });
  client.handleMessage({ t: 'spawnObj', id: 7, type: 'Oil', owner: 1, x: client.kart.x, z: client.kart.z, yaw: 0, active: true });
  client.handleMessage({ t: 'playerFinished', slot: 0, place: 1, timeMs: 12345 });
  assert.equal(client.getView().phase, 'finished');

  const x0 = client.kart.x;
  const z0 = client.kart.z;
  let now = 1000 + dt * 1000;
  for (let i = 0; i < 30; i++) {
    client.update(now, dt, { throttle: 1, steer: 0, useItem: true, backward: false, lookBack: false });
    now += dt * 1000;
  }
  assert.equal(sent.filter((m) => m.t === 'requestUseItem').length, 0, 'ゴール後はアイテムを使わない');
  assert.equal(sent.filter((m) => m.t === 'reportHit').length, 0, 'ゴール後は当たりを報告しない');
  assert.ok(client.kart.x !== x0 || client.kart.z !== z0, 'ゴール後もautopilotでカートが動く');
});

test('lookBack:trueの入力でアイテムを使うとrequestUseItem{backward:true}が送られ、getView().lookBackがtrueになる', () => {
  const { client, sent, roster } = makeClient();
  client.handleMessage(roundStartMsg(roster, 0));
  client.handleMessage({ t: 'itemGranted', slot: 0, item: 'Rocket', rouletteMs: 0 });
  client.update(1000, dt, { throttle: 0, steer: 0, useItem: true, backward: false, lookBack: true });
  const used = sent.filter((m) => m.t === 'requestUseItem');
  assert.equal(used.length, 1);
  assert.equal(used[0].backward, true);
  assert.equal(client.getView().lookBack, true);
});

test("controller:'bot'のとき入力なしで走り、アイテムを使う", () => {
  const { client, sent, roster } = makeClient({ slot: 0, controller: 'bot', seed: 7 });
  client.handleMessage(roundStartMsg(roster, 0));
  const x0 = course.gridPose(0).x;
  const z0 = course.gridPose(0).z;

  let now = 0;
  for (let i = 0; i < 30; i++) {
    client.update(now, dt); // input を渡さない
    now += dt * 1000;
  }
  assert.ok(client.kart.x !== x0 || client.kart.z !== z0, 'ボットは入力なしで走る');

  client.handleMessage({ t: 'itemGranted', slot: 0, item: 'Dash', rouletteMs: 0 });
  let used = false;
  for (let i = 0; i < 300 && !used; i++) {
    client.update(now, dt);
    now += dt * 1000;
    used = sent.some((m) => m.t === 'requestUseItem');
  }
  assert.ok(used, 'ボットはitemDelayMinSec〜itemDelayMaxSec秒後にアイテムを使う');
});
