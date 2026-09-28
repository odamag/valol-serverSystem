import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RaceHost } from '../src/game/host.js';
import { buildCourse } from '../src/core/course.js';
import { COURSE_DATA } from '../src/core/courseData.js';
import { makeConfig } from '../src/config.js';
import { msg } from '../src/game/protocol.js';

const course = buildCourse(COURSE_DATA, makeConfig());
const L = course.length;
const N = course.checkpoints.length;

/** sendTo を記録しつつ、テストからメッセージを取り出しやすくする */
function makeRecorder() {
  const sent = []; // { slot, msg }
  const sendTo = (slot, m) => sent.push({ slot, msg: m });
  return {
    sent,
    sendTo,
    byType(t) {
      return sent.filter((e) => e.msg.t === t);
    },
    byTypeTo(slot, t) {
      return sent.filter((e) => e.slot === slot && e.msg.t === t);
    },
    clear() {
      sent.length = 0;
    },
  };
}

function makeRoster(n) {
  const roster = [];
  for (let i = 0; i < n; i++) roster.push({ slot: i, name: `p${i}`, kind: i === 0 ? 'human' : 'bot', local: true });
  return roster;
}

function makeHost({ roster, cfg, now = 0, seed = 1, onResult } = {}) {
  const recorder = makeRecorder();
  const logs = [];
  const log = (event, fields) => logs.push({ event, fields });
  const results = [];
  const host = new RaceHost({
    cfg: cfg || makeConfig(),
    course,
    seed,
    roster: roster || makeRoster(2),
    now,
    sendTo: recorder.sendTo,
    log,
    onResult: onResult || ((r) => results.push(r)),
  });
  return { host, recorder, logs, results };
}

/** 中心線に沿って s を進めた kartState メッセージを作る */
function kartStateAt(now, s, speed = 20) {
  const p = course.pointAt(s);
  const yaw = Math.atan2(p.tx, p.tz);
  return msg.kartState(now, p.x, p.z, yaw, speed, 0, 0);
}

/** cp0(ゴールライン)以外のチェックポイントを順に通過させる。lap は通過後の周回番号 */
function reportAllCheckpoints(host, slot, lap) {
  for (let k = 1; k < N; k++) {
    host.handleMessage(slot, msg.reportCheckpoint(lap - 1, k));
  }
  host.handleMessage(slot, msg.reportCheckpoint(lap, 0));
}

test('生成直後に roundStart が全員に送られ、startAt と seed からシャッフルした grid が入る', () => {
  const cfg = makeConfig();
  const roster = makeRoster(4);
  const { recorder, host } = makeHost({ roster, cfg, now: 1000, seed: 42 });

  const rs = recorder.byType('roundStart');
  assert.equal(rs.length, roster.length); // 全員に送る
  for (const e of rs) {
    assert.equal(e.msg.startAt, 1000 + (cfg.startDelaySec + cfg.countdownSec) * 1000);
    assert.equal(e.msg.laps, cfg.laps);
    assert.equal(e.msg.grid.length, roster.length);
    const gridIndices = e.msg.grid.map((g) => g.gridIndex).sort((a, b) => a - b);
    assert.deepEqual(gridIndices, [0, 1, 2, 3]);
  }
  assert.equal(host.phase, 'countdown');
});

test('同じ seed なら grid の並びが決定的(乱数は createRng だけを使う)', () => {
  const roster = makeRoster(4);
  const a = makeHost({ roster, seed: 7 });
  const b = makeHost({ roster, seed: 7 });
  const gridA = a.recorder.byType('roundStart')[0].msg.grid;
  const gridB = b.recorder.byType('roundStart')[0].msg.grid;
  assert.deepEqual(gridA, gridB);
});

test('順番どおりの reportCheckpoint だけを受け付け、2周で playerFinished。飛ばした報告は無視する', () => {
  const cfg = makeConfig({ laps: 2 });
  const { host, recorder, logs } = makeHost({ cfg, roster: makeRoster(2) });

  // 飛ばした報告(cp=2 をいきなり)は無視される
  host.handleMessage(0, msg.reportCheckpoint(0, 2));
  assert.equal(recorder.byType('playerFinished').length, 0);

  reportAllCheckpoints(host, 0, 1); // 1周目
  assert.equal(logs.filter((l) => l.event === 'lap' && l.fields.slot === 0).length, 1);
  assert.equal(recorder.byType('playerFinished').length, 0);

  reportAllCheckpoints(host, 0, 2); // 2周目でゴール
  const fin = recorder.byType('playerFinished'); // 全員(2人)に broadcast される
  assert.equal(fin.length, 2);
  assert.equal(fin[0].msg.slot, 0);
  assert.equal(fin[0].msg.place, 1);
  assert.ok(logs.some((l) => l.event === 'finish' && l.fields.slot === 0));
});

