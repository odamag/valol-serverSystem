/**
 * MG01 Race の definition と createGame(ctx)(約束 2・3節、設計書 10.3節)。
 * ホストの中では、自分のプレイヤーとボットの分だけ RaceClient を作り、RaceHost とはループバック
 * (`_shared/net/loopback.js`)でつなぐ(設計書 9.1節)。リモートのプレイヤーには `ctx.net` で送る。
 * ゲストでは、自分の RaceClient 1つだけを `ctx.net` でホストとつなぐ。
 * DOM・three・Date.now・Math.random には触れない(設計書 2.2節)。描画・HUD・入力は `ctx.dom` があるときだけ
 * 動的 import する。
 */

import { makeConfig } from './config.js';
import { buildCourse } from './core/course.js';
import { COURSE_DATA } from './core/courseData.js';
import { RaceHost } from './game/host.js';
import { RaceClient } from './game/client.js';
import { createLoopbackPair } from '../../_shared/net/loopback.js';
import { createRng } from '../../_shared/core/rng.js';

/** @type {object} 約束 2節の definition */
export const definition = {
  id: 'MG01',
  name: 'アイテムレース',
  description: 'アイテムとブーストで最後まで逆転できるカートレース。最大8人でP2P対戦、ボットとの練習も。',
  minPlayers: 1,
  maxPlayers: 8,
  supportsBots: true,
  estimatedDurationSec: 120,
  createGame,
};

/**
 * @param {object} ctx 約束 3節の GameContext
 * @returns {object} 約束 3節の GameInstance
 */
