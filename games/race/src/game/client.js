/**
 * RaceClient(各プレイヤーの端末側の処理。設計書 10.2節)。
 * 人間・ボット・ホストの中のプレイヤーのどれでも同じコードで動く(設計書 9.1節)。
 * DOM・three・Date.now・Math.random には触れない(設計書 2.2節)。時刻はすべて引数(ホスト時刻 now, ms)で受け取る。
 */

import { clamp } from '../core/math.js';
import { createKartState, stepKart, applySpin, applyBoost } from '../core/kart.js';
import { createProgress, updateProgress } from '../core/progress.js';
import { isHit } from '../core/projectiles.js';
import { createAutopilot, botInput } from '../core/autopilot.js';
import { createSnapshotBuffer } from './interp.js';
import { msg } from './protocol.js';
import { createRng } from '../../../_shared/core/rng.js';

/**
 * @typedef {object} RenderView
 * @property {'countdown'|'racing'|'finished'|'ended'} phase
 * @property {number|null} countdown
 * @property {boolean} lookBack
 * @property {object|null} self
 * @property {Array<object>} others
 * @property {Array<object>} objects
 * @property {boolean[]} boxes
 * @property {object} hud
 */

export class RaceClient {
  /**
   * @param {object} params
   * @param {number} params.slot
   * @param {object} params.cfg makeConfig() が返す設定
   * @param {import('../core/course.js').Course} params.course
   * @param {Array<{slot:number, name:string, kind:string, local:boolean}>} params.roster
   * @param {(msg:object) => void} params.send
   * @param {'human'|'bot'} params.controller
   * @param {number} params.seed
   * @param {(event:string, fields?:object) => void} [params.log]
   */
  constructor({ slot, cfg, course, roster, send, controller, seed, log }) {
    this.slot = slot;
    this.cfg = cfg;
    this.course = course;
    this.roster = roster;
    this.send = send;
    this.controller = controller;
    this.log = log || (() => {});

    this.rosterBySlot = new Map(roster.map((p) => [p.slot, p]));

    // ボットは human/bot どちらのときも使う(ゴール後は human でも autopilot に切り替える。設計書 10.2節)。
    const rng = createRng(seed);
    this.bot = createAutopilot(rng.fork(), cfg);

    // roundStart を受け取るまではカートを置かない(設計書 10.2節)。
    this.startAt = null;
    this.laps = cfg.laps;
    this.grid = null;
    this.kart = null;
    this.progress = null;

    /** handleMessage は now を受け取らない(設計書どおり)ので、直近の update(now) を覚えておいて使う。判断して決めた点 */
    this._now = 0;

    // ほかのプレイヤーのカートのスナップショット補間バッファ(設計書 9.5節)。1台につき1つ。
    this.others = new Map();
    for (const p of roster) {
      if (p.slot === slot) continue;
      this.others.set(p.slot, { buffer: createSnapshotBuffer({ extrapolateMaxMs: cfg.net.extrapolateMaxMs }) });
    }
    this.leftSlots = new Set();
    this.finishedSlots = new Set(); // 自分以外が playerFinished で報告された slot
    this.shieldBySlot = new Map();

    // 弾・油。1個ごとに1つの補間バッファ(設計書 9.5節)。
    this.objects = new Map(); // id -> { type, owner, buffer }
    this.reportedHit = new Set();

    // アイテムボックス
    this.boxIds = course.itemBoxes.map((b) => b.id).sort((a, b) => a - b);
    this.boxActive = new Map(course.itemBoxes.map((b) => [b.id, true]));
    this.boxWorld = new Map(course.itemBoxes.map((b) => [b.id, course.toWorld(b.s, b.lateral)]));
    this.pickupSent = new Set();

    this.insidePads = new Set(); // ブーストパッドに「入っている」判定の立ち上がり検出用

    this.heldItem = null; // { item, rouletteMs, readyAt }
    this.itemUsePending = false; // itemCleared/新しい itemGranted まで requestUseItem を二重に送らない

    this.finished = false;
    this.finishInfo = null; // { place, timeMs }
    this.raceEnded = false;
    this._firstFinishAtNow = null;

    this.hostProgress = null; // 直近の progress メッセージ
    this.progressBySlot = null;

    this._sendAccum = 0;
    this._lookBack = false;
  }

