/**
 * 枠(_shared/frame)のヘッドレス版 + ボット2〜8台の対戦を早送りで回す結合テスト(設計書 14節、
 * 実装プラン T11)。DOM・three・PeerJS・実時刻・Math.random は使わない。`now` はすべてこのテストが進める。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHostFrame } from '../../_shared/frame/hostFrame.js';
import { createGuestFrame } from '../../_shared/frame/guestFrame.js';
import { createLoopbackPair } from '../../_shared/net/loopback.js';
import { definition } from '../src/game.js';
import { makeConfig } from '../src/config.js';

// window.__mg01(ブラウザ用の検証出口)を Node でも使えるようにする。dom は渡さないので renderer/hud/input
// を動的 import することはなく、three には触れない(設計書 2.2節)。
globalThis.window = globalThis.window || {};

const cfg = makeConfig();
const FIXED_DT_MS = cfg.fixedDt * 1000; // 60Hz。ボット8台のレースでもこの刻みのまま回す(要件)。
// startAt までの余裕(startDelaySec + countdownSec)を含めた、レースが確実に終わっているはずの時刻の目安。
const RACE_DEADLINE_MS = (cfg.startDelaySec + cfg.countdownSec + cfg.timeLimitSec) * 1000 + 3000;

/** frames(host/guest 枠)を dt 刻みで進める。stop() が true を返したら打ち切る。 */
function driveUntil(frames, fromNow, { maxMs, stop, dt = FIXED_DT_MS }) {
  let t = fromNow;
  const limit = fromNow + maxMs;
  while (t < limit) {
    t += dt;
    for (const f of frames) f.update(t);
    if (stop && stop()) return t;
  }
  return t;
}

/** ホストの枠を作る。logs を渡すとゲームの ctx.log をすべて記録する。 */
function makeHost({ seed = 1, onDisconnect = 'continue', maxPlayers = 8, logs = null } = {}) {
  const events = { gameEnd: [], gameStart: [] };
  const host = createHostFrame({
    definition,
    maxPlayers,
    onDisconnect,
    hostName: 'Host',
    playerId: `host-${seed}`,
    seed,
    createGameCtxExtras: () => ({
      dom: null,
      log: logs ? (event, fields) => logs.push({ event, fields }) : () => {},
    }),
    events: {
      onGameEnd: (r) => events.gameEnd.push(r),
      onGameStart: (info) => events.gameStart.push(info),
    },
  });
  return { host, events };
}

/** 新しい loopback をホストへつなぎ、ゲストの枠を作る */
function connectGuest(host, { playerId, name = 'Guest', latencyMs = 0, logs = null } = {}) {
  const [hostSide, guestSide] = createLoopbackPair({ latencyMs });
  host.acceptTransport(hostSide);
  const events = { gameEnd: [] };
  const guest = createGuestFrame({
    definition,
    name,
    playerId,
    transport: guestSide,
    createGameCtxExtras: () => ({
      dom: null,
      log: logs ? (event, fields) => logs.push({ event, fields }) : () => {},
    }),
    events: { onGameEnd: (r) => events.gameEnd.push(r) },
  });
  return { guest, events, hostSide, guestSide };
}

// ------------------------------------------------------------------
// 1. ボット2台(ホストの人も autopilot)で30レース
// ------------------------------------------------------------------

const twoBotLogs = [];
const twoBotWins = { 0: 0, 1: 0 };
const lapTimesSec = [];

test('ボット2台(ホストの人も autopilot)で30レース: すべて時間内に終わり、両方が1回以上勝つ', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const { host, events } = makeHost({ seed, logs: twoBotLogs });
    host.addBot();
    host.startGame({ autopilot: true }, 0);

    const endNow = driveUntil([host], 0, {
      maxMs: RACE_DEADLINE_MS,
      stop: () => events.gameEnd.length > 0,
    });

    assert.equal(events.gameEnd.length, 1, `seed=${seed} で timeLimitSec 以内に終わらなかった`);
    assert.ok(endNow <= RACE_DEADLINE_MS, `seed=${seed}: timeLimitSec 以内`);

    const result = events.gameEnd[0];
    twoBotWins[result.ranking[0]] = (twoBotWins[result.ranking[0]] || 0) + 1;

    for (const r of result.details.results) {
      if (r.status === 'finished' && r.timeMs != null) lapTimesSec.push(r.timeMs / 1000 / cfg.laps);
    }
  }

  assert.ok(twoBotWins[0] > 0, `slot0 が1回も勝っていない: ${JSON.stringify(twoBotWins)}`);
  assert.ok(twoBotWins[1] > 0, `slot1 が1回も勝っていない: ${JSON.stringify(twoBotWins)}`);

  const avgLapSec = lapTimesSec.reduce((a, b) => a + b, 0) / lapTimesSec.length;
  console.log(
    `[sim.test] 2台×30レース: 勝ち数 slot0=${twoBotWins[0]} slot1=${twoBotWins[1]} / 平均1周タイム=${avgLapSec.toFixed(2)}秒(目安25〜40秒)`,
  );
});