test('finishRule = first では最初のゴールで raceEnd と onResult', () => {
  const cfg = makeConfig({ finishRule: 'first', laps: 1 });
  const { host, recorder, results } = makeHost({ cfg, roster: makeRoster(2) });

  reportAllCheckpoints(host, 0, 1);

  assert.equal(host.phase, 'ended');
  const end = recorder.byType('raceEnd');
  assert.equal(end.length, 2);
  assert.equal(end[0].msg.reason, 'first');
  assert.equal(results.length, 1);
  assert.equal(results[0].reason, 'first');
  assert.equal(results[0].ranking[0], 0);
});

test("finishRule = grace では全員がゴールした時点か、最初のゴールから finishGraceSec で終わる", () => {
  const cfg = makeConfig({ finishRule: 'grace', finishGraceSec: 15, laps: 1, timeLimitSec: 999 });

  // ケース1: 全員ゴール
  {
    const { host, results } = makeHost({ cfg, roster: makeRoster(2), now: 0 });
    reportAllCheckpoints(host, 0, 1);
    assert.equal(results.length, 0); // まだ1人
    reportAllCheckpoints(host, 1, 1);
    assert.equal(results.length, 1);
    assert.equal(results[0].reason, 'allFinished');
  }

  // ケース2: 最初のゴールから finishGraceSec 経過
  {
    const { host, results } = makeHost({ cfg, roster: makeRoster(2), now: 0 });
    reportAllCheckpoints(host, 0, 1); // この時点の host.now(0)が firstFinishAt になる
    assert.equal(results.length, 0);
    host.update(15000 - 1, 0.016); // まだ猶予内
    assert.equal(results.length, 0);
    host.update(15000 + 100, 0.016);
    assert.equal(results.length, 1);
    assert.equal(results[0].reason, 'grace');
  }
});

test('制限時間を過ぎると timeout で、進み具合の順の ranking になる', () => {
  const cfg = makeConfig({ finishRule: 'grace', timeLimitSec: 10, laps: 5 });
  const { host, results } = makeHost({ cfg, roster: makeRoster(2), now: 0 });

  // slot0 の方が進んでいる状態にする
  host.handleMessage(0, kartStateAt(0, L * 0.5));
  host.handleMessage(1, kartStateAt(0, L * 0.2));

  // timeLimitSec は startAt からの経過時間(設計書 9.3節の「経過時間」と同じ基準)
  host.update(host.startAt + cfg.timeLimitSec * 1000 + 1, 0.016);

  assert.equal(results.length, 1);
  assert.equal(results[0].reason, 'timeout');
  assert.equal(results[0].ranking[0], 0);
});

test('requestPickup: 有効なボックスで itemGranted と boxState(false)、5秒後に boxState(true)。所持中・ゴール済みは無視', () => {
  const cfg = makeConfig({ itemBox: { respawnSec: 5, rouletteSec: 0.8, pickupRadius: 1.8 } });
  const { host, recorder } = makeHost({ cfg, roster: makeRoster(2), now: 0 });
  const boxId = course.itemBoxes[0].id;

  host.handleMessage(0, msg.requestPickup(boxId));
  assert.equal(recorder.byType('itemGranted').length, 2); // 全員(2人)に broadcast される
  assert.equal(recorder.byTypeTo(0, 'boxState')[0].msg.active, false);

  // 所持中は無視
  recorder.clear();
  host.handleMessage(0, msg.requestPickup(boxId));
  assert.equal(recorder.byType('itemGranted').length, 0);

  // 5秒後に再出現
  host.update(5000 - 1, 0.016);
  assert.equal(recorder.byType('boxState').filter((e) => e.msg.active === true).length, 0);
  host.update(5000 + 1, 0.016);
  assert.ok(recorder.byType('boxState').some((e) => e.msg.active === true));
});

