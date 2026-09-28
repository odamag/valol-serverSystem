/**
 * RaceHost(サーバー役。設計書 10.1節)。
 * アイテムの抽選、弾・油の移動、順位、勝敗をホストが確定する。DOM・three・Date.now・Math.random には触れない
 * (設計書 2.2節)。ホストはカートの物理そのものは動かさない。各プレイヤーの位置は、受け取った最新の
 * `kartState` をそのまま使う(補間しない。設計書 10.1節「ホストから見た各プレイヤーのカートの位置」)。
 */

import { createRng } from '../../../_shared/core/rng.js';
import { acceptCheckpoint, raceDistance, compareProgress, rankPlayers } from '../core/progress.js';
import { tableNameFor, rollItem, ITEMS } from '../core/items.js';
import { createProjectile, stepProjectile } from '../core/projectiles.js';
import { msg } from './protocol.js';

/** アイテム名 → 0 の辞書を作る(stats の初期値用) */
function zeroItemCounts() {
  const out = {};
  for (const name of ITEMS) out[name] = 0;
  return out;
}

export class RaceHost {
  /**
   * @param {object} params
   * @param {object} params.cfg makeConfig() が返す設定
   * @param {import('../core/course.js').Course} params.course
   * @param {number} params.seed
   * @param {Array<{slot:number, name:string, kind:string, local:boolean}>} params.roster
   * @param {number} params.now 生成した瞬間のホスト時刻(ms)
   * @param {(slot:number, msg:object) => void} params.sendTo
   * @param {(event:string, fields?:object) => void} params.log
   * @param {(result:{ranking:number[], reason:string, details:object}) => void} params.onResult
   */
  constructor({ cfg, course, seed, roster, now, sendTo, log, onResult }) {
    this.cfg = cfg;
    this.course = course;
    this.roster = roster;
    this.sendTo = sendTo;
    this.log = log || (() => {});
    this.onResult = onResult;

    this.rng = createRng(seed);

    // 内部で扱う「現在のホスト時刻」。update(now, dt) と playerLeft(slot, now) で更新する。
    // handleMessage(slot, msg) は設計書どおり now を受け取らないので、この値を使う(判断して決めた点。報告に書く)。
    this.now = now;

    const L = course.length;
    const N = course.checkpoints.length;
    this.L = L;
    this.N = N;

    // グリッド:seed からシャッフルして割り当てる(設計書 5.2節)
    const slots = roster.map((p) => p.slot);
    const shuffled = this.rng.shuffle(slots);
    this.grid = shuffled.map((slot, gridIndex) => ({ slot, gridIndex }));
    const gridIndexBySlot = new Map(this.grid.map((g) => [g.slot, g.gridIndex]));

    this.startAt = now + (cfg.startDelaySec + cfg.countdownSec) * 1000;
    this._ended = false;
    this._nextObjId = 1;
    this.objects = new Map(); // id -> Projectile
    this._finishCounter = 0;
    this._firstFinishAt = null;

    // ボックスの状態(設計書 8.2節)
    this._boxes = new Map(
      course.itemBoxes.map((b) => [b.id, { id: b.id, active: true, respawnAt: 0 }]),
    );

    // プレイヤーごとの状態
    this._players = new Map();
    for (const p of roster) {
      const gridIndex = gridIndexBySlot.get(p.slot);
      const pose = course.gridPose(gridIndex);
      const proj = course.project(pose.x, pose.z);
      this._players.set(p.slot, {
        slot: p.slot,
        x: pose.x,
        z: pose.z,
        yaw: pose.yaw,
        speed: 0,
        spinT: 0,
        boostT: 0,
        courseIndex: proj.index,
        s: proj.s,
        lateral: proj.lateral,
        lastKartTs: 0,
        prog: { lap: 0, nextCp: 1 },
        finishedAt: null,
        place: null,
        left: false,
        item: null, // 所持しているアイテム名(ルーレット中も含めて持っている扱い)
        itemReadyAt: 0, // これ以降なら使える(ms、ホスト時刻)
        invulnUntil: 0,
        shieldUntil: 0,
      });
    }

    // 送信頻度の管理(初回の update ですぐ送る)
    this._lastKartsSentAt = -Infinity;
    this._lastProgressSentAt = -Infinity;

    // テスト用の効果(設計書 4節 cfg.test)
    if (cfg.test && cfg.test.effects) {
      this._nextEffectAt = now + this.rng.range(cfg.test.effectsMinSec, cfg.test.effectsMaxSec) * 1000;
    } else {
      this._nextEffectAt = null;
    }

    this.stats = {
      grants: { leader: zeroItemCounts(), near: zeroItemCounts(), far: zeroItemCounts() },
      uses: zeroItemCounts(),
      hits: 0,
      shieldBlocks: 0,
    };

    // 生成直後に roundStart を送る(設計書 9.3節)
    this._broadcast(msg.roundStart(this.startAt, cfg.laps, this.grid));
    this.log('roundStart', { seed, startAt: this.startAt, laps: cfg.laps });
  }