test('ログに itemGranted / itemUsed / hit / boostPad / lap / finish / raceEnd が出る(2台×30レースの集計)', () => {
  const events = new Set(twoBotLogs.map((l) => l.event));
  for (const need of ['itemGranted', 'itemUsed', 'hit', 'boostPad', 'lap', 'finish', 'raceEnd']) {
    assert.ok(events.has(need), `ログに ${need} が出ていない`);
  }
});

test('2位の (Homing + Dash) の割合 > 1位の割合(2台×30レースの itemGranted 集計)', () => {
  // itemGranted は host だけがログに出す(client.js は出さない)ので src での絞り込みは不要だが、
  // 「host からのログには必ず src: 'host' がつく」ことも合わせて確かめる。
  const grants = twoBotLogs.filter((l) => l.event === 'itemGranted');
  assert.ok(grants.every((l) => l.fields.src === 'host'), 'itemGranted のログはすべて src: host');

  const counts = { leader: { total: 0, homingDash: 0 }, other: { total: 0, homingDash: 0 } };
  for (const { fields } of grants) {
    const bucket = fields.table === 'leader' ? counts.leader : counts.other; // 2人なので other = near ∪ far = 2位
    bucket.total += 1;
    if (fields.item === 'Homing' || fields.item === 'Dash') bucket.homingDash += 1;
  }
  assert.ok(counts.leader.total > 0 && counts.other.total > 0, '両方のテーブルで抽選が起きていない');
  const leaderRatio = counts.leader.homingDash / counts.leader.total;
  const otherRatio = counts.other.homingDash / counts.other.total;
  console.log(
    `[sim.test] Homing+Dash の割合: 1位=${leaderRatio.toFixed(3)} 2位=${otherRatio.toFixed(3)}(2位が高いはず)`,
  );
  assert.ok(otherRatio > leaderRatio, `2位の割合が1位以下: leader=${leaderRatio} other=${otherRatio}`);
});

// ------------------------------------------------------------------
// 2. ボット8台で10レース
// ------------------------------------------------------------------

test('ボット8台で10レース: すべて終わり、1位の slot が3種類以上ある', () => {
  const winners = new Set();
  for (let seed = 1; seed <= 10; seed++) {
    const { host, events } = makeHost({ seed: seed + 1000, maxPlayers: 8 });
    for (let i = 0; i < 7; i++) host.addBot();
    host.startGame({ autopilot: true }, 0);

    driveUntil([host], 0, {
      maxMs: RACE_DEADLINE_MS,
      stop: () => events.gameEnd.length > 0,
    });

    assert.equal(events.gameEnd.length, 1, `seed=${seed} で終わらなかった`);
    winners.add(events.gameEnd[0].ranking[0]);
  }
  assert.ok(winners.size >= 3, `1位の slot が3種類未満: ${[...winners]}`);
});

// ------------------------------------------------------------------
// 3. forceItemBySlot で Shield と Rocket を渡し、shieldBlock を確かめる
// ------------------------------------------------------------------

test('forceItemBySlot で Shield / Rocket を渡したレースで shieldBlock が出る', () => {
  const logs = [];
  let sawShieldBlock = false;
  for (let seed = 1; seed <= 8 && !sawShieldBlock; seed++) {
    const { host, events } = makeHost({ seed: seed + 2000, logs });
    host.addBot();
    host.startGame(
      { autopilot: true, test: { forceItemBySlot: { 0: 'Shield', 1: 'Rocket' } } },
      0,
    );
    driveUntil([host], 0, { maxMs: RACE_DEADLINE_MS, stop: () => events.gameEnd.length > 0 });
    sawShieldBlock = logs.some((l) => l.event === 'shieldBlock');
  }
  assert.ok(sawShieldBlock, '8レース試しても shieldBlock が出なかった');
});

// ------------------------------------------------------------------
// 4. ゲスト1つ + ホストの枠、ループバック150msでも2台の条件が成り立つ
// ------------------------------------------------------------------