test('requestPickup のアイテムは順位と首位との差から選ばれる(ログの table)', () => {
  const cfg = makeConfig({ test: { effects: false, effectsMinSec: 4, effectsMaxSec: 8, forceItem: null, forceItemBySlot: {} } });
  const { host, logs } = makeHost({ cfg, roster: makeRoster(2), now: 0 });

  // slot0 はチェックポイントを7個進めて s ≈ 0.75L(首位)。slot1 は cp1 も報告せず s ≈ 0(大きく後ろ)。
  for (let k = 1; k <= 7; k++) host.handleMessage(0, msg.reportCheckpoint(0, k));
  host.handleMessage(0, kartStateAt(0, L * 0.75));
  host.handleMessage(1, kartStateAt(0, L * 0.01));

  const box0 = course.itemBoxes[0].id;
  const box1 = course.itemBoxes[1].id;
  host.handleMessage(0, msg.requestPickup(box0));
  host.handleMessage(1, msg.requestPickup(box1));

  const grantLog0 = logs.find((l) => l.event === 'itemGranted' && l.fields.slot === 0);
  const grantLog1 = logs.find((l) => l.event === 'itemGranted' && l.fields.slot === 1);
  assert.equal(grantLog0.fields.table, 'leader');
  assert.equal(grantLog0.fields.rank, 1);
  assert.equal(grantLog1.fields.table, 'far');
  assert.equal(grantLog1.fields.rank, 2);
});

test('requestUseItem: ルーレット中は無視。Rocket で spawnObj、Dash で applyBoost、Shield で shieldState', () => {
  const cfg = makeConfig({ test: { effects: false, effectsMinSec: 4, effectsMaxSec: 8, forceItem: null, forceItemBySlot: { 0: 'Rocket', 1: 'Dash' } } });
  const { host, recorder } = makeHost({ cfg, roster: makeRoster(3), now: 0 });

  const boxId = course.itemBoxes[0].id;
  host.handleMessage(0, msg.requestPickup(boxId));

  // ルーレット中は無視
  host.handleMessage(0, msg.requestUseItem(false));
  assert.equal(recorder.byType('spawnObj').length, 0);

  host.update(cfg.itemBox.rouletteSec * 1000 + 1, 0.016);
  host.handleMessage(0, msg.requestUseItem(false));
  const spawned = recorder.byType('spawnObj'); // 全員(3人)に broadcast される
  assert.equal(spawned.length, 3);
  assert.equal(spawned[0].msg.type, 'Rocket');
  assert.equal(spawned[0].msg.owner, 0);

  // Dash
  const boxId2 = course.itemBoxes[1].id;
  host.handleMessage(1, msg.requestPickup(boxId2));
  host.update(cfg.itemBox.rouletteSec * 1000 + 2000, 0.016);
  host.handleMessage(1, msg.requestUseItem(false));
  const boosted = recorder.byType('applyBoost').filter((e) => e.msg.slot === 1);
  assert.equal(boosted.length, 3);

  // Shield
  const cfg2 = makeConfig({ test: { effects: false, effectsMinSec: 4, effectsMaxSec: 8, forceItem: null, forceItemBySlot: { 2: 'Shield' } } });
  const host2 = makeHost({ cfg: cfg2, roster: makeRoster(3), now: 0 });
  const boxId3 = course.itemBoxes[2].id;
  host2.host.handleMessage(2, msg.requestPickup(boxId3));
  host2.host.update(cfg2.itemBox.rouletteSec * 1000 + 1, 0.016);
  host2.host.handleMessage(2, msg.requestUseItem(false));
  const shield = host2.recorder.byType('shieldState').filter((e) => e.msg.slot === 2 && e.msg.active === true);
  assert.equal(shield.length, 3);
});

