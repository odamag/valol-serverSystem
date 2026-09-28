/**
 * ゲストの枠(約束 11節)。ホストへの `Transport` を1本持ち、`hello` して名簿に入り、
 * `startGame`/`endGame` に合わせて `definition.createGame` を生成・破棄する。
 * 実際の再接続の試行(3秒ごと、など)はブラウザ側(T12)の役目。ここでは
 * 「切断を検知したら `events.onHostLost` を呼ぶ」「`shouldReconnect()` で再接続すべきかを返す」までを行う。
 */
import { wrapChannel } from '../net/channel.js';
import { msg, FRAME_MSG } from './protocol.js';
import { createClockSync } from './clock.js';

const noop = () => {};

/**
 * @param {{
 *   definition: object,
 *   name: string,
 *   playerId: string,
 *   transport: import('../net/transport.js').Transport,
 *   createGameCtxExtras?: () => { dom?: object|null, log?: (event: string, fields?: object) => void },
 *   events?: { onRoster?, onGameStart?, onGameEnd?, onPaused?, onResumed?, onReject?, onHostLost? },
 * }} opts
 */
export function createGuestFrame(opts) {
  const { definition, name, playerId, createGameCtxExtras = () => ({}), events = {} } = opts;

  const state = {
    phase: 'lobby', // 'lobby' | 'inGame' | 'paused' | 'result'
    lastNow: 0,
    localSlot: -1,
    roster: [], // toWireRoster 形式(slot,name,kind,connected,waiting)
    gi: 0,
    gameInstance: null,
    lastPingAt: -Infinity,
    rejected: false,
  };

  const clockSync = createClockSync();
  let channel = null;
  let gameHandlers = [];

  function buildGameRoster(wireRoster) {
    return wireRoster.map((p) => ({
      slot: p.slot,
      name: p.name,
      kind: p.kind,
      local: p.slot === state.localSlot,
    }));
  }

  function createGuestGameNet() {
    const net = {
      send(m) {
        if (!channel) return;
        channel.game.send(state.gi, m);
      },
      onMessage(fn) {
        gameHandlers.push(fn);
      },
    };
    return net;
  }

  function disposeGame() {
    if (state.gameInstance) {
      try {
        state.gameInstance.dispose();
      } catch {
        /* noop */
      }
    }
    state.gameInstance = null;
    gameHandlers = [];
  }

  function handleWelcome(m) {
    state.localSlot = m.slot;
    state.roster = m.roster;
    state.phase = m.phase;
    events.onRoster?.(state.roster);
  }

  function handleReject(m) {
    state.rejected = true;
    events.onReject?.(m.reason);
  }

  function handleRosterMsg(m) {
    state.roster = m.players;
    events.onRoster?.(state.roster);
  }

  function handlePong(m) {
    clockSync.onPong(m.c, m.h, state.lastNow);
  }

  function handleStartGame(m) {
    state.gi = m.gi;
    state.phase = 'inGame';
    disposeGame();

    const extras = createGameCtxExtras() || {};
    const net = createGuestGameNet();
    const ctx = {
      role: 'guest',
      localSlot: state.localSlot,
      roster: buildGameRoster(m.roster),
      seed: m.seed,
      settings: m.settings || {},
      net,
      clock: { hostNow: () => clockSync.hostNow(state.lastNow) },
      log: extras.log || noop,
      dom: extras.dom ?? null,
      // 約束 3節:onResult はホストだけが呼ぶ。ゲスト側では何もしない。
      onResult: noop,
    };
    state.gameInstance = definition.createGame(ctx);
    events.onGameStart?.({ gi: m.gi, roster: m.roster, seed: m.seed, settings: m.settings || {} });
  }

  function handlePlayerLeft(m) {
    if (m.gi !== state.gi || !state.gameInstance) return;
    try {
      state.gameInstance.onPlayerLeft(m.slot);
    } catch {
      /* noop */
    }
  }

  function handleEndGame(m) {
    if (m.gi !== state.gi) return;
    disposeGame();
    state.phase = 'result';
    events.onGameEnd?.(m.result);
  }

  function handlePaused() {
    disposeGame();
    state.phase = 'paused';
    events.onPaused?.();
  }

  function handleResumed() {
    events.onResumed?.();
    // 新しいラウンドは、この直後に届く startGame で始まる。
  }

  function onFrameMessage(m) {
    switch (m.t) {
      case FRAME_MSG.WELCOME:
        handleWelcome(m);
        break;
      case FRAME_MSG.REJECT:
        handleReject(m);
        break;
      case FRAME_MSG.ROSTER:
        handleRosterMsg(m);
        break;
      case FRAME_MSG.PONG:
        handlePong(m);
        break;
      case FRAME_MSG.START_GAME:
        handleStartGame(m);
        break;
      case FRAME_MSG.PLAYER_LEFT:
        handlePlayerLeft(m);
        break;
      case FRAME_MSG.END_GAME:
        handleEndGame(m);
        break;
      case FRAME_MSG.PAUSED:
        handlePaused();
        break;
      case FRAME_MSG.RESUMED:
        handleResumed();
        break;
      default:
        break;
    }
  }

  function attach(transport) {
    channel = wrapChannel(transport);
    channel.frame.onMessage(onFrameMessage);
    channel.game.onMessage((gi, m) => {
      if (gi !== state.gi) return;
      for (const fn of gameHandlers) fn(m);
    });
    channel.transport.onClose(() => {
      events.onHostLost?.();
    });
    channel.frame.send(msg.hello(playerId, name));
  }

  attach(opts.transport);

  function replaceTransport(transport) {
    attach(transport);
  }

  function leave() {
    if (channel) {
      channel.frame.send(msg.leave());
      channel.transport.close();
    }
    disposeGame();
  }

  function shouldReconnect() {
    // ロビー・結果画面での切断は再接続しない(約束 7節)。reject された場合も再接続しない。
    if (state.rejected) return false;
    return state.phase === 'inGame' || state.phase === 'paused';
  }

  function update(now) {
    state.lastNow = now;
    if (channel) channel.transport.pump(now);
    if (channel && now - state.lastPingAt >= 1000) {
      state.lastPingAt = now;
      channel.frame.send(msg.ping(now));
    }
    if (state.phase === 'inGame' && state.gameInstance) {
      state.gameInstance.update(now);
    }
  }

  function render(now) {
    if (state.phase === 'inGame' && state.gameInstance) {
      state.gameInstance.render(now);
    }
  }

  return {
    update,
    render,
    leave,
    replaceTransport,
    shouldReconnect,
    get roster() {
      return state.roster;
    },
    get phase() {
      return state.phase;
    },
    get localSlot() {
      return state.localSlot;
    },
    get gi() {
      return state.gi;
    },
  };
}