  /** 現在のフェーズ */
  get phase() {
    if (this._ended) return 'ended';
    return this.now < this.startAt ? 'countdown' : 'racing';
  }

  /** roster の全 slot に送る */
  _broadcast(m) {
    for (const p of this.roster) this.sendTo(p.slot, m);
  }

  /** 現在の順位・gapRatio を計算する(設計書 7.2節、8.2節) */
  _computeStandings() {
    const { L, N } = this;
    const entries = [];
    for (const p of this.roster) {
      const pl = this._players.get(p.slot);
      entries.push({ slot: p.slot, lap: pl.prog.lap, nextCp: pl.prog.nextCp, s: pl.s, finishedAt: pl.finishedAt, left: pl.left });
    }
    const ranking = rankPlayers(entries, L, N);
    const bySlot = new Map(entries.map((e) => [e.slot, e]));
    const leaderEntry = bySlot.get(ranking[0]);
    const leaderDist = raceDistance(leaderEntry.lap, leaderEntry.nextCp, leaderEntry.s, L, N);

    const rankBySlot = new Map();
    ranking.forEach((slot, i) => rankBySlot.set(slot, i + 1));

    const gapBySlot = new Map();
    for (const e of entries) {
      const d = raceDistance(e.lap, e.nextCp, e.s, L, N);
      gapBySlot.set(e.slot, Math.max(0, (leaderDist - d) / L));
    }

    return { entries, ranking, rankBySlot, gapBySlot };
  }

  // ---- メッセージの処理(設計書 9.2節) ----

  /**
   * クライアントから届いたメッセージを処理する。
   * @param {number} slot
   * @param {object} m
   */
  handleMessage(slot, m) {
    const player = this._players.get(slot);
    if (!player) return;
    switch (m.t) {
      case 'kartState':
        this._onKartState(player, m);
        break;
      case 'reportCheckpoint':
        this._onReportCheckpoint(player, m);
        break;
      case 'requestPickup':
        this._onRequestPickup(player, m);
        break;
      case 'requestUseItem':
        this._onRequestUseItem(player, m);
        break;
      case 'reportHit':
        this._onReportHit(player, m);
        break;
      default:
        break;
    }
  }

  _onKartState(player, m) {
    player.x = m.x;
    player.z = m.z;
    player.yaw = m.yaw;
    player.speed = m.speed;
    player.spinT = m.spinT;
    player.boostT = m.boostT;
    player.lastKartTs = m.ts;
    const proj = this.course.project(m.x, m.z, player.courseIndex);
    player.s = proj.s;
    player.lateral = proj.lateral;
    player.courseIndex = proj.index;
  }

  _onReportCheckpoint(player, m) {
    if (player.left || player.finishedAt != null) return;
    const accepted = acceptCheckpoint(player.prog, m.lap, m.cp, this.N);
    if (!accepted) return;

    if (m.cp === 0) {
      this.log('lap', { slot: player.slot, lap: player.prog.lap });
      if (player.prog.lap === this.cfg.laps) {
        player.finishedAt = this.now;
        player.place = ++this._finishCounter;
        if (this._firstFinishAt == null) this._firstFinishAt = this.now;
        const timeMs = this.now - this.startAt;
        this._broadcast(msg.playerFinished(player.slot, player.place, timeMs));
        this.log('finish', { slot: player.slot, place: player.place, timeMs });
        this._maybeEndRace();
      }
    } else {
      this.log('checkpoint', { slot: player.slot, lap: player.prog.lap, cp: m.cp });
    }
  }

