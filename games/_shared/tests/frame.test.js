import test from 'node:test';
import assert from 'node:assert/strict';

import { createHostFrame } from '../frame/hostFrame.js';
import { createGuestFrame } from '../frame/guestFrame.js';
import { createLoopbackPair } from '../net/loopback.js';
import { wrapChannel } from '../net/channel.js';
import { createFakeGameDefinition } from './fakeGame.js';

/** frames(host/guest 枠)を dt 刻みで toNow まで進める */
function advance(frames, fromNow, toNow, dt = 16) {
  let t = fromNow;
  for (; t < toNow; t += dt) {
    for (const f of frames) f.update(t);
  }
  for (const f of frames) f.update(toNow);
  return toNow;
}

function makeHost(overrides = {}) {
  const fake = overrides.fake || createFakeGameDefinition();
  const events = { roster: [], gameStart: [], gameEnd: [], paused: 0, resumed: 0 };
  const host = createHostFrame({
    definition: fake.definition,
    maxPlayers: overrides.maxPlayers ?? 8,
    onDisconnect: overrides.onDisconnect ?? 'continue',
    hostName: 'Host',
    playerId: overrides.hostPlayerId ?? 'host-1',
    seed: overrides.seed ?? 12345,
    events: {
      onRoster: (r) => events.roster.push(r.map((p) => ({ slot: p.slot, kind: p.kind, waiting: p.waiting }))),
      onGameStart: (info) => events.gameStart.push(info),
      onGameEnd: (result) => events.gameEnd.push(result),
      onPaused: () => events.paused++,
      onResumed: () => events.resumed++,
    },
  });
  return { host, fake, events };
}

/** 新しい loopback をホストへつなぎ、ゲストの枠を作る */
function connectGuest(host, { playerId, name = 'Guest', fake } = {}) {
  const [hostSide, guestSide] = createLoopbackPair();
  host.acceptTransport(hostSide);
  const events = { roster: [], gameStart: [], gameEnd: [], paused: 0, resumed: 0, reject: [], hostLost: 0 };
  const guest = createGuestFrame({
    definition: fake.definition,
    name,
    playerId,
    transport: guestSide,
    events: {
      onRoster: (r) => events.roster.push(r.map((p) => ({ slot: p.slot, kind: p.kind, waiting: p.waiting }))),
      onGameStart: (info) => events.gameStart.push(info),
      onGameEnd: (result) => events.gameEnd.push(result),
      onPaused: () => events.paused++,
      onResumed: () => events.resumed++,
      onReject: (reason) => events.reject.push(reason),
      onHostLost: () => events.hostLost++,
    },
  });
  return { guest, events, hostSide, guestSide };
}

test('hello -> welcome, 名簿が全員に配られる', () => {
  const fake = createFakeGameDefinition();
  const { host } = makeHost({ fake });
  const { guest, events } = connectGuest(host, { playerId: 'g-1', fake });

  advance([host, guest], 0, 50);

  assert.equal(guest.localSlot, 1); // host が slot 0
  assert.equal(guest.roster.length, 2);
  assert.ok(events.roster.length > 0, 'ゲストに roster イベントが届く');
  assert.equal(host.roster.length, 2);
});

test('maxPlayers を超えたら reject: full', () => {
  const fake = createFakeGameDefinition();
  const { host } = makeHost({ fake, maxPlayers: 1 }); // ホストだけで満員
  const { guest, events } = connectGuest(host, { playerId: 'g-1', fake });

  advance([host, guest], 0, 50);

  assert.ok(events.reject.includes('full'));
  assert.equal(host.roster.length, 1);
});

test('プロトコルのバージョンが違えば reject: version', () => {
  const { host } = makeHost();
  const [hostSide, guestSide] = createLoopbackPair();
  host.acceptTransport(hostSide);
  const channel = wrapChannel(guestSide);
  const received = [];
  channel.frame.onMessage((m) => received.push(m));
  channel.frame.send({ t: 'hello', v: 999, playerId: 'bad-v', name: 'Bad' });

  advance([host], 0, 10);
  guestSide.pump(10);

  assert.equal(received.length, 1);
  assert.equal(received[0].t, 'reject');
  assert.equal(received[0].reason, 'version');
});