  // ---- ホストからのメッセージ(設計書 9.2節) ----

  /** @param {object} m */
  handleMessage(m) {
    switch (m.t) {
      case 'roundStart':
        this._onRoundStart(m);
        break;
      case 'karts':
        this._onKarts(m);
        break;
      case 'progress':
        this._onProgress(m);
        break;
      case 'boxState':
        this._onBoxState(m);
        break;
      case 'itemGranted':
        this._onItemGranted(m);
        break;
      case 'itemCleared':
        this._onItemCleared(m);
        break;
      case 'spawnObj':
        this._onSpawnObj(m);
        break;
      case 'objState':
        this._onObjState(m);
        break;
      case 'despawnObj':
        this._onDespawnObj(m);
        break;
      case 'applySpin':
        this._onApplySpin(m);
        break;
      case 'applyBoost':
        this._onApplyBoost(m);
        break;
      case 'shieldState':
        this._onShieldState(m);
        break;
      case 'playerFinished':
        this._onPlayerFinished(m);
        break;
      case 'raceEnd':
        this._onRaceEnd(m);
        break;
      default:
        break;
    }
  }

  _onRoundStart(m) {
    this.startAt = m.startAt;
    this.laps = m.laps;
    this.grid = m.grid;
    if (!this.kart) {
      const entry = m.grid.find((g) => g.slot === this.slot);
      if (entry) {
        const pose = this.course.gridPose(entry.gridIndex);
        this.kart = createKartState(pose, this.course);
        this.progress = createProgress(this.course, this.kart.s);
      }
    }
    this.log('roundStart', { slot: this.slot, startAt: m.startAt, laps: m.laps });
  }

  _onKarts(m) {
    for (const e of m.list) {
      if (e.slot === this.slot) continue; // 自分の分は無視する(設計書 9.2節)
      let entry = this.others.get(e.slot);
      if (!entry) {
        entry = { buffer: createSnapshotBuffer({ extrapolateMaxMs: this.cfg.net.extrapolateMaxMs }) };
        this.others.set(e.slot, entry);
      }
      entry.buffer.push({
        ts: m.ts,
        x: e.x,
        z: e.z,
        yaw: e.yaw,
        speed: e.speed,
        spinT: e.spinT,
        boostT: e.boostT,
        finished: e.finished,
      });
    }
  }

  _onProgress(m) {
    this.hostProgress = m;
    this.progressBySlot = new Map(m.players.map((p) => [p.slot, p]));
  }

  _onBoxState(m) {
    this.boxActive.set(m.boxId, m.active);
    if (m.active) this.pickupSent.delete(m.boxId); // 再出現したので、また requestPickup を送れるようにする
  }

  _onItemGranted(m) {
    if (m.slot !== this.slot) return; // ほかの人あては演出用(RenderView には持ち物を出さないので今は使わない)
    this.heldItem = { item: m.item, rouletteMs: m.rouletteMs, readyAt: this._now + m.rouletteMs };
    this.itemUsePending = false;
  }

  _onItemCleared(m) {
    if (m.slot !== this.slot) return;
    this.heldItem = null;
    this.itemUsePending = false;
  }

  _onSpawnObj(m) {
    const buffer = createSnapshotBuffer({ extrapolateMaxMs: this.cfg.net.extrapolateMaxMs });
    buffer.push({ ts: this._now, x: m.x, z: m.z, yaw: m.yaw, active: m.active });
    this.objects.set(m.id, { type: m.type, owner: m.owner, buffer });
  }

  _onObjState(m) {
    for (const o of m.objs) {
      let entry = this.objects.get(o.id);
      if (!entry) {
        // spawnObj より先に objState が届くことは想定していないが、念のため受け皿を作る
        entry = { type: null, owner: null, buffer: createSnapshotBuffer({ extrapolateMaxMs: this.cfg.net.extrapolateMaxMs }) };
        this.objects.set(o.id, entry);
      }
      entry.buffer.push({ ts: m.ts, x: o.x, z: o.z, yaw: o.yaw, active: o.active });
    }
  }