test('ゲスト1人(bot 操作)+ ホストの枠、ループバック150msでも2台の条件が成り立つ', () => {
  const wins = { 0: 0, 1: 0 };
  const RACES = 10;
  for (let seed = 1; seed <= RACES; seed++) {
    const { host, events: hostEvents } = makeHost({ seed: seed + 3000, maxPlayers: 2 });
    const { guest, events: guestEvents, guestSide } = connectGuest(host, {
      playerId: `g-${seed}`,
      latencyMs: 150,
    });

    driveUntil([host, guest], 0, { maxMs: 2000, stop: () => guest.localSlot >= 0 });
    assert.equal(guest.localSlot, 1);

    const startNow = 2000;
    host.startGame({ autopilot: true }, startNow);

    // 150ms の遅延があるので、host 側の gameEnd を見ただけで止めると endGame がゲストにまだ届いていない
    // ことがある(結合して見つけた不具合というより、このテストの打ち切り条件の書き方の問題)。両方が
    // gameEnd を受け取るまで進める。
    const endNow = driveUntil([host, guest], startNow, {
      maxMs: RACE_DEADLINE_MS,
      stop: () => hostEvents.gameEnd.length > 0 && guestEvents.gameEnd.length > 0,
    });

    assert.equal(hostEvents.gameEnd.length, 1, `seed=${seed} で終わらなかった(150ms遅延)`);
    assert.equal(guestEvents.gameEnd.length, 1);
    assert.ok(endNow - startNow <= RACE_DEADLINE_MS);

    const result = hostEvents.gameEnd[0];
    wins[result.ranking[0]] = (wins[result.ranking[0]] || 0) + 1;
    guestSide.close();
  }
  console.log(`[sim.test] 150ms遅延 ${RACES}レース: 勝ち数 ${JSON.stringify(wins)}`);
  assert.ok(wins[0] > 0 && wins[1] > 0, `150ms遅延でも両方が1回以上勝つはず: ${JSON.stringify(wins)}`);
});

// ------------------------------------------------------------------
// 5. 8台のレース途中でゲストが1人切断(onDisconnect = 'continue')
// ------------------------------------------------------------------

test("8台のレース途中でゲストが1人切断しても最後まで進み、その人が最下位になる", () => {
  const { host, events } = makeHost({ seed: 4242, onDisconnect: 'continue', maxPlayers: 8 });
  for (let i = 0; i < 6; i++) host.addBot();
  const { guest, guestSide } = connectGuest(host, { playerId: 'guest-a' });

  driveUntil([host, guest], 0, { maxMs: 2000, stop: () => guest.localSlot >= 0 });
  const guestSlot = guest.localSlot;
  assert.equal(host.roster.length, 8);

  const startNow = 2000;
  host.startGame({ autopilot: true }, startNow);
  // レースを少し進めてから切断する(カートが動き出した状態で抜ける)
  driveUntil([host, guest], startNow, { maxMs: 5000, stop: () => false });
  guestSide.close();

  const endNow = driveUntil([host], startNow, {
    maxMs: RACE_DEADLINE_MS,
    stop: () => events.gameEnd.length > 0,
  });
  assert.equal(events.gameEnd.length, 1, '切断後も最後まで進むはず');
  assert.ok(endNow <= startNow + RACE_DEADLINE_MS);

  const result = events.gameEnd[0];
  const results = result.details.results;
  const entry = results.find((r) => r.slot === guestSlot);
  assert.equal(entry.status, 'left', '切断した人は left になる');
  assert.equal(entry.place, results.length, '切断した人は最下位になる');
});

// ------------------------------------------------------------------
// 6. finishRule = 'first'
// ------------------------------------------------------------------

test("finishRule = 'first' で最初のゴールで終わる", () => {
  const { host, events } = makeHost({ seed: 5555 });
  host.addBot();
  host.startGame({ autopilot: true, finishRule: 'first' }, 0);

  const endNow = driveUntil([host], 0, {
    maxMs: RACE_DEADLINE_MS,
    stop: () => events.gameEnd.length > 0,
  });

  assert.equal(events.gameEnd.length, 1);
  const result = events.gameEnd[0];
  assert.equal(result.reason, 'first');
  const finishedCount = result.details.results.filter((r) => r.status === 'finished').length;
  assert.ok(finishedCount >= 1, '少なくとも1人はゴールしているはず');
  assert.ok(finishedCount < 2, "'first' なので2人ともゴールしている状態で終わるのは想定外");
  void endNow;
});

// ------------------------------------------------------------------
// 7. もう一度(新しいゲーム)を始めた直後、objects が空
// ------------------------------------------------------------------

test('もう一度(新しいゲーム)を始めた直後、全クライアントの getView().objects が空', () => {
  const logs = [];
  const { host, events } = makeHost({ seed: 6666, logs });
  host.addBot();

  // 1レース目:Rocket を強制して、objects に何か出ることを確かめてから最後まで進める
  host.startGame({ autopilot: true, test: { forceItemBySlot: { 0: 'Rocket' } } }, 0);
  driveUntil([host], 0, {
    maxMs: RACE_DEADLINE_MS,
    stop: () => events.gameEnd.length > 0,
  });
  assert.equal(events.gameEnd.length, 1);
  assert.ok(
    logs.some((l) => l.event === 'spawn'),
    '1レース目で弾が spawn しているはず',
  );

  // 2レース目:開始直後は objects が空のはず
  const now2 = RACE_DEADLINE_MS + 20000;
  host.startGame({ autopilot: true }, now2);
  driveUntil([host], now2, { maxMs: 500, stop: () => false });

  const clients = window.__mg01.clients;
  const slots = Object.keys(clients);
  assert.ok(slots.length > 0, 'window.__mg01.clients が空');
  for (const slot of slots) {
    const view = clients[slot].getView();
    assert.equal(view.objects.length, 0, `slot ${slot} の objects が空でない`);
  }
});