  _onRequestPickup(player, m) {
    if (player.left || player.finishedAt != null) return;
    if (player.item != null) return; // ルーレット中も含めて所持中は拒否
    const box = this._boxes.get(m.boxId);
    if (!box || !box.active) return;

    box.active = false;
    box.respawnAt = this.now + this.cfg.itemBox.respawnSec * 1000;
    this._broadcast(msg.boxState(box.id, false));

    const { rankBySlot, gapBySlot } = this._computeStandings();
    const rank = rankBySlot.get(player.slot);
    const gapRatio = gapBySlot.get(player.slot);
    const table = tableNameFor(rank, gapRatio, this.cfg);
    const force = this.cfg.test.forceItemBySlot[player.slot] ?? this.cfg.test.forceItem ?? null;
    const item = rollItem({ rank, gapRatio, rng: this.rng, cfg: this.cfg, force });

    player.item = item;
    player.itemReadyAt = this.now + this.cfg.itemBox.rouletteSec * 1000;
    this.stats.grants[table][item] += 1;

    const rouletteMs = this.cfg.itemBox.rouletteSec * 1000;
    this._broadcast(msg.itemGranted(player.slot, item, rouletteMs));
    this.log('boxPickup', { slot: player.slot, boxId: box.id });
    this.log('itemGranted', { slot: player.slot, item, rank, gapRatio, table });
  }

  _onRequestUseItem(player, m) {
    if (player.left || player.finishedAt != null) return;
    if (player.item == null) return;
    if (this.now < player.itemReadyAt) return; // ルーレット中は無視

    const item = player.item;
    const backward = !!m.backward;
    player.item = null;
    player.itemReadyAt = 0;
    this._broadcast(msg.itemCleared(player.slot));
    this.stats.uses[item] += 1;
    this.log('itemUsed', { slot: player.slot, item, backward });

    const pose = { x: player.x, z: player.z, yaw: player.yaw };

    if (item === 'Dash') {
      const { durationSec, bonus } = this.cfg.items.dash;
      this._broadcast(msg.applyBoost(player.slot, durationSec, bonus));
      return;
    }

    if (item === 'Shield') {
      player.shieldUntil = this.now + this.cfg.items.shield.durationSec * 1000;
      this._broadcast(msg.shieldState(player.slot, true));
      return;
    }

    if (item === 'Rocket') {
      const id = this._nextObjId++;
      const p = createProjectile('Rocket', player.slot, pose, { id, backward }, this.cfg, this.course);
      this.objects.set(id, p);
      this._broadcast(msg.spawnObj(id, p.type, p.owner, p.x, p.z, p.yaw, p.active));
      this.log('spawn', { slot: player.slot, type: 'Rocket', id });
      return;
    }

    if (item === 'Homing') {
      const id = this._nextObjId++;
      const targetSlot = this._findHomingTarget(player.slot);
      const p = createProjectile('Homing', player.slot, pose, { id, targetSlot }, this.cfg, this.course);
      this.objects.set(id, p);
      this._broadcast(msg.spawnObj(id, p.type, p.owner, p.x, p.z, p.yaw, p.active));
      this.log('spawn', { slot: player.slot, type: 'Homing', id, targetSlot });
      return;
    }

    if (item === 'Oil') {
      const id = this._nextObjId++;
      const p = createProjectile('Oil', player.slot, pose, { id, backward }, this.cfg, this.course);
      this.objects.set(id, p);
      this._broadcast(msg.spawnObj(id, p.type, p.owner, p.x, p.z, p.yaw, p.active));
      this.log('spawn', { slot: player.slot, type: 'Oil', id });
      return;
    }
  }