  _onDespawnObj(m) {
    this.objects.delete(m.id);
    this.reportedHit.delete(m.id);
  }

  _onApplySpin(m) {
    // スピンの適用は「オーナー(そのカートを動かしている端末)が行う」(設計書 6.3節)。
    // 自分あてなら物理を実際に回す。ほかの人あては演出だけ(その人自身の kartState の spinT から見た目を作る)。
    if (m.slot !== this.slot || !this.kart) return;
    const applied = applySpin(this.kart, this.cfg);
    if (applied) this.log('spin', { slot: this.slot });
  }

  _onApplyBoost(m) {
    if (m.slot !== this.slot || !this.kart) return;
    applyBoost(this.kart, m.durationSec, m.bonus);
    this.log('boost', { slot: this.slot, durationSec: m.durationSec, bonus: m.bonus, source: 'item' });
  }

  _onShieldState(m) {
    this.shieldBySlot.set(m.slot, m.active);
  }

  _onPlayerFinished(m) {
    if (this._firstFinishAtNow == null) this._firstFinishAtNow = this._now;
    if (m.slot === this.slot) {
      this.finished = true;
      this.finishInfo = { place: m.place, timeMs: m.timeMs };
      this.log('finish', { slot: this.slot, place: m.place, timeMs: m.timeMs });
    } else {
      this.finishedSlots.add(m.slot);
    }
  }

  _onRaceEnd(m) {
    this.raceEnded = true;
    this.raceEndInfo = m;
  }

  /**
   * プレイヤーが抜けたときに枠から呼ばれる(設計書 9.4節)。そのカートを消す。
   * @param {number} slot
   */
  playerLeft(slot) {
    this.leftSlots.add(slot);
    this.others.delete(slot);
    this.finishedSlots.delete(slot);
    this.log('playerLeft', { slot });
  }

  // ---- 毎フレーム(設計書 10.2節) ----

  /**
   * @param {number} now ホスト時刻(ms)
   * @param {number} dt 秒
   * @param {{throttle:number, steer:number, useItem:boolean, backward:boolean, lookBack:boolean}} [input] human のときだけ使う
   */
  update(now, dt, input) {
    this._now = now;
    if (!this.kart) return; // roundStart をまだ受け取っていない

    const cfg = this.cfg;
    const course = this.course;
    const gated = now < this.startAt; // 共通入力ゲート(設計書 9.3節)
    const renderTs = now - cfg.net.interpDelayMs;

    // 補間したほかのプレイヤーのうち、ゴール・離脱していない人の位置(env.others と当たり判定の元)
    const otherPositions = this._otherPositions(renderTs);

    let effInput = { throttle: 0, steer: 0 };
    let maxSpeedMul = 1;
    let useItem = false;
    let backward = false;
    let usingBot = false;

    if (this.finished) {
      // ゴール済みならコントローラーを autopilot に切り替えて流す(設計書 10.2節1)
      usingBot = true;
      maxSpeedMul = cfg.finished.maxSpeedMul;
    } else if (gated) {
      maxSpeedMul = this.controller === 'bot' ? this.bot.speedMul : 1;
    } else if (this.controller === 'bot') {
      usingBot = true;
      maxSpeedMul = this.bot.speedMul;
    } else {
      const inp = input || {};
      effInput = { throttle: inp.throttle || 0, steer: inp.steer || 0 };
      this._lookBack = !!inp.lookBack;
      useItem = !!inp.useItem;
      // backward = input.backward || input.lookBack(設計書 8.3節)
      backward = !!(inp.backward || inp.lookBack);
    }

    if (usingBot) {
      const ctx = this._botCtx(renderTs);
      const out = botInput(this.bot, this.kart, course, ctx, dt);
      effInput = { throttle: out.throttle, steer: out.steer };
      if (!this.finished) {
        useItem = out.useItem;
        backward = out.backward;
      }
      this._lookBack = false;
    }

    const env = {
      course,
      rubberBonus: this.finished ? 0 : this._rubberBonus(),
      maxSpeedMul,
      others: this.finished ? [] : otherPositions, // ゴール済みはほかのカートと衝突しない(設計書 10.2節1)
    };
    stepKart(this.kart, effInput, env, cfg, dt);

    // 3. ブーストパッド(オーナーが自分で判定して適用する。設計書 6.3・10.2節)
    this._checkBoostPads();

    if (!this.finished) {
      // 4. チェックポイント・周回
      const events = updateProgress(this.progress, this.kart, course, cfg, dt);
      for (const ev of events) {
        this.send(msg.reportCheckpoint(ev.lap, ev.cp));
        if (ev.cp === 0) this.log('lap', { slot: this.slot, lap: ev.lap });
        else this.log('checkpoint', { slot: this.slot, lap: ev.lap, cp: ev.cp });
      }

      // 5. アイテムボックス
      this._checkItemBoxes();

      // 6. アイテムの使用(入力のエッジ)
      if (this.heldItem && !this.itemUsePending && this._itemReady() && useItem) {
        this.itemUsePending = true;
        this.send(msg.requestUseItem(backward));
      }

      // 7. 弾・油との当たり(補間後の位置で判定。設計書 8.5節)
      this._checkHits(renderTs);
    }

    // 8. kartState を sendHz の間隔で送る
    this._sendAccum += dt;
    const interval = 1 / cfg.net.sendHz;
    if (this._sendAccum >= interval) {
      this._sendAccum -= interval;
      this.send(msg.kartState(now, this.kart.x, this.kart.z, this.kart.yaw, this.kart.speed, this.kart.spinT, this.kart.boostT));
    }
  }