export function createGame(ctx) {
  // ctx.settings.autopilot(11節「自分のカートもオートパイロットにする」の真偽値フラグ)は、
  // RaceConfig.autopilot(4節のボットAIの調整値。オブジェクト)と同じキー名になっている。
  // そのまま makeConfig(ctx.settings) に渡すと deepMerge が cfg.autopilot を true で潰してしまい、
  // botInput が cfg.autopilot.speedJitter 等を読めずに NaN になる(結合して見つけた不具合。設計書 10.3節
  // 「ctx.settings を makeConfig に渡して cfg を作る」と 11節の URL パラメータ名が衝突している)。
  // view/latency も同様に game.js だけが使うフラグなので、cfg には渡さない。
  const { autopilot: autopilotFlag, view, latency, ...cfgOverrides } = ctx.settings || {};
  const cfg = makeConfig(cfgOverrides);
  const course = buildCourse(COURSE_DATA, cfg);
  const fixedDtMs = cfg.fixedDt * 1000;

  const baseLog = ctx.log || (() => {});
  /** log をラップして、必ず src(host / c<slot>)をつける(結合して見つけた不具合の直し。報告に書く) */
  function wrapLog(src) {
    return (event, fields) => baseLog(event, { ...(fields || {}), src });
  }

  // クライアントの autopilot 用 rng は、ctx.seed から派生させる(host/guest のどちらでも同じ規則)。
  const seedRng = createRng(ctx.seed);
  function nextChildSeed() {
    return Math.floor(seedRng.next() * 0x100000000) >>> 0;
  }

  const selfSlot = ctx.localSlot;

  let currentNow = ctx.clock.hostNow();
  let stepNow = currentNow;
  let hasStepped = false;
  let disposed = false;

  /** @type {Map<number, import('./game/client.js').RaceClient>} */
  const clients = new Map();

  let host = null;
  let hostQueue = []; // {slot, m}
  const localLinks = new Map(); // slot -> {hostSide, clientSide}
  const clientQueues = new Map(); // slot -> array<m>

  let guestQueue = []; // m[]

  if (ctx.role === 'host') {
    const localEntries = ctx.roster.filter((p) => p.local);
    for (const p of localEntries) {
      // ホストの中のクライアントと RaceHost の間は loopback でつなぐ(設計書 9.1節)。
      // 遅延は既定 0。settings.latency があればボットとの間にその ms の遅延をかける(判断して決めた点。
      // 約束・設計書は latency を「ボットとの間」とだけ書いており、ホスト自身の human クライアントには
      // かけない。11節の ?latency= の説明「ホストの中のボットとのループバックに遅延をかける」に合わせた)。
      const latencyMs = p.kind === 'bot' ? latency || 0 : 0;
      const [hostSide, clientSide] = createLoopbackPair({ latencyMs });
      hostSide.onMessage((m) => hostQueue.push({ slot: p.slot, m }));
      const q = [];
      clientSide.onMessage((m) => q.push(m));
      localLinks.set(p.slot, { hostSide, clientSide });
      clientQueues.set(p.slot, q);
    }

    ctx.net.onMessage((slot, m) => hostQueue.push({ slot, m }));

    function sendTo(slot, m) {
      const local = localLinks.get(slot);
      if (local) {
        local.hostSide.send(m);
        return;
      }
      ctx.net.send(slot, m);
    }

    host = new RaceHost({
      cfg,
      course,
      seed: ctx.seed,
      roster: ctx.roster,
      now: currentNow,
      sendTo,
      log: wrapLog('host'),
      onResult: ctx.onResult,
    });

    for (const p of localEntries) {
      const link = localLinks.get(p.slot);
      // settings.autopilot が true なら、ホスト自身のクライアントも controller: 'bot' にする(テストで使う)。
      const controller = p.kind === 'bot' ? 'bot' : autopilotFlag ? 'bot' : 'human';
      const client = new RaceClient({
        slot: p.slot,
        cfg,
        course,
        roster: ctx.roster,
        send: (m) => link.clientSide.send(m),
        controller,
        seed: nextChildSeed(),
        log: wrapLog(`c${p.slot}`),
      });
      clients.set(p.slot, client);
    }

    if (typeof window !== 'undefined') {
      window.__mg01 = { host, clients: Object.fromEntries(clients), stats: host.stats };
    }
  } else {
    ctx.net.onMessage((m) => guestQueue.push(m));
    const controller = autopilotFlag ? 'bot' : 'human';
    const client = new RaceClient({
      slot: selfSlot,
      cfg,
      course,
      roster: ctx.roster,
      send: (m) => ctx.net.send(m),
      controller,
      seed: nextChildSeed(),
      log: wrapLog(`c${selfSlot}`),
    });
    clients.set(selfSlot, client);

    if (typeof window !== 'undefined') {
      // host 側の window.__mg01 と同じ形(host は無い)。sim.test.js の「新しいゲームの objects が空」の
      // 確認にも使える(判断して決めた点。設計書はホストの stats だけを想定しているが、clients は害がない)。
      window.__mg01 = { clients: Object.fromEntries(clients) };
    }
  }

  // ---- 描画・HUD・入力(dom があるときだけ。設計書 2.2節、10.3節) ----
  let renderer = null;
  let hud = null;
  let input = null;
  let renderReady = ctx.dom == null; // dom が無ければ最初から「準備完了(何もしない)」扱い
  let lastRenderNow = null;
  let currentInput = { throttle: 0, steer: 0, useItem: false, backward: false, lookBack: false };

  if (ctx.dom) {
    setupRendering();
  }

  /**
   * 描画・HUD・入力を dom があるときだけ動的 import する。src/ui/hud.js と src/game/input.js は
   * このタスク(T11)の時点ではまだ作られていないので、読み込みに失敗したら「描画なしで続ける」
   * (renderer は使えれば使う。hud/input は無ければ何もしない空の実装として扱う)。T12 が実装をつなぐ前提。
   */
  async function setupRendering() {
    try {
      const rendererMod = await import('./render/renderer.js');
      renderer = rendererMod.createRenderer(ctx.dom.canvas, course, cfg, ctx.roster);
    } catch (e) {
      wrapLog('game')('renderSetupFailed', { part: 'renderer', error: String(e && e.message ? e.message : e) });
      renderer = null;
    }
    try {
      const hudMod = await import('./ui/hud.js');
      hud = hudMod.createHud ? hudMod.createHud(ctx.dom.hudRoot) : null;
    } catch (e) {
      hud = null; // T12 で作る。無ければ HUD なしで続ける
    }
    try {
      const inputMod = await import('./game/input.js');
      input = inputMod.createInput ? inputMod.createInput(ctx.dom.canvas) : null;
    } catch (e) {
      input = null; // T12 で作る。無ければ入力なし(操作できないだけで、描画とボットは動く)
    }
    renderReady = true;
  }

  /** 固定ステップ1回分:ホスト → クライアントの順(設計書 10.3節)。ループバックはステップごとに pump する。 */
  function doStep(t, dt) {
    if (ctx.role === 'host') {
      for (const link of localLinks.values()) {
        link.hostSide.pump(t);
        link.clientSide.pump(t);
      }
      // host.update(now, dt) を先に呼び、その後にそのステップで届いたメッセージを処理する
      // (host.js の handleMessage は now を受け取らず、直前の update の now を使うため)。
      host.update(t, dt);
      while (hostQueue.length > 0) {
        const { slot, m } = hostQueue.shift();
        host.handleMessage(slot, m);
      }
      for (const [slot, client] of clients) {
        const inp = slot === selfSlot ? currentInput : undefined;
        client.update(t, dt, inp);
        const q = clientQueues.get(slot);
        while (q.length > 0) client.handleMessage(q.shift());
      }
    } else {
      const client = clients.get(selfSlot);
      client.update(t, dt, currentInput);
      while (guestQueue.length > 0) client.handleMessage(guestQueue.shift());
    }
    currentNow = t;
  }

  /** @param {number} now */
  function update(now) {
    if (!hasStepped) {
      // 最初の update は基準時刻を覚えるだけ。
      hasStepped = true;
      stepNow = now;
      currentNow = now;
      return;
    }
    let elapsed = now - stepNow;
    let steps = 0;
    while (elapsed >= fixedDtMs && steps < 5) {
      stepNow += fixedDtMs;
      doStep(stepNow, cfg.fixedDt);
      elapsed -= fixedDtMs;
      steps += 1;
    }
  }

  /** @param {number} now */
  function render(now) {
    if (!ctx.dom || !renderReady || !renderer) return;
    if (input) currentInput = input.poll();

    const viewSlot = view != null && clients.has(view)
      ? view
      : selfSlot;
    const client = clients.get(viewSlot) || clients.get(selfSlot);
    if (!client) return;

    // 変数名の衝突に注意:外側の `view`(?view=<slot> の設定値)とは別物(結合中に見つけて直した不具合)。
    const renderView = client.getView();
    const dt = lastRenderNow != null ? (now - lastRenderNow) / 1000 : 0;
    lastRenderNow = now;
    renderer.render(renderView, dt);
    if (hud) hud.update(renderView);
  }

  /** @param {number} slot */
  function onPlayerLeft(slot) {
    if (disposed) return;
    if (ctx.role === 'host') {
      host.playerLeft(slot, currentNow);
      for (const [s, client] of clients) {
        if (s === slot) continue;
        client.playerLeft(slot);
      }
    } else {
      const client = clients.get(selfSlot);
      client?.playerLeft(slot);
    }
  }

  function dispose() {
    disposed = true;
    try {
      renderer?.dispose();
    } catch {
      /* dispose の失敗で枠を落とさない */
    }
    try {
      hud?.dispose?.();
    } catch {
      /* noop */
    }
    try {
      input?.dispose?.();
    } catch {
      /* noop */
    }
  }

  return { update, render, onPlayerLeft, dispose };
}