test('addBot: 名簿に kind: bot, local: true として入り、人数の上限に数えられる', () => {
  const { host } = makeHost({ maxPlayers: 2 });
  const bot = host.addBot();
  assert.equal(bot.kind, 'bot');
  assert.equal(bot.local, true);
  assert.equal(bot.name, 'BOT 1');
  assert.equal(host.roster.length, 2);

  const full = createFakeGameDefinition();
  const { guest, events } = connectGuest(host, { playerId: 'g-1', fake: full });
  advance([host, guest], 0, 10);
  assert.ok(events.reject.includes('full'), 'ボット込みで満員なら人間の参加は reject: full');
});

test('startGame: 全員で同じ seed・同じ名簿の createGame が呼ばれ、onResult 後に endGame が届き dispose される', () => {
  const fake = createFakeGameDefinition({ resultDelayMs: 100 });
  const { host, events: hostEvents } = makeHost({ fake });
  const { guest, events: guestEvents } = connectGuest(host, { playerId: 'g-1', fake });

  advance([host, guest], 0, 50);
  host.startGame({}, 1000);
  advance([host, guest], 1000, 1050);

  assert.equal(fake.instances.length, 2, 'host 側と guest 側で1つずつ createGame される');
  const [hostInst, guestInst] = fake.instances;
  assert.equal(hostInst.role, 'host');
  assert.equal(guestInst.role, 'guest');
  assert.equal(hostInst.seed, guestInst.seed, '同じ seed');
  assert.deepEqual(
    hostInst.roster.map((p) => p.slot),
    guestInst.roster.map((p) => p.slot),
    '同じ名簿(slot の並び)',
  );
  // local はそれぞれの端末の視点で異なってよい
  assert.equal(hostInst.roster.find((p) => p.slot === 0).local, true); // host 自身
  assert.equal(guestInst.roster.find((p) => p.slot === 1).local, true); // guest 自身
  assert.equal(guestInst.roster.find((p) => p.slot === 0).local, false);

  // resultDelayMs=100 経過で onResult -> endGame
  advance([host, guest], 1050, 1300);
  assert.equal(hostEvents.gameEnd.length, 1);
  assert.equal(guestEvents.gameEnd.length, 1);
  assert.deepEqual(hostEvents.gameEnd[0], guestEvents.gameEnd[0]);
  assert.equal(hostInst.disposed, true);
  assert.equal(guestInst.disposed, true);
  assert.equal(host.phase, 'result');
  assert.equal(guest.phase, 'result');
});

test('ゲームが createGame の中ですぐ送ったメッセージも、ゲストに届く(startGame が先に届く)', () => {
  const fake = createFakeGameDefinition({ sendOnCreate: { t: 'hi' } });
  const { host } = makeHost({ fake });
  const { guest } = connectGuest(host, { playerId: 'g-1', fake });

  advance([host, guest], 0, 50);
  host.startGame({}, 1000);
  advance([host, guest], 1000, 1050);

  const guestInst = fake.instances.find((r) => r.role === 'guest');
  assert.ok(guestInst, 'ゲストでも createGame される');
  assert.deepEqual(guestInst.received.map((r) => r.m.t), ['hi']);
});

test('同じ playerId で再接続すると同じ slot に戻る', () => {
  const fake = createFakeGameDefinition();
  const { host } = makeHost({ fake });
  const { guest, guestSide } = connectGuest(host, { playerId: 'g-1', fake });
  advance([host, guest], 0, 50);
  assert.equal(guest.localSlot, 1);

  guestSide.close(); // 接続が切れる(ホスト側の onClose が呼ばれる)
  advance([host], 50, 60);
  assert.equal(host.roster.find((p) => p.playerId === 'g-1').connected, false);

  const [newHostSide, newGuestSide] = createLoopbackPair();
  host.acceptTransport(newHostSide);
  guest.replaceTransport(newGuestSide);
  advance([host, guest], 60, 120);

  assert.equal(guest.localSlot, 1, '同じ slot に戻る');
  assert.equal(host.roster.find((p) => p.playerId === 'g-1').connected, true);
});