  /** ゴール・離脱していないほかのプレイヤーの補間後の位置(stepKart の env.others 用) */
  _otherPositions(renderTs) {
    const out = [];
    for (const [otherSlot, entry] of this.others) {
      if (this.leftSlots.has(otherSlot)) continue;
      const sample = entry.buffer.sample(renderTs);
      if (!sample) continue;
      const isFinished = !!sample.finished || this.finishedSlots.has(otherSlot);
      if (isFinished) continue;
      out.push({ x: sample.x, z: sample.z });
    }
    return out;
  }

  /** 首位以外に足すラバーバンドの上乗せ率(設計書 8.6節)。progress を受け取るまでは 0 */
  _rubberBonus() {
    if (!this.progressBySlot) return 0;
    const self = this.progressBySlot.get(this.slot);
    if (!self || self.rank === 1) return 0;
    const rb = this.cfg.rubberband;
    const gapRatio = self.gapRatio || 0;
    return rb.maxBonus * clamp(gapRatio / rb.fullGapRatio, 0, 1);
  }

  /** パッドに入った瞬間だけ applyBoost する(設計書 10.2節3) */
  _checkBoostPads() {
    const course = this.course;
    const padCfg = this.cfg.boostPad;
    const L = course.length;
    const newInside = new Set();
    for (const pad of course.boostPads) {
      let ds = pad.s - this.kart.s;
      ds = ((ds + L / 2) % L + L) % L - L / 2; // s=0/L をまたぐパッドも正しく判定できるように、周回で丸めた差を使う
      const inside = Math.abs(ds) < padCfg.halfLength && Math.abs(this.kart.lateral - pad.lateral) < padCfg.halfWidth;
      if (inside) {
        newInside.add(pad.id);
        if (!this.insidePads.has(pad.id)) {
          applyBoost(this.kart, padCfg.durationSec, padCfg.bonus);
          this.log('boostPad', { slot: this.slot, padId: pad.id });
        }
      }
    }
    this.insidePads = newInside;
  }