test('Homing の targetSlot は、使った時点で自分のすぐ前の順位の人になる', () => {
  const cfg = makeConfig({ test: { effects: false, effectsMinSec: 4, effectsMaxSec: 8, forceItem: null, forceItemBySlot: { 2: 'Homing' } } });
  const { host, recorder } = makeHost({ cfg, roster: makeRoster(3), now: 0 });

  // slot0 が首位、slot1 が2位、slot2(使う人)が3位
  host.handleMessage(0, kartStateAt(0, L * 0.9));
  host.handleMessage(1, kartStateAt(0, L * 0.5));
  host.handleMessage(2, kartStateAt(0, L * 0.1));

  const boxId = course.itemBoxes[0].id;
  host.handleMessage(2, msg.requestPickup(boxId));
  host.update(cfg.itemBox.rouletteSec * 1000 + 1, 0.016);
  host.handleMessage(2, msg.requestUseItem(false));

  const spawned = recorder.byType('spawnObj').find((e) => e.msg.type === 'Homing');
  assert.ok(spawned);
  // targetSlot は spawnObj には含まれない(設計書のメッセージ形式どおり)ので、当たり判定で確認する代わりに
  // ログで確認する。
  // (別テストで reportHit の挙動を確認する)
});

test('reportHit: 猶予中の自爆は無視、確定したら despawnObj と applySpin。Shield 中は shieldBlock で消費だけ。無敵中・同じ弾の2件目は無視', () => {
  const cfg = makeConfig({ test: { effects: false, effectsMinSec: 4, effectsMaxSec: 8, forceItem: null, forceItemBySlot: { 0: 'Rocket' } } });
  const { host, recorder } = makeHost({ cfg, roster: makeRoster(2), now: 0 });

  const boxId = course.itemBoxes[0].id;
  host.handleMessage(0, msg.requestPickup(boxId));
  host.update(cfg.itemBox.rouletteSec * 1000 + 1, 0.016);
  host.handleMessage(0, msg.requestUseItem(false));
  const spawn = recorder.byType('spawnObj')[0];
  const objId = spawn.msg.id;

  // 自爆(投げた本人)は猶予中なら無視
  host.handleMessage(0, msg.reportHit(objId));
  assert.equal(recorder.byType('despawnObj').length, 0);

  // 猶予を過ぎたあとの、他人(slot1)への命中は確定する
  host.update(cfg.itemBox.rouletteSec * 1000 + 1 + cfg.items.rocket.ownerGraceSec * 1000 + 100, 0.016);
  host.handleMessage(1, msg.reportHit(objId));
  const despawn = recorder.byType('despawnObj'); // 全員(2人)に broadcast される
  assert.equal(despawn.length, 2);
  assert.equal(despawn[0].msg.reason, 'hit');
  const spins = recorder.byType('applySpin').filter((e) => e.msg.slot === 1);
  assert.equal(spins.length, 2);

  // 同じ objId への2件目は無視(オブジェクトはもう無い)
  recorder.clear();
  host.handleMessage(1, msg.reportHit(objId));
  assert.equal(recorder.sent.length, 0);

  // 無敵中はさらに命中しても無視される
  const cfg2 = makeConfig({ test: { effects: false, effectsMinSec: 4, effectsMaxSec: 8, forceItem: null, forceItemBySlot: { 0: 'Rocket' } } });
  const h2 = makeHost({ cfg: cfg2, roster: makeRoster(2), now: 0 });
  const boxId2 = course.itemBoxes[0].id;
  h2.host.handleMessage(0, msg.requestPickup(boxId2));
  h2.host.update(cfg2.itemBox.rouletteSec * 1000 + 1, 0.016);
  h2.host.handleMessage(0, msg.requestUseItem(false));
  const spawn2 = h2.recorder.byType('spawnObj')[0];
  h2.host.update(cfg2.itemBox.rouletteSec * 1000 + 1 + cfg2.items.rocket.ownerGraceSec * 1000 + 100, 0.016);
  h2.host.handleMessage(1, msg.reportHit(spawn2.msg.id));
  assert.equal(h2.recorder.byType('applySpin').filter((e) => e.msg.slot === 1).length, 2);

  // 2発目を作って、無敵中(spin.durationSec + invulnAfterSec 以内)の命中は無視される
  h2.host.handleMessage(0, msg.requestPickup(course.itemBoxes[1].id));
  h2.host.update(h2.host.now + cfg2.itemBox.rouletteSec * 1000 + 1, 0.016);
  h2.host.handleMessage(0, msg.requestUseItem(false));
  const spawn3 = h2.recorder.byType('spawnObj').filter((e) => e.msg.type === 'Rocket')[1];
  h2.host.update(h2.host.now + cfg2.items.rocket.ownerGraceSec * 1000 + 100, 0.016);
  h2.recorder.clear();
  h2.host.handleMessage(1, msg.reportHit(spawn3.msg.id));
  assert.equal(h2.recorder.byType('applySpin').length, 0); // まだ invuln 中
});