test("onDisconnect = 'continue': 切断で残った全員の onPlayerLeft が呼ばれ、ゲームは続く。戻ると waiting", () => {
  const fake = createFakeGameDefinition({ resultDelayMs: 100000 }); // このテストでは自然終了させない
  const { host } = makeHost({ fake, onDisconnect: 'continue' });
  const a = connectGuest(host, { playerId: 'a', fake });
  const b = connectGuest(host, { playerId: 'b', fake });
  advance([host, a.guest, b.guest], 0, 50);

  host.startGame({}, 1000);
  advance([host, a.guest, b.guest], 1000, 1050);

  const bSlot = host.roster.find((p) => p.playerId === 'b').slot;
  b.guestSide.close();
  advance([host, a.guest], 1050, 1100);

  const hostInst = fake.instances.find((i) => i.role === 'host');
  const aInst = fake.instances.find((i) => i.role === 'guest' && i.localSlot === a.guest.localSlot);
  assert.ok(hostInst.playerLeft.includes(bSlot), 'ホスト自身の local ゲームに onPlayerLeft');
  assert.ok(aInst.playerLeft.includes(bSlot), '残ったゲスト a の local ゲームにも onPlayerLeft');
  assert.equal(hostInst.disposed, false, 'continue ではゲームを破棄しない');
  assert.equal(host.phase, 'inGame');

  // b が戻る
  const [newHostSide, newGuestSide] = createLoopbackPair();
  host.acceptTransport(newHostSide);
  b.guest.replaceTransport(newGuestSide);
  advance([host, a.guest, b.guest], 1100, 1150);

  const bEntry = host.roster.find((p) => p.playerId === 'b');
  assert.equal(bEntry.connected, true);
  assert.equal(bEntry.waiting, true, '戻ってきた人は観戦待ちになる');
});

test("onDisconnect = 'restart': 切断でゲームが破棄されて paused になり、戻ると新しい gi と seed で作り直される", () => {
  const fake = createFakeGameDefinition({ resultDelayMs: 100000 });
  const { host, events: hostEvents } = makeHost({ fake, onDisconnect: 'restart', seed: 777 });
  const a = connectGuest(host, { playerId: 'a', fake });
  const b = connectGuest(host, { playerId: 'b', fake });
  advance([host, a.guest, b.guest], 0, 50);

  host.startGame({}, 1000);
  advance([host, a.guest, b.guest], 1000, 1050);

  const giBeforePause = host.gi;
  const seedBeforePause = fake.instances.find((i) => i.role === 'host').seed;

  b.guestSide.close();
  advance([host, a.guest], 1050, 1100);

  assert.equal(host.phase, 'paused');
  assert.equal(a.guest.phase, 'paused', '残ったゲストも paused になる');
  assert.equal(hostEvents.paused, 1);
  const hostInstBeforePause = fake.instances.find((i) => i.role === 'host');
  assert.equal(hostInstBeforePause.disposed, true);

  // 遅れて届く「古いインスタンスあて」のゲームメッセージ(切断前の a の接続経由)は、
  // 新しいインスタンスに届いてはいけない。a の transport に直接、旧 gi のメッセージを注入して確かめる。
  const staleChannel = wrapChannel(a.guestSide);

  // b が戻る -> 新しい gi・seed で再生成される
  const [newHostSide, newGuestSide] = createLoopbackPair();
  host.acceptTransport(newHostSide);
  b.guest.replaceTransport(newGuestSide);
  advance([host, a.guest, b.guest], 1100, 1160);

  assert.equal(host.phase, 'inGame');
  assert.notEqual(host.gi, giBeforePause, '新しい gi');
  const hostInstAfterResume = fake.instances.filter((i) => i.role === 'host').at(-1);
  assert.notEqual(hostInstAfterResume.seed, seedBeforePause, '新しい seed');
  assert.equal(hostEvents.resumed, 1);

  staleChannel.game.send(giBeforePause, { t: 'stale' });
  advance([host, a.guest], 1160, 1180);
  const staleReceived = hostInstAfterResume.received.filter((r) => r.m && r.m.t === 'stale');
  assert.equal(staleReceived.length, 0, '古い gi のメッセージは新しいインスタンスに届かない');
});

test('ゲスト側の時刻同期が効いている(ctx.clock.hostNow がホストの時刻と 10ms 以内)', () => {
  const fake = createFakeGameDefinition({ resultDelayMs: 100000 });
  const { host } = makeHost({ fake });
  const [hostSide, guestSide] = createLoopbackPair({ latencyMs: 30 });
  host.acceptTransport(hostSide);
  const guest = createGuestFrame({
    definition: fake.definition,
    name: 'Guest',
    playerId: 'g-1',
    transport: guestSide,
    events: {},
  });

  // ping(1秒おき)が何度か行き来するまで進める
  advance([host, guest], 0, 5200, 20);

  host.startGame({}, 5200);
  advance([host, guest], 5200, 5250);

  const guestInst = fake.instances.find((i) => i.role === 'guest');
  const hostNowAtGuest = guestInst.ctx.clock.hostNow();
  assert.ok(Math.abs(hostNowAtGuest - 5250) <= 10, `誤差 10ms 以内のはず: ${hostNowAtGuest}`);
});
