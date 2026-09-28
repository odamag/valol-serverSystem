/**
 * 単発版の画面(約束 9節。ブラウザ専用)。タイトル → (ソロ | ロビー) → ゲーム → 結果、を
 * `createHostFrame`/`createGuestFrame`(11節)と `connectRoom`(7・11節)、`createTicker`(6節)で回す。
 *
 * `startStandalone(definition, { controlsHelp, parseSettings(urlParams) }, params)` の呼び方は
 * `index.html`(T0 で仮置き)が既に使っているので、ここで変えない。
 */
import { createHostFrame } from '../frame/hostFrame.js';
import { createGuestFrame } from '../frame/guestFrame.js';
import { createTicker } from '../frame/ticker.js';
import { connectRoom } from '../net/peer.js';
import * as lobby from './lobby.js';

const RECONNECT_INTERVAL_MS = 3000;
const RECONNECT_MAX_MS = 120000;

function ensureLobbyCss() {
  const href = new URL('./lobby.css', import.meta.url).href;
  if (document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}

// playerId はタブごと(sessionStorage)。localStorage だと同じブラウザの2つのタブが同じ ID になり、
// ホストがゲストを「自分の再接続」と取り違える(ブラウザで見つけた点)。同じタブの再読み込みでは残るので再接続に使える。
function getOrCreatePlayerId() {
  const KEY = 'bo5-playerId';
  try {
    let id = sessionStorage.getItem(KEY);
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    // localStorage が使えない(プライベートモード等)。この端末限りの ID にする。
    return crypto.randomUUID();
  }
}

function getSavedName() {
  try {
    return localStorage.getItem('bo5-name') || '';
  } catch {
    return '';
  }
}

function saveName(name) {
  try {
    localStorage.setItem('bo5-name', name);
  } catch {
    /* noop */
  }
}

/** 32bit の種を crypto から作る(約束 10節:Math.random 禁止のロジック側に合わせ、こちらも crypto を優先) */
function makeSeed() {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    return crypto.getRandomValues(new Uint32Array(1))[0];
  }
  return Math.floor(Math.random() * 0x100000000) >>> 0;
}

function formatLogFields(fields) {
  if (!fields) return '';
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' ');
}

/**
 * @param {object} definition 約束 2節の definition
 * @param {{ controlsHelp?: string, parseSettings?: (urlParams: URLSearchParams) => object, iceServers?: Array<object> }} opts
 * @param {URLSearchParams} params
 */
