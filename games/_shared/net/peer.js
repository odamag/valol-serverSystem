/**
 * PeerJS による接続(約束 7・11節。ブラウザ専用)。合言葉から決まる ID を取れればホスト、
 * `unavailable-id` ならゲスト(ID はランダム)として `Peer` を作る。グローバルの `Peer`(index.html で
 * `<script>` 読み込み済み)をそのまま使う。DataConnection は `Transport`(約束 11節。`net/transport.js`)に包む。
 */

/** これだけの間なにも届かなければ、接続が切れたとみなす(ms) */
const SILENCE_MS = 5000;

/** タブを閉じる/移動するときに Peer を壊して、相手にすぐ切断を伝える */
function destroyOnPageHide(peer) {
  if (typeof window === 'undefined') return;
  window.addEventListener('pagehide', () => {
    try {
      peer.destroy();
    } catch {
      /* noop */
    }
  });
}

/** 合言葉を英数字だけに正規化する */
function normalizeRoom(room) {
  return String(room || '').replace(/[^a-zA-Z0-9]/g, '');
}

/** ホストの PeerJS ID(約束 7節:`bo5-{gameId}-{合言葉}`) */
function hostIdFor(gameId, room) {
  return `bo5-${gameId}-${normalizeRoom(room)}`;
}

/**
 * PeerJS の `DataConnection` を `Transport`(約束 11節)に包む。
 * PeerJS はブラウザの外へ非同期に届けるので `pump` は何もしない(loopback だけが意味を持つ)。
 * @param {*} conn PeerJS DataConnection(接続済み = 'open' 後であること)
 * @returns {import('./transport.js').Transport}
 */
function wrapConnection(conn) {
  const messageHandlers = [];
  const closeHandlers = [];
  let closed = false;
  let lastDataAt = Date.now();

  function fireClose() {
    if (closed) return;
    closed = true;
    clearInterval(watchdog);
    for (const fn of closeHandlers) fn();
  }

  // 相手のタブが閉じられても PeerJS の 'close' がなかなか来ないことがある(ブラウザで見つけた点)。
  // ゲストは1秒ごとに ping、ホストは pong を返すので(約束 8節)、SILENCE_MS 何も届かなければ切れたとみなす。
  const watchdog = setInterval(() => {
    if (Date.now() - lastDataAt > SILENCE_MS) {
      try {
        conn.close();
      } catch {
        /* noop */
      }
      fireClose();
    }
  }, 1000);

  conn.on('data', (data) => {
    if (closed) return;
    lastDataAt = Date.now();
    for (const fn of messageHandlers) fn(data);
  });
  conn.on('close', fireClose);
  conn.on('error', fireClose);

  return {
    send(msg) {
      if (closed) return;
      try {
        if (conn.open) conn.send(msg);
      } catch {
        /* 相手が既に消えている等。onClose 側で気づく */
      }
    },
    onMessage(fn) {
      messageHandlers.push(fn);
    },
    onClose(fn) {
      closeHandlers.push(fn);
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(watchdog);
      try {
        conn.close();
      } catch {
        /* noop */
      }
    },
    pump() {
      /* PeerJS はメッセージを非同期に配るので何もしない(約束 11節) */
    },
  };
}

/**
 * 部屋に接続する。ホストの ID が取れればホスト、`unavailable-id` ならゲストとして接続する。
 * @param {string} gameId `definition.id`(または BO5Arena では `'arena'`)
 * @param {string} room 合言葉(英数字以外は正規化で落ちる)
 * @param {{ iceServers?: Array<object>, onStatus?: (status: string) => void }} [opts]
 * @returns {Promise<
 *   | { role: 'host', peerId: string, onGuest: (fn: (t: import('./transport.js').Transport) => void) => void, close(): void }
 *   | { role: 'guest', peerId: string, transport: import('./transport.js').Transport, close(): void }
 * >}
 */
export function connectRoom(gameId, room, opts = {}) {
  const { iceServers, onStatus = () => {} } = opts;
  const peerOptions = iceServers && iceServers.length > 0 ? { config: { iceServers } } : {};
  const hostId = hostIdFor(gameId, room);

  if (typeof Peer === 'undefined') {
    return Promise.reject(new Error('PeerJS(グローバルの Peer)が読み込まれていません'));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    onStatus('接続しています...');

    function asGuest() {
      onStatus('ホストに接続しています...');
      const peer = new Peer(undefined, peerOptions);
      destroyOnPageHide(peer);

      peer.on('open', () => {
        const conn = peer.connect(hostId, { reliable: true });
        let opened = false;

        conn.on('open', () => {
          if (settled) return;
          settled = true;
          opened = true;
          onStatus('接続しました');
          resolve({
            role: 'guest',
            peerId: peer.id,
            transport: wrapConnection(conn),
            close() {
              try {
                peer.destroy();
              } catch {
                /* noop */
              }
            },
          });
        });

        conn.on('error', (err) => {
          if (!opened && !settled) {
            settled = true;
            reject(err instanceof Error ? err : new Error('接続に失敗しました'));
            try {
              peer.destroy();
            } catch {
              /* noop */
            }
          }
        });
      });

      peer.on('error', (err) => {
        if (!settled) {
          settled = true;
          onStatus(`エラー: ${err && err.type}`);
          reject(err instanceof Error ? err : new Error(String(err && err.type)));
          try {
            peer.destroy();
          } catch {
            /* noop */
          }
        }
      });
    }

    // まずホストの ID を確保しようとする。`unavailable-id`(既にホストがいる)ならゲストへ切り替える。
    const probe = new Peer(hostId, peerOptions);
    let switched = false;
    probe.on('open', () => {
      // 実際に使うのはこの peer 自身(asHost 側で作り直さない)。
      if (settled) {
        try {
          probe.destroy();
        } catch {
          /* noop */
        }
        return;
      }
      settled = true;
      destroyOnPageHide(probe);
      onStatus('部屋を作りました(ホスト)');
      const guestHandlers = [];
      probe.on('connection', (conn) => {
        conn.on('open', () => {
          const transport = wrapConnection(conn);
          for (const fn of guestHandlers) fn(transport);
        });
      });
      resolve({
        role: 'host',
        peerId: hostId,
        onGuest(fn) {
          guestHandlers.push(fn);
        },
        close() {
          try {
            probe.destroy();
          } catch {
            /* noop */
          }
        },
      });
    });
    probe.on('error', (err) => {
      if (settled || switched) return;
      if (err && err.type === 'unavailable-id') {
        switched = true;
        try {
          probe.destroy();
        } catch {
          /* noop */
        }
        asGuest();
        return;
      }
      settled = true;
      onStatus(`エラー: ${err && err.type}`);
      reject(err instanceof Error ? err : new Error(String(err && err.type)));
      try {
        probe.destroy();
      } catch {
        /* noop */
      }
    });
  });
}