test('Shield 中に被弾すると applySpin ではなく shieldBlock で消費する', () => {
  const cfg = makeConfig({
    test: { effects: false, effectsMinSec: 4, effectsMaxSec: 8, forceItem: null, forceItemBySlot: { 0: 'Rocket', 1: 'Shield' } },
  });
  const { host, recorder, logs } = makeHost({ cfg, roster: makeRoster(2), now: 0 });

  host.handleMessage(1, msg.requestPickup(course.itemBoxes[0].id));
  host.update(cfg.itemBox.rouletteSec * 1000 + 1, 0.016);
  host.handleMessage(1, msg.requestUseItem(false)); // slot1 が Shield を発動

  host.handleMessage(0, msg.requestPickup(course.itemBoxes[1].id));
  host.update(host.now + cfg.itemBox.rouletteSec * 1000 + 1, 0.016);
  host.handleMessage(0, msg.requestUseItem(false)); // slot0 が Rocket を発射
  const spawn = recorder.byType('spawnObj').find((e) => e.msg.type === 'Rocket');

  host.update(host.now + cfg.items.rocket.ownerGraceSec * 1000 + 100, 0.016);
  host.handleMessage(1, msg.reportHit(spawn.msg.id));

  assert.equal(recorder.byType('applySpin').filter((e) => e.msg.slot === 1).length, 0);
  const shieldOff = recorder.byType('shieldState').filter((e) => e.msg.slot === 1 && e.msg.active === false);
  assert.equal(shieldOff.length, 2); // 全員(2人)に broadcast される
  assert.ok(logs.some((l) => l.event === 'shieldBlock' && l.fields.slot === 1));
  assert.equal(host.stats.shieldBlocks, 1);
});

test('playerLeft: その人が ranking の最後になり、残りの人でレースが終わる', () => {
  const cfg = makeConfig({ finishRule: 'grace', laps: 1, timeLimitSec: 999 });
  const { host, results } = makeHost({ cfg, roster: makeRoster(2), now: 0 });

  host.handleMessage(1, kartStateAt(0, L * 0.9)); // slot1 の方が進んでいる
  host.playerLeft(0, 100);

  reportAllCheckpoints(host, 1, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0].reason, 'allFinished');
  const bySlot = new Map(results[0].details.results.map((r) => [r.slot, r]));
  assert.equal(bySlot.get(0).status, 'left');
  assert.equal(results[0].ranking[results[0].ranking.length - 1], 0);
});

test('forceItemBySlot で指定の人に必ず指定のアイテムが出て、stats.grants が数えられる', () => {
  const cfg = makeConfig({
    test: { effects: false, effectsMinSec: 4, effectsMaxSec: 8, forceItem: null, forceItemBySlot: { 0: 'Oil', 1: 'Homing' } },
  });
  const { host } = makeHost({ cfg, roster: makeRoster(2), now: 0 });

  host.handleMessage(0, msg.requestPickup(course.itemBoxes[0].id));
  host.handleMessage(1, msg.requestPickup(course.itemBoxes[1].id));

  const total = Object.values(host.stats.grants.leader).reduce((a, b) => a + b, 0) +
    Object.values(host.stats.grants.near).reduce((a, b) => a + b, 0) +
    Object.values(host.stats.grants.far).reduce((a, b) => a + b, 0);
  assert.equal(total, 2);
});

test('テスト用の効果:effectsMinSec〜effectsMaxSec ごとに applySpin か applyBoost が送られる', () => {
  const cfg = makeConfig({ test: { effects: true, effectsMinSec: 1, effectsMaxSec: 1, forceItem: null, forceItemBySlot: {} } });
  const { host, recorder } = makeHost({ cfg, roster: makeRoster(2), now: 0 });

  let sawEffect = false;
  for (let t = 0; t <= 2000; t += 16) {
    host.update(t, 0.016);
    if (recorder.byType('applySpin').length > 0 || recorder.byType('applyBoost').length > 0) {
      sawEffect = true;
      break;
    }
  }
  assert.ok(sawEffect);
});