  /** 使った時点で、そのプレイヤーのすぐ前の順位の人(ゴール済み・抜けた人を除く)を探す(設計書 8.3節) */
  _findHomingTarget(slot) {
    const active = [];
    for (const p of this.roster) {
      const pl = this._players.get(p.slot);
      if (pl.left || pl.finishedAt != null) continue;
      active.push({ slot: p.slot, lap: pl.prog.lap, nextCp: pl.prog.nextCp, s: pl.s, finishedAt: null, left: false });
    }
    const ranking = rankPlayers(active, this.L, this.N);
    const idx = ranking.indexOf(slot);
    if (idx <= 0) return null; // 自分がいない、もしくは既に先頭
    return ranking[idx - 1];
  }

  _onReportHit(player, m) {
    const p = this.objects.get(m.objId);
    if (!p) return;
    if (player.slot === p.owner) {
      const graceSec = this.cfg.items[p.type.toLowerCase()].ownerGraceSec;
      if (p.age < graceSec) return; // 投げた直後の猶予
    }
    if (player.finishedAt != null) return;
    if (player.invulnUntil > this.now) return;

    // 確定:オブジェクトを消す
    this.objects.delete(m.objId);
    this._broadcast(msg.despawnObj(m.objId, 'hit'));

    if (player.shieldUntil > this.now) {
      player.shieldUntil = 0;
      this._broadcast(msg.shieldState(player.slot, false));
      this.stats.shieldBlocks += 1;
      this.log('shieldBlock', { slot: player.slot, objId: m.objId });
    } else {
      this._broadcast(msg.applySpin(player.slot));
      player.invulnUntil = this.now + (this.cfg.spin.durationSec + this.cfg.spin.invulnAfterSec) * 1000;
      this.stats.hits += 1;
      this.log('hit', { slot: player.slot, objId: m.objId, owner: p.owner });
    }
  }

  /**
   * プレイヤーが抜けたときに枠から呼ばれる(設計書 9.4節)。
   * @param {number} slot
   * @param {number} now
   */
  playerLeft(slot, now) {
    this.now = now;
    const player = this._players.get(slot);
    if (!player) return;
    player.left = true;
    player.item = null;
    player.itemReadyAt = 0;
    player.shieldUntil = 0;
    this.log('playerLeft', { slot });
    this._maybeEndRace();
  }

  /**
   * 固定ステップごとに呼ばれる(設計書 10.1節)。
   * 弾を動かす → ボックスの再出現 → Shield の期限 → テスト用の効果 → 順位の計算 → 終了の判定 →
   * 決まった頻度で karts / objState / progress を送る。
   * @param {number} now
   * @param {number} dt
   */
  update(now, dt) {
    this.now = now;
    if (this._ended) return;

    this._stepProjectiles(dt);
    this._respawnBoxes();
    this._expireShields();
    this._runTestEffects();

    const standings = this._computeStandings();
    this._maybeEndRace(standings);
    if (this._ended) return; // raceEnd を送ったら、このステップの通常送信はしない

    this._sendPeriodic(standings);
  }

  _stepProjectiles(dt) {
    for (const [id, p] of this.objects) {
      let targetPos;
      if (p.type === 'Homing' && p.targetSlot != null) {
        const target = this._players.get(p.targetSlot);
        if (target && !target.left && target.finishedAt == null) {
          targetPos = { x: target.x, z: target.z };
        } else {
          p.targetSlot = null; // 目標がゴール・離脱したら目標なしに切り替える(設計書 8.4節)
        }
      }
      const status = stepProjectile(p, { course: this.course, targetPos }, this.cfg, dt);
      if (status !== 'alive') {
        this.objects.delete(id);
        this._broadcast(msg.despawnObj(id, status));
      }
    }
  }

  _respawnBoxes() {
    for (const box of this._boxes.values()) {
      if (!box.active && this.now >= box.respawnAt) {
        box.active = true;
        this._broadcast(msg.boxState(box.id, true));
      }
    }
  }

  _expireShields() {
    for (const p of this.roster) {
      const player = this._players.get(p.slot);
      if (player.shieldUntil > 0 && this.now >= player.shieldUntil) {
        player.shieldUntil = 0;
        this._broadcast(msg.shieldState(player.slot, false));
      }
    }
  }