  /** pickupRadius 以内の、有効に見えているボックスへ requestPickup を送る(1回だけ。設計書 8.2節) */
  _checkItemBoxes() {
    if (this.heldItem) return; // 所持中は取得できないので送らない(ホストも同じ条件で拒否する)
    const boxCfg = this.cfg.itemBox;
    const r2 = boxCfg.pickupRadius * boxCfg.pickupRadius;
    for (const box of this.course.itemBoxes) {
      if (this.boxActive.get(box.id) === false) continue;
      if (this.pickupSent.has(box.id)) continue;
      const w = this.boxWorld.get(box.id);
      const dx = this.kart.x - w.x;
      const dz = this.kart.z - w.z;
      if (dx * dx + dz * dz < r2) {
        this.pickupSent.add(box.id);
        this.send(msg.requestPickup(box.id));
      }
    }
  }

  /** 補間後の弾・油の位置と自分のカートで isHit を調べ、当たっていたら reportHit を1回だけ送る(設計書 8.5節) */
  _checkHits(renderTs) {
    if (this.kart.invulnT > 0) return;
    for (const [id, entry] of this.objects) {
      if (this.reportedHit.has(id)) continue;
      const type = entry.type;
      if (!type || !this.cfg.items[type.toLowerCase()]) continue; // spawnObj をまだ受け取っていない
      const sample = entry.buffer.sample(renderTs);
      if (!sample) continue;
      const fakeP = { type, active: sample.active, x: sample.x, z: sample.z };
      if (isHit(fakeP, this.kart.x, this.kart.z, this.cfg)) {
        this.reportedHit.add(id);
        this.send(msg.reportHit(id));
      }
    }
  }

  /** アイテムのルーレットが終わって使えるか(readyAt を過ぎたか) */
  _itemReady() {
    if (!this.heldItem) return false;
    return this._now >= this.heldItem.readyAt;
  }

  /**
   * autopilot に渡す ctx(設計書 10.5節)。targetAhead/targetBehind は「すぐ前/すぐ後ろ」の判定に使う。
   * 設計書には具体的な距離の指定がないため、Rocket の速さ(1秒で進む距離)を目安にした(判断して決めた点)。
   */
  _botCtx(renderTs) {
    const heldItem = this.heldItem ? this.heldItem.item : null;
    const itemReady = this._itemReady();
    let targetAhead = false;
    let targetBehind = false;
    if (heldItem === 'Rocket' && itemReady) {
      const range = this.cfg.items.rocket.speed;
      const L = this.course.length;
      for (const [otherSlot, entry] of this.others) {
        if (this.leftSlots.has(otherSlot) || this.finishedSlots.has(otherSlot)) continue;
        const sample = entry.buffer.sample(renderTs);
        if (!sample) continue;
        const proj = this.course.project(sample.x, sample.z);
        let ds = proj.s - this.kart.s;
        ds = ((ds + L / 2) % L + L) % L - L / 2;
        if (ds > 0 && ds < range) targetAhead = true;
        else if (ds < 0 && -ds < range) targetBehind = true;
      }
    }
    return { heldItem, itemReady, targetAhead, targetBehind };
  }

  // ---- 描画・HUD 用(設計書 10.2節) ----

