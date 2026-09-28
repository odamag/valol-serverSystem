/**
 * ホストの枠(約束 11節)。PeerJS/loopback の `Transport` を受け取って接続を管理し、
 * 名簿・時刻同期の応答・ゲームの生成と破棄・切断/再接続の方針(約束 7節)をまとめる。
 * ゲームのロジックは一切持たない(それは `definition.createGame` の役目)。
 */
import { wrapChannel } from '../net/channel.js';
import { msg, FRAME_MSG, FRAME_VERSION } from './protocol.js';
import { createRng } from '../core/rng.js';
import {
  createRoster,
  addBot as rosterAddBot,
  removeBySlot,
  joinHuman,
  markDisconnected,
  confirmedForGame,
  admitWaiting,
  toWireRoster,
} from './roster.js';

const noop = () => {};

/**
 * @param {{
 *   definition: object,
 *   maxPlayers: number,
 *   onDisconnect: 'continue' | 'restart',
 *   hostName: string,
 *   playerId: string,
 *   seed: number,
 *   createGameCtxExtras?: () => { dom?: object|null, log?: (event: string, fields?: object) => void },
 *   reconnectWaitSec?: number,
 *   events?: { onRoster?, onGameStart?, onGameEnd?, onPaused?, onResumed? },
 * }} opts
 */
