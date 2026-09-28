import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MSG, msg } from '../src/game/protocol.js';

test('MSG のすべての値が msg.<t名> で作れて、t が一致する', () => {
  const expected = {
    KART_STATE: 'kartState',
    REPORT_CHECKPOINT: 'reportCheckpoint',
    REQUEST_PICKUP: 'requestPickup',
    REQUEST_USE_ITEM: 'requestUseItem',
    REPORT_HIT: 'reportHit',
    ROUND_START: 'roundStart',
    KARTS: 'karts',
    PROGRESS: 'progress',
    BOX_STATE: 'boxState',
    ITEM_GRANTED: 'itemGranted',
    ITEM_CLEARED: 'itemCleared',
    SPAWN_OBJ: 'spawnObj',
    OBJ_STATE: 'objState',
    DESPAWN_OBJ: 'despawnObj',
    APPLY_SPIN: 'applySpin',
    APPLY_BOOST: 'applyBoost',
    SHIELD_STATE: 'shieldState',
    PLAYER_FINISHED: 'playerFinished',
    RACE_END: 'raceEnd',
  };
  assert.deepEqual(MSG, expected);

  for (const t of Object.values(MSG)) {
    assert.equal(typeof msg[t], 'function', `msg.${t} が関数でない`);
    const created = msg[t](...defaultArgsFor(t));
    assert.equal(created.t, t);
  }
});

// 各メッセージ作成関数を適当な引数で呼ぶためのダミー引数(数だけ合わせる)
function defaultArgsFor(t) {
  switch (t) {
    case 'kartState':
      return [0, 0, 0, 0, 0, 0, 0];
    case 'reportCheckpoint':
      return [1, 2];
    case 'requestPickup':
      return [3];
    case 'requestUseItem':
      return [false];
    case 'reportHit':
      return [7];
    case 'roundStart':
      return [1000, 2, []];
    case 'karts':
      return [1000, []];
    case 'progress':
      return [1000, []];
    case 'boxState':
      return [1, true];
    case 'itemGranted':
      return [0, 'Dash', 800];
    case 'itemCleared':
      return [0];
    case 'spawnObj':
      return [1, 'Rocket', 0, 0, 0, 0, true];
    case 'objState':
      return [1000, []];
    case 'despawnObj':
      return [1, 'expired'];
    case 'applySpin':
      return [0];
    case 'applyBoost':
      return [0, 2, 0.5];
    case 'shieldState':
      return [0, true];
    case 'playerFinished':
      return [0, 1, 60000];
    case 'raceEnd':
      return ['allFinished', []];
    default:
      throw new Error(`unhandled t: ${t}`);
  }
}

test('kartState(ts, x, z, yaw, speed, spinT, boostT)', () => {
  const m = msg.kartState(100, 1, 2, 3, 4, 5, 6);
  assert.deepEqual(m, { t: 'kartState', ts: 100, x: 1, z: 2, yaw: 3, speed: 4, spinT: 5, boostT: 6 });
});

test('reportCheckpoint(lap, cp)', () => {
  assert.deepEqual(msg.reportCheckpoint(1, 3), { t: 'reportCheckpoint', lap: 1, cp: 3 });
});

test('requestPickup(boxId)', () => {
  assert.deepEqual(msg.requestPickup(5), { t: 'requestPickup', boxId: 5 });
});

test('requestUseItem(backward)', () => {
  assert.deepEqual(msg.requestUseItem(true), { t: 'requestUseItem', backward: true });
});

test('reportHit(objId)', () => {
  assert.deepEqual(msg.reportHit(9), { t: 'reportHit', objId: 9 });
});

test('roundStart(startAt, laps, grid)', () => {
  const grid = [{ slot: 0, gridIndex: 0 }];
  const m = msg.roundStart(5000, 2, grid);
  assert.equal(m.t, 'roundStart');
  assert.equal(m.startAt, 5000);
  assert.equal(m.laps, 2);
  assert.equal(m.grid, grid);
});

test('karts(ts, list)', () => {
  const list = [{ slot: 0, x: 1, z: 2, yaw: 0, speed: 0, spinT: 0, boostT: 0, finished: false }];
  const m = msg.karts(1234, list);
  assert.equal(m.t, 'karts');
  assert.equal(m.ts, 1234);
  assert.equal(m.list, list);
});

test('progress(elapsedMs, players)', () => {
  const players = [{ slot: 0, lap: 1, nextCp: 2, rank: 1, gapRatio: 0, place: null }];
  const m = msg.progress(2000, players);
  assert.equal(m.t, 'progress');
  assert.equal(m.elapsedMs, 2000);
  assert.equal(m.players, players);
});

test('boxState(boxId, active)', () => {
  assert.deepEqual(msg.boxState(2, false), { t: 'boxState', boxId: 2, active: false });
});

test('itemGranted(slot, item, rouletteMs)', () => {
  assert.deepEqual(msg.itemGranted(1, 'Rocket', 800), { t: 'itemGranted', slot: 1, item: 'Rocket', rouletteMs: 800 });
});

test('itemCleared(slot)', () => {
  assert.deepEqual(msg.itemCleared(1), { t: 'itemCleared', slot: 1 });
});

test('spawnObj(id, type, owner, x, z, yaw, active)', () => {
  const m = msg.spawnObj(10, 'Homing', 2, 1, 2, 3, true);
  assert.deepEqual(m, { t: 'spawnObj', id: 10, type: 'Homing', owner: 2, x: 1, z: 2, yaw: 3, active: true });
});

test('objState(ts, objs)', () => {
  const objs = [{ id: 1, x: 0, z: 0, yaw: 0, active: true }];
  const m = msg.objState(999, objs);
  assert.equal(m.t, 'objState');
  assert.equal(m.ts, 999);
  assert.equal(m.objs, objs);
});

test('despawnObj(id, reason)', () => {
  assert.deepEqual(msg.despawnObj(1, 'hit'), { t: 'despawnObj', id: 1, reason: 'hit' });
});

test('applySpin(slot)', () => {
  assert.deepEqual(msg.applySpin(3), { t: 'applySpin', slot: 3 });
});

test('applyBoost(slot, durationSec, bonus)', () => {
  assert.deepEqual(msg.applyBoost(3, 2, 0.5), { t: 'applyBoost', slot: 3, durationSec: 2, bonus: 0.5 });
});

test('shieldState(slot, active)', () => {
  assert.deepEqual(msg.shieldState(4, true), { t: 'shieldState', slot: 4, active: true });
});

test('playerFinished(slot, place, timeMs)', () => {
  assert.deepEqual(msg.playerFinished(0, 1, 61234), { t: 'playerFinished', slot: 0, place: 1, timeMs: 61234 });
});

test('raceEnd(reason, results)', () => {
  const results = [{ slot: 0, place: 1, timeMs: 61234, status: 'finished' }];
  const m = msg.raceEnd('allFinished', results);
  assert.equal(m.t, 'raceEnd');
  assert.equal(m.reason, 'allFinished');
  assert.equal(m.results, results);
});

test('すべてのメッセージが JSON にできる', () => {
  for (const t of Object.values(MSG)) {
    const m = msg[t](...defaultArgsFor(t));
    const parsed = JSON.parse(JSON.stringify(m));
    assert.deepEqual(parsed, m);
  }
});