  _runTestEffects() {
    if (this._nextEffectAt == null) return;
    if (this.now < this._nextEffectAt) return;

    const candidates = this.roster.filter((p) => !this._players.get(p.slot).left);
    if (candidates.length > 0) {
      const target = this.rng.pick(candidates);
      if (this.rng.next() < 0.5) {
        this._broadcast(msg.applySpin(target.slot));
        this.log('testEffect', { slot: target.slot, kind: 'spin' });
      } else {
        const { durationSec, bonus } = this.cfg.items.dash;
        this._broadcast(msg.applyBoost(target.slot, durationSec, bonus));
        this.log('testEffect', { slot: target.slot, kind: 'boost' });
      }
    }

    this._nextEffectAt = this.now + this.rng.range(this.cfg.test.effectsMinSec, this.cfg.test.effectsMaxSec) * 1000;
  }

  /** 終了の判定(設計書 10.1節)。終わったら raceEnd を送り、onResult を呼ぶ */
  _maybeEndRace(standingsIn) {
    if (this._ended) return;
    const cfg = this.cfg;

    const nonLeft = this.roster.filter((p) => !this._players.get(p.slot).left);
    const allFinished = nonLeft.length > 0 && nonLeft.every((p) => this._players.get(p.slot).finishedAt != null);
    const anyFinished = this.roster.some((p) => this._players.get(p.slot).finishedAt != null);

    let reason = null;
    if (cfg.finishRule === 'first' && anyFinished) {
      reason = 'first';
    } else if (cfg.finishRule === 'grace') {
      if (allFinished) reason = 'allFinished';
      else if (this._firstFinishAt != null && this.now - this._firstFinishAt >= cfg.finishGraceSec * 1000) {
        reason = 'grace';
      }
    }
    if (!reason && this.now - this.startAt >= cfg.timeLimitSec * 1000) reason = 'timeout';
    if (!reason) return;

    const standings = standingsIn || this._computeStandings();
    const { ranking } = standings;
    const results = ranking.map((slot, i) => {
      const pl = this._players.get(slot);
      return {
        slot,
        place: i + 1,
        timeMs: pl.finishedAt != null ? pl.finishedAt - this.startAt : null,
        status: pl.left ? 'left' : pl.finishedAt != null ? 'finished' : 'racing',
      };
    });

    this._ended = true;
    this._broadcast(msg.raceEnd(reason, results));
    this.log('raceEnd', { reason });
    this.onResult({ ranking, reason, details: { results } });
  }

  _sendPeriodic(standings) {
    const cfg = this.cfg;
    const kartsIntervalMs = 1000 / cfg.net.sendHz;
    const progressIntervalMs = 1000 / cfg.net.progressHz;

    if (this.now - this._lastKartsSentAt >= kartsIntervalMs) {
      this._lastKartsSentAt = this.now;
      const list = this.roster.map((p) => {
        const pl = this._players.get(p.slot);
        return {
          slot: p.slot,
          x: pl.x,
          z: pl.z,
          yaw: pl.yaw,
          speed: pl.speed,
          spinT: pl.spinT,
          boostT: pl.boostT,
          finished: pl.finishedAt != null,
        };
      });
      this._broadcast(msg.karts(this.now, list));

      if (this.objects.size > 0) {
        const objs = [...this.objects.values()].map((p) => ({ id: p.id, x: p.x, z: p.z, yaw: p.yaw, active: p.active }));
        this._broadcast(msg.objState(this.now, objs));
      }
    }

    if (this.now - this._lastProgressSentAt >= progressIntervalMs) {
      this._lastProgressSentAt = this.now;
      const { rankBySlot, gapBySlot } = standings;
      const players = this.roster.map((p) => {
        const pl = this._players.get(p.slot);
        return {
          slot: p.slot,
          lap: pl.prog.lap,
          nextCp: pl.prog.nextCp,
          rank: rankBySlot.get(p.slot),
          gapRatio: gapBySlot.get(p.slot),
          place: pl.place,
        };
      });
      const elapsedMs = this.now - this.startAt;
      this._broadcast(msg.progress(elapsedMs, players));
    }
  }
}
