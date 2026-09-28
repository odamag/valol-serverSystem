import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FRAME_VERSION, FRAME_MSG, msg } from '../frame/protocol.js';

test('FRAME_VERSION は 1', () => {
  assert.equal(FRAME_VERSION, 1);
});

test('FRAME_MSG のすべての値が msg.<t名> で作れて、t が一致する', () => {
  const expected = {
    HELLO: 'hello',
    PING: 'ping',
    LEAVE: 'leave',
    WELCOME: 'welcome',
    REJECT: 'reject',
    PONG: 'pong',
    ROSTER: 'roster',
    START_GAME: 'startGame',
    PLAYER_LEFT: 'playerLeft',
    END_GAME: 'endGame',
    PAUSED: 'paused',
    RESUMED: 'resumed',
  };
  assert.deepEqual(FRAME_MSG, expected);

  for (const t of Object.values(FRAME_MSG)) {
    assert.equal(typeof msg[t], 'function', `msg.${t} が関数でない`);
  }
});

test('hello(playerId, name) は v, playerId, name を持つ', () => {
  const m = msg.hello('p1', 'たろう');
  assert.equal(m.t, 'hello');
  assert.equal(m.v, FRAME_VERSION);
  assert.equal(m.playerId, 'p1');
  assert.equal(m.name, 'たろう');
});

test('ping(c) は c を持つ', () => {
  const m = msg.ping(1234);
  assert.equal(m.t, 'ping');
  assert.equal(m.c, 1234);
});

test('leave() は t だけ持つ', () => {
  const m = msg.leave();
  assert.deepEqual(m, { t: 'leave' });
});

test('welcome(slot, roster, phase)', () => {
  const roster = [{ slot: 0, name: 'a' }];
  const m = msg.welcome(2, roster, 'lobby');
  assert.equal(m.t, 'welcome');
  assert.equal(m.slot, 2);
  assert.equal(m.roster, roster);
  assert.equal(m.phase, 'lobby');
});

test('reject(reason)', () => {
  assert.equal(msg.reject('full').reason, 'full');
  assert.equal(msg.reject('version').reason, 'version');
});

test('pong(c, h)', () => {
  const m = msg.pong(100, 250);
  assert.equal(m.t, 'pong');
  assert.equal(m.c, 100);
  assert.equal(m.h, 250);
});

test('roster(players)', () => {
  const players = [{ slot: 0, name: 'a', kind: 'human', connected: true, waiting: false }];
  const m = msg.roster(players);
  assert.equal(m.t, 'roster');
  assert.equal(m.players, players);
});

test('startGame(gi, gameId, seed, roster, settings)', () => {
  const roster = [{ slot: 0 }];
  const settings = { laps: 2 };
  const m = msg.startGame(1, 'MG01', 999, roster, settings);
  assert.equal(m.t, 'startGame');
  assert.equal(m.gi, 1);
  assert.equal(m.gameId, 'MG01');
  assert.equal(m.seed, 999);
  assert.equal(m.roster, roster);
  assert.equal(m.settings, settings);
});

test('playerLeft(gi, slot)', () => {
  const m = msg.playerLeft(3, 5);
  assert.equal(m.t, 'playerLeft');
  assert.equal(m.gi, 3);
  assert.equal(m.slot, 5);
});

test('endGame(gi, result)', () => {
  const result = { ranking: [0, 1] };
  const m = msg.endGame(4, result);
  assert.equal(m.t, 'endGame');
  assert.equal(m.gi, 4);
  assert.equal(m.result, result);
});

test('paused() / resumed() は t だけ持つ', () => {
  assert.deepEqual(msg.paused(), { t: 'paused' });
  assert.deepEqual(msg.resumed(), { t: 'resumed' });
});

test('すべてのメッセージが JSON にできる(関数やundefinedを含まない)', () => {
  const samples = [
    msg.hello('p', 'n'),
    msg.ping(1),
    msg.leave(),
    msg.welcome(0, [], 'lobby'),
    msg.reject('full'),
    msg.pong(1, 2),
    msg.roster([]),
    msg.startGame(1, 'MG01', 1, [], {}),
    msg.playerLeft(1, 0),
    msg.endGame(1, {}),
    msg.paused(),
    msg.resumed(),
  ];
  for (const s of samples) {
    const json = JSON.stringify(s);
    const parsed = JSON.parse(json);
    assert.deepEqual(parsed, s);
  }
});