export function createHostFrame(opts) {
  const {
    definition,
    maxPlayers,
    onDisconnect,
    hostName,
    playerId: hostPlayerId,
    seed,
    createGameCtxExtras = () => ({}),
    reconnectWaitSec = 120,
    events = {},
  } = opts;

  if (typeof seed !== 'number') {
    // Math.random は禁止(約束 10節)。ブラウザ側が必ず seed を渡す。
    throw new Error('createHostFrame: opts.seed が必要です');
  }

  const roster = createRoster();
  // ホスト自身の名簿エントリ(常に slot 0、local: true)。
  const hostEntry = {
    slot: 0,
    name: hostName,
    kind: 'human',
    local: true,
    playerId: hostPlayerId,
    connected: true,
    waiting: false,
  };
  roster.push(hostEntry);

  const roundRng = createRng(seed);

  /** phase: 'lobby' | 'inGame' | 'paused' | 'result' */
  const state = {
    phase: 'lobby',
    lastNow: 0,
    gi: 0,
    gameInstance: null,
    lastSettings: null,
    missingPlayerIds: new Set(), // onDisconnect='restart' で、戻りを待っている playerId
  };

  const pending = new Set(); // hello 待ちの conn
  const connectionsBySlot = new Map(); // slot -> conn

  function nextSeed() {
    return Math.floor(roundRng.next() * 0x100000000) >>> 0;
  }

  function allConnectedRemote() {
    return [...connectionsBySlot.values()].filter((c) => c.connected);
  }

  function broadcastFrame(m, exceptConn) {
    for (const conn of allConnectedRemote()) {
      if (conn === exceptConn) continue;
      conn.channel.frame.send(m);
    }
  }

  function broadcastRoster() {
    broadcastFrame(msg.roster(toWireRoster(roster)));
    events.onRoster?.(roster);
  }

  /** GameContext.roster を作る(local はこの端末=ホストの視点で決める) */
  function buildGameRoster(confirmed) {
    return confirmed.map((p) => ({
      slot: p.slot,
      name: p.name,
      kind: p.kind,
      local: p.kind === 'bot' || p.slot === hostEntry.slot,
    }));
  }

  function createHostGameNet(gi, remoteConns) {
    const handlers = [];
    const net = {
      send(slot, m) {
        const conn = remoteConns.find((c) => c.slot === slot);
        if (conn && conn.connected) conn.channel.game.send(gi, m);
      },
      broadcast(m, exceptSlot) {
        for (const conn of remoteConns) {
          if (!conn.connected) continue;
          if (conn.slot === exceptSlot) continue;
          conn.channel.game.send(gi, m);
        }
      },
      onMessage(fn) {
        handlers.push(fn);
      },
      remoteSlots() {
        return remoteConns.filter((c) => c.connected).map((c) => c.slot);
      },
      _dispatch(slot, m) {
        for (const fn of handlers) fn(slot, m);
      },
    };
    return net;
  }

  /** 今の名簿から、この端末(ホスト)が管理するリモート(人間・非ローカル)接続の一覧を作る */
  function remoteConnsForRound(confirmed) {
    const slots = new Set(confirmed.filter((p) => p.kind === 'human' && p.slot !== hostEntry.slot).map((p) => p.slot));
    return [...connectionsBySlot.values()].filter((c) => slots.has(c.slot));
  }

  function launchRound(gi, confirmed, seedForRound, settings) {
    state.gi = gi;
    state.phase = 'inGame';
    state.lastSettings = settings;

    const remoteConns = remoteConnsForRound(confirmed);
    const net = createHostGameNet(gi, remoteConns);
    currentGameNet = net;

    const extras = createGameCtxExtras() || {};
    const ctx = {
      role: 'host',
      localSlot: hostEntry.slot,
      roster: buildGameRoster(confirmed),
      seed: seedForRound,
      settings: settings || {},
      net,
      clock: { hostNow: () => state.lastNow },
      log: extras.log || noop,
      dom: extras.dom ?? null,
      onResult: (result) => handleResult(gi, result),
    };

    state.gameInstance = definition.createGame(ctx);

    const wireRoster = confirmed.map((p) => ({ slot: p.slot, name: p.name, kind: p.kind }));
    for (const conn of remoteConns) {
      if (!conn.connected) continue;
      conn.channel.frame.send(msg.startGame(gi, definition.id, seedForRound, wireRoster, settings || {}));
    }

    events.onGameStart?.({ gi, roster: confirmed, seed: seedForRound, settings: settings || {} });
  }

  let currentGameNet = null;

  function handleResult(gi, result) {
    if (gi !== state.gi || state.phase !== 'inGame') return; // 古い/破棄済みインスタンスからの呼び出しは無視
    state.phase = 'result';
    try {
      state.gameInstance?.dispose();
    } catch {
      /* dispose の失敗でホストを落とさない */
    }
    state.gameInstance = null;
    currentGameNet = null;
    for (const conn of allConnectedRemote()) {
      conn.channel.frame.send(msg.endGame(gi, result));
    }
    events.onGameEnd?.(result);
  }

  function resumeAfterPause(now) {
    state.lastNow = now;
    const gi = state.gi + 1;
    const seedForRound = nextSeed();
    const confirmed = confirmedForGame(roster);
    for (const conn of allConnectedRemote()) {
      conn.channel.frame.send(msg.resumed());
    }
    events.onResumed?.();
    launchRound(gi, confirmed, seedForRound, state.lastSettings);
  }

  function pauseForDisconnect() {
    if (state.phase === 'paused') return;
    state.phase = 'paused';
    try {
      state.gameInstance?.dispose();
    } catch {
      /* noop */
    }
    state.gameInstance = null;
    currentGameNet = null;
    broadcastFrame(msg.paused());
    events.onPaused?.();
  }

  function handleConnClose(conn) {
    if (conn.slot == null) {
      pending.delete(conn);
      return;
    }
    if (connectionsBySlot.get(conn.slot) === conn) {
      connectionsBySlot.delete(conn.slot);
    }
    markDisconnected(roster, conn.playerId);
    broadcastRoster();

    if (state.phase === 'inGame') {
      const gi = state.gi;
      if (onDisconnect === 'continue') {
        for (const c of allConnectedRemote()) c.channel.frame.send(msg.playerLeft(gi, conn.slot));
        try {
          state.gameInstance?.onPlayerLeft(conn.slot);
        } catch {
          /* noop */
        }
      } else {
        // 'restart': このラウンドの参加者が戻るまで一時停止する
        state.missingPlayerIds.add(conn.playerId);
        pauseForDisconnect();
      }
    } else if (state.phase === 'paused') {
      state.missingPlayerIds.add(conn.playerId);
    }
  }

  function handleHello(conn, m) {
    if (m.v !== FRAME_VERSION) {
      conn.channel.frame.send(msg.reject('version'));
      return;
    }

    const existing = roster.find((p) => p.kind === 'human' && p.playerId === m.playerId);
    const isResuming =
      !!existing && state.phase === 'paused' && onDisconnect === 'restart' && state.missingPlayerIds.has(m.playerId);
    const gameInProgress = !isResuming && (state.phase === 'inGame' || state.phase === 'paused');

    const entry = joinHuman(roster, {
      playerId: m.playerId,
      name: m.name,
      maxPlayers,
      gameInProgress,
    });
    if (!entry) {
      conn.channel.frame.send(msg.reject('full'));
      return;
    }

    if (isResuming) {
      state.missingPlayerIds.delete(m.playerId);
      entry.waiting = false;
    }

    pending.delete(conn);
    conn.slot = entry.slot;
    conn.playerId = m.playerId;
    connectionsBySlot.set(entry.slot, conn);

    conn.channel.frame.send(msg.welcome(entry.slot, toWireRoster(roster), state.phase));
    broadcastRoster();

    if (isResuming && state.missingPlayerIds.size === 0) {
      resumeAfterPause(state.lastNow);
    }
  }

  function handlePing(conn, m) {
    conn.channel.frame.send(msg.pong(m.c, state.lastNow));
  }

  function handleLeave(conn) {
    if (conn.slot == null) return;
    // leave は明示的な離脱。切断と同じ扱いにする(次のゲームからは名簿ごと外れてよいので、
    // continue/restart の方針に関わらずここで名簿からも取り除く)。
    removeBySlot(roster, conn.slot);
    connectionsBySlot.delete(conn.slot);
    conn.slot = null;
    broadcastRoster();
  }

  function acceptTransport(transport) {
    const channel = wrapChannel(transport);
    const conn = { transport, channel, slot: null, playerId: null, connected: true };
    pending.add(conn);

    channel.frame.onMessage((m) => {
      switch (m.t) {
        case FRAME_MSG.HELLO:
          handleHello(conn, m);
          break;
        case FRAME_MSG.PING:
          handlePing(conn, m);
          break;
        case FRAME_MSG.LEAVE:
          handleLeave(conn);
          break;
        default:
          break;
      }
    });

    channel.game.onMessage((gi, m) => {
      if (!currentGameNet || gi !== state.gi || conn.slot == null) return;
      currentGameNet._dispatch(conn.slot, m);
    });

    channel.transport.onClose(() => {
      conn.connected = false;
      handleConnClose(conn);
    });

    return conn;
  }

  function addBot(name) {
    const entry = rosterAddBot(roster, name, { maxPlayers });
    if (entry) broadcastRoster();
    return entry;
  }

  function removeBot(slot) {
    const entry = roster.find((p) => p.slot === slot);
    if (!entry || entry.kind !== 'bot') return false;
    const removed = removeBySlot(roster, slot);
    if (removed) broadcastRoster();
    return removed;
  }

  function startGame(settings, now) {
    state.lastNow = now;
    admitWaiting(roster); // 観戦待ちだった人を今回の名簿に迎える
    const confirmed = confirmedForGame(roster);
    const gi = state.gi + 1;
    const seedForRound = nextSeed();
    launchRound(gi, confirmed, seedForRound, settings);
  }

  function backToLobby() {
    state.phase = 'lobby';
    state.gameInstance = null;
    currentGameNet = null;
    admitWaiting(roster);
    broadcastRoster();
  }

  function update(now) {
    state.lastNow = now;
    for (const conn of pending) conn.transport.pump(now);
    for (const conn of connectionsBySlot.values()) conn.transport.pump(now);
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
    acceptTransport,
    addBot,
    removeBot,
    startGame,
    backToLobby,
    update,
    render,
    get roster() {
      return roster;
    },
    get phase() {
      return state.phase;
    },
    // 主に T11/T12 やテストが「今どのラウンドか」を確かめるための補助(約束には無いが便利なので足す)。
    get gi() {
      return state.gi;
    },
    reconnectWaitSec,
  };
}