  /** @returns {RenderView} */
  getView() {
    const cfg = this.cfg;
    const now = this._now;

    let phase;
    let countdown = null;
    if (!this.kart) {
      phase = 'countdown';
    } else if (this.raceEnded) {
      phase = 'ended';
    } else if (this.finished) {
      phase = 'finished';
    } else if (this.startAt != null && now < this.startAt) {
      phase = 'countdown';
      countdown = Math.max(0, Math.ceil((this.startAt - now) / 1000));
    } else {
      phase = 'racing';
    }

    const self = this.kart
      ? {
          slot: this.slot,
          x: this.kart.x,
          z: this.kart.z,
          yaw: this.kart.yaw,
          spinVisual: this.kart.spinVisual,
          boosting: this.kart.boostT > 0,
          shield: this.shieldBySlot.get(this.slot) === true,
          speed: this.kart.speed,
          color: cfg.colors[this.slot],
        }
      : null;

    const renderTs = now - cfg.net.interpDelayMs;
    const others = [];
    for (const [otherSlot, entry] of this.others) {
      if (this.leftSlots.has(otherSlot)) continue;
      const sample = entry.buffer.sample(renderTs);
      if (!sample) continue;
      const rosterEntry = this.rosterBySlot.get(otherSlot);
      const spinT = sample.spinT || 0;
      // 送られてくるのは spinT だけ(spinVisual はネットワークに乗らない)なので、
      // stepKart と同じ式(経過時間 = durationSec - spinT)で見た目の回転角を作り直す(判断して決めた点)。
      const spinVisual = spinT > 0
        ? Math.PI * 2 * cfg.spin.visualTurns * (1 - spinT / cfg.spin.durationSec)
        : 0;
      others.push({
        slot: otherSlot,
        x: sample.x,
        z: sample.z,
        yaw: sample.yaw,
        spinVisual,
        boosting: (sample.boostT || 0) > 0,
        shield: this.shieldBySlot.get(otherSlot) === true,
        finished: !!sample.finished || this.finishedSlots.has(otherSlot),
        color: cfg.colors[otherSlot],
        name: rosterEntry ? rosterEntry.name : '',
      });
    }

    const objects = [];
    for (const [id, entry] of this.objects) {
      const sample = entry.buffer.sample(renderTs);
      if (!sample) continue;
      objects.push({ id, type: entry.type, x: sample.x, z: sample.z, yaw: sample.yaw, active: !!sample.active });
    }

    const boxes = this.boxIds.map((id) => this.boxActive.get(id) !== false);

    return {
      phase,
      countdown,
      lookBack: this.controller === 'bot' || this.finished ? false : this._lookBack,
      self,
      others,
      objects,
      boxes,
      hud: this._buildHud(),
    };
  }

  _buildHud() {
    const cfg = this.cfg;
    const N = this.course.checkpoints.length;
    const laps = this.laps || cfg.laps;
    const progLap = this.progress ? this.progress.lap : 0;
    const selfProg = this.progressBySlot ? this.progressBySlot.get(this.slot) : null;

    const rouletteLeft = this.heldItem && !this._itemReady() ? Math.max(0, this.heldItem.readyAt - this._now) : 0;

    const elapsedMs = this.hostProgress
      ? this.hostProgress.elapsedMs
      : this.startAt != null
        ? Math.max(0, this._now - this.startAt)
        : 0;
    const timeLeftSec = Math.max(0, cfg.timeLimitSec - elapsedMs / 1000);

    let graceLeftSec = null;
    if (cfg.finishRule === 'grace' && this._firstFinishAtNow != null && !this.raceEnded) {
      graceLeftSec = Math.max(0, cfg.finishGraceSec - (this._now - this._firstFinishAtNow) / 1000);
    }

    const standings = this.roster.map((p) => {
      const info = this.progressBySlot ? this.progressBySlot.get(p.slot) : null;
      const left = this.leftSlots.has(p.slot);
      const finishedFlag = p.slot === this.slot ? this.finished : this.finishedSlots.has(p.slot);
      let status = 'racing';
      if (left) status = 'left';
      else if (finishedFlag || (info && info.place != null)) status = 'finished';
      const lap = info ? info.lap : 0;
      const nextCp = info ? info.nextCp : 1;
      // progress メッセージには s が入っていないので、チェックポイントの通過数から進み具合を概算する(判断して決めた点)
      const progress = clamp((lap * N + (nextCp - 1)) / (laps * N), 0, 1);
      return {
        slot: p.slot,
        name: p.name,
        color: cfg.colors[p.slot],
        rank: info ? info.rank : null,
        status,
        progress,
      };
    });

    return {
      lap: Math.min(laps, progLap + 1),
      laps,
      rank: selfProg ? selfProg.rank : null,
      playerCount: this.roster.length,
      item: this.heldItem ? this.heldItem.item : null,
      rouletteLeft,
      speedKmh: this.kart ? this.kart.speed * 3.6 : 0,
      wrongWay: this.progress ? this.progress.wrongWay : false,
      boostLeft: this.kart ? this.kart.boostT : 0,
      spinLeft: this.kart ? this.kart.spinT : 0,
      finish: this.finishInfo,
      timeLeftSec,
      graceLeftSec,
      standings,
    };
  }
}