export function startStandalone(definition, opts, params) {
  ensureLobbyCss();

  const lobbyRoot = document.getElementById('lobby');
  const canvas = document.getElementById('game');
  const hudRoot = document.getElementById('hud');
  if (!lobbyRoot) throw new Error('startStandalone: #lobby が見つかりません');

  const debugEnabled = params.get('debug') === '1';
  const debugEl = debugEnabled ? document.createElement('div') : null;
  if (debugEl) {
    debugEl.className = 'bo5-debug';
    document.body.appendChild(debugEl);
  }

  const playerId = getOrCreatePlayerId();
  const log = (event, fields) => {
    // eslint-disable-next-line no-console
    console.log(`[BO5][${definition.id}] ${event} ${formatLogFields(fields)}`.trimEnd());
  };

  const parseSettings = typeof opts.parseSettings === 'function' ? opts.parseSettings : () => ({});
  const settings = parseSettings(params) || {};

  const state = {
    screen: 'title', // 'title' | 'connecting' | 'lobby' | 'inGame' | 'result' | 'reconnecting' | 'lost' | 'pausedHost'
    frame: null,
    frameKind: null, // 'host' | 'guest' | null(ソロも 'host' 扱い)
    room: (params.get('room') || '').trim(),
    name: (params.get('name') || getSavedName() || '').trim(),
    lastRoster: [],
    lastResult: null,
    connectHandle: null, // 今つないでいる HostSide/GuestSide(close() できる)
    pausedSince: null,
    reconnectStartedAt: null,
    reconnecting: false,
  };

  const ticker = createTicker(
    (now) => {
      state.frame?.update(now);
    },
    (now) => {
      state.frame?.render(now);
      updateDebug();
    },
  );

  let fpsLastT = null;
  let fpsSmoothed = null;
  function updateDebug() {
    if (!debugEl) return;
    const now = performance.now();
    if (fpsLastT != null) {
      const dt = now - fpsLastT;
      if (dt > 0) {
        const inst = 1000 / dt;
        fpsSmoothed = fpsSmoothed == null ? inst : fpsSmoothed * 0.9 + inst * 0.1;
      }
    }
    fpsLastT = now;
    lobby.renderDebug(debugEl, { phase: state.frame?.phase ?? state.screen, rtt: null, fps: fpsSmoothed });
  }

  function showCanvas(show) {
    if (canvas) canvas.style.display = show ? 'block' : 'none';
    if (hudRoot) hudRoot.style.display = show ? 'block' : 'none';
    lobbyRoot.style.display = show ? 'none' : 'flex';
  }

  function disposeFrame() {
    ticker.stop();
    state.connectHandle?.close?.();
    state.connectHandle = null;
    state.frame = null;
    state.frameKind = null;
  }

  function backToTitle(error) {
    disposeFrame();
    state.screen = 'title';
    showCanvas(false);
    render(error ? { error } : undefined);
  }

  // ---------------------------------------------------------------------
  // ソロ:PeerJS を使わず hostFrame だけを作り、ボットを足してすぐ startGame する。
  // ---------------------------------------------------------------------
  function startSolo(name) {
    state.name = name || state.name || 'Player';
    saveName(state.name);

    const frame = createHostFrame({
      definition,
      maxPlayers: definition.maxPlayers,
      onDisconnect: 'continue',
      hostName: state.name,
      playerId,
      seed: makeSeed(),
      createGameCtxExtras: () => ({ dom: { canvas, hudRoot }, log }),
      events: {
        onGameEnd: (result) => {
          state.lastResult = result;
          state.screen = 'result';
          showCanvas(false);
          render();
        },
      },
    });
    state.frame = frame;
    state.frameKind = 'host';

    const botCount = params.has('bots') ? Number(params.get('bots')) : 3;
    for (let i = 0; i < Math.max(0, botCount); i++) frame.addBot();

    ticker.start();
    state.screen = 'inGame';
    showCanvas(true);
    frame.startGame(settings, performance.now());
  }

  // ---------------------------------------------------------------------
  // 部屋(ホスト/ゲスト)
  // ---------------------------------------------------------------------
  function wireHostEvents(frame) {
    return {
      onRoster: (r) => {
        state.lastRoster = r;
        if (state.screen === 'lobby') render();
      },
      onGameStart: () => {
        state.screen = 'inGame';
        showCanvas(true);
        render();
      },
      onGameEnd: (result) => {
        state.lastResult = result;
        state.screen = 'result';
        showCanvas(false);
        render();
      },
      onPaused: () => {
        state.pausedSince = performance.now();
        state.screen = 'lobby'; // 'continue' が既定なので、実際にここへ来るのは restart 設定のときだけ
        showCanvas(false);
        render();
      },
      onResumed: () => {
        state.pausedSince = null;
      },
    };
  }

  function wireGuestEvents() {
    return {
      onRoster: (r) => {
        state.lastRoster = r;
        if (state.screen === 'lobby') render();
      },
      onGameStart: () => {
        state.screen = 'inGame';
        showCanvas(true);
        render();
      },
      onGameEnd: (result) => {
        state.lastResult = result;
        state.screen = 'result';
        showCanvas(false);
        render();
      },
      onPaused: () => {
        state.screen = 'lobby';
        showCanvas(false);
        render();
      },
      onResumed: () => {},
      onReject: (reason) => {
        disposeFrame();
        state.screen = 'lost';
        state.lostReason = reason === 'full' ? '満員です' : reason === 'version' ? 'バージョンが合いません' : String(reason);
        showCanvas(false);
        render();
      },
      onHostLost: () => {
        handleHostLost();
      },
    };
  }

  function setupAsHost(hostSide) {
    state.connectHandle = hostSide;
    const frame = createHostFrame({
      definition,
      maxPlayers: definition.maxPlayers,
      onDisconnect: 'continue',
      hostName: state.name,
      playerId,
      seed: makeSeed(),
      createGameCtxExtras: () => ({ dom: { canvas, hudRoot }, log }),
      events: wireHostEvents(),
    });
    state.frame = frame;
    state.frameKind = 'host';
    hostSide.onGuest((transport) => frame.acceptTransport(transport));
    ticker.start();
    state.screen = 'lobby';
    showCanvas(false);
    render();
  }

  function setupAsGuest(guestSide) {
    state.connectHandle = guestSide;
    const frame = createGuestFrame({
      definition,
      name: state.name,
      playerId,
      transport: guestSide.transport,
      createGameCtxExtras: () => ({ dom: { canvas, hudRoot }, log }),
      events: wireGuestEvents(),
    });
    state.frame = frame;
    state.frameKind = 'guest';
    ticker.start();
    state.screen = 'lobby';
    showCanvas(false);
    render();
  }

  function joinRoom(name, room) {
    state.name = name || state.name || 'Player';
    state.room = room;
    saveName(state.name);
    if (!room) {
      render({ error: '合言葉を入力してください' });
      return;
    }

    state.screen = 'connecting';
    render();

    connectRoom(definition.id, room, {
      iceServers: opts.iceServers,
      onStatus: (status) => {
        if (state.screen === 'connecting') render({ status });
      },
    })
      .then((result) => {
        if (result.role === 'host') setupAsHost(result);
        else setupAsGuest(result);
      })
      .catch((err) => {
        backToTitle(`つながりませんでした(${err && err.message ? err.message : err})`);
      });
  }

  // ---------------------------------------------------------------------
  // 再接続(約束 7節:ゲストは3秒ごと、最長120秒。あきらめるボタンあり)
  // ---------------------------------------------------------------------
  function handleHostLost() {
    const frame = state.frame;
    if (!frame || state.frameKind !== 'guest') return;
    if (!frame.shouldReconnect()) {
      disposeFrame();
      state.screen = 'lost';
      state.lostReason = 'ホストとの接続が切れました';
      showCanvas(false);
      render();
      return;
    }
    state.reconnecting = true;
    state.reconnectStartedAt = performance.now();
    state.screen = 'reconnecting';
    showCanvas(false);
    render();
    scheduleReconnectAttempt(0);
  }

  function scheduleReconnectAttempt(delayMs) {
    setTimeout(() => attemptReconnect(), delayMs);
  }

  function attemptReconnect() {
    if (!state.reconnecting) return;
    const elapsed = performance.now() - state.reconnectStartedAt;
    if (elapsed > RECONNECT_MAX_MS) {
      giveUpReconnect();
      return;
    }
    connectRoom(definition.id, state.room, { iceServers: opts.iceServers, onStatus: () => {} })
      .then((result) => {
        if (!state.reconnecting) return;
        if (result.role !== 'guest') {
          // ホストが既に戻っていて自分がホストになってしまった、等の想定外のケース。あきらめて再接続を続けさせる。
          result.close?.();
          scheduleReconnectAttempt(RECONNECT_INTERVAL_MS);
          return;
        }
        state.connectHandle?.close?.();
        state.connectHandle = result;
        state.frame.replaceTransport(result.transport);
        state.reconnecting = false;
        state.screen = state.frame.phase === 'inGame' ? 'inGame' : 'lobby';
        showCanvas(state.screen === 'inGame');
        render();
      })
      .catch(() => {
        if (!state.reconnecting) return;
        scheduleReconnectAttempt(RECONNECT_INTERVAL_MS);
      });
  }

  function giveUpReconnect() {
    state.reconnecting = false;
    disposeFrame();
    state.screen = 'lost';
    state.lostReason = 'ホストに再接続できませんでした';
    showCanvas(false);
    render();
  }

  // ---------------------------------------------------------------------
  // 描画
  // ---------------------------------------------------------------------
  function render(extra) {
    const frame = state.frame;
    switch (state.screen) {
      case 'title':
        lobby.renderTitle(lobbyRoot, {
          definition,
          name: state.name,
          room: state.room,
          controlsHelp: opts.controlsHelp,
          error: extra?.error,
          onSolo: (name) => startSolo(name),
          onJoin: (name, room) => joinRoom(name, room),
        });
        break;
      case 'connecting':
        lobby.renderConnecting(lobbyRoot, {
          status: extra?.status,
          onCancel: () => backToTitle(),
        });
        break;
      case 'lobby': {
        if (!frame) {
          backToTitle();
          return;
        }
        if (state.pausedSince != null) {
          const waited = (performance.now() - state.pausedSince) / 1000;
          if (waited > frame.reconnectWaitSec) {
            lobby.renderPausedHost(lobbyRoot, {
              secondsWaited: waited,
              onWaitMore: () => {
                state.pausedSince = performance.now();
                render();
              },
              onEnd: () => {
                frame.backToLobby();
                state.pausedSince = null;
                render();
              },
            });
            break;
          }
        }
        const roster = state.frameKind === 'host' ? frame.roster : state.lastRoster;
        lobby.renderLobby(lobbyRoot, {
          definition,
          roster,
          room: state.room,
          isHost: state.frameKind === 'host',
          localSlot: state.frameKind === 'host' ? 0 : frame.localSlot,
          maxPlayers: definition.maxPlayers,
          onAddBot: () => frame.addBot(),
          onRemoveBot: (slot) => frame.removeBot(slot),
          onStart: () => frame.startGame(settings, performance.now()),
          onLeave: () => {
            frame.leave?.();
            backToTitle();
          },
        });
        break;
      }
      case 'inGame':
        showCanvas(true);
        break;
      case 'result': {
        const roster = state.frameKind === 'host' ? frame.roster : state.lastRoster;
        lobby.renderResult(lobbyRoot, {
          definition,
          result: state.lastResult,
          roster,
          isHost: state.frameKind === 'host',
          onAgain: () => {
            state.screen = 'inGame';
            showCanvas(true);
            frame.startGame(settings, performance.now());
          },
          onBackToLobby: () => {
            frame.backToLobby();
            state.screen = 'lobby';
            showCanvas(false);
            render();
          },
        });
        break;
      }
      case 'reconnecting': {
        const secondsLeft = (RECONNECT_MAX_MS - (performance.now() - state.reconnectStartedAt)) / 1000;
        lobby.renderReconnecting(lobbyRoot, {
          secondsLeft,
          status: extra?.status,
          onGiveUp: () => giveUpReconnect(),
        });
        break;
      }
      case 'lost':
        lobby.renderLost(lobbyRoot, {
          reason: state.lostReason,
          onBack: () => backToTitle(),
        });
        break;
      default:
        break;
    }
  }

  // ソロ(?solo=1)/ 部屋への直接リンク(?room=)は、タイトルを経由せずに始める。
  if (params.get('solo') === '1') {
    startSolo(state.name);
  } else if (state.room) {
    joinRoom(state.name, state.room);
  } else {
    render();
  }

  // 再接続待ちの残り秒数表示を毎秒更新する(state.screen === 'reconnecting' の間だけ)。
  setInterval(() => {
    if (state.screen === 'reconnecting') render();
  }, 1000);
}
