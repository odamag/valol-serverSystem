/**
 * ヘッドレス・テスト用の `Transport`(約束 11節)のペアを作る。PeerJS の DataConnection の代わり。
 * @param {{ latencyMs?: number, jitterMs?: number, rng?: { range(a: number, b: number): number } }} [opts]
 * @returns {[import('./transport.js').Transport, import('./transport.js').Transport]}
 */
export function createLoopbackPair({ latencyMs = 0, jitterMs = 0, rng } = {}) {
  if (jitterMs > 0 && typeof rng?.range !== 'function') {
    // jitter をかけるには、両端で決定的な乱数列を共有できるように rng が要る(Math.random は禁止。約束 10節)。
    throw new Error('createLoopbackPair: jitterMs を使うときは rng が必要です');
  }

  // 片方向ごとにキューを持つ。lastArrival は「順番を入れ替えない」を守るための下限。
  const linkAtoB = { queue: [], lastArrival: -Infinity };
  const linkBtoA = { queue: [], lastArrival: -Infinity };

  const a = createEndpoint(linkAtoB, linkBtoA, { latencyMs, jitterMs, rng });
  const b = createEndpoint(linkBtoA, linkAtoB, { latencyMs, jitterMs, rng });
  a.peer = b;
  b.peer = a;
  return [a, b];
}

/** シリアライズできないものが混ざっていないか確かめつつコピーする(約束 11節) */
function cloneForWire(msg) {
  const json = JSON.stringify(msg, (key, value) => {
    if (typeof value === 'function') {
      throw new TypeError(`loopback: メッセージに関数を含められません(key="${key}")`);
    }
    return value;
  });
  if (json === undefined) {
    throw new TypeError('loopback: メッセージを JSON にできません');
  }
  return JSON.parse(json);
}

/**
 * @param {{queue: Array, lastArrival: number}} outLink 自分が送るときに積むキュー
 * @param {{queue: Array, lastArrival: number}} inLink 自分が受け取るときに読むキュー
 */
function createEndpoint(outLink, inLink, { latencyMs, jitterMs, rng }) {
  const messageHandlers = [];
  const closeHandlers = [];
  // 送った時刻は「最後に pump(now) された時刻」を使う(約束 11節)。pump 前は 0 として扱う。
  let lastPumpNow = 0;

  const endpoint = {
    peer: null, // close() の相互呼び出し用(モジュール内だけで使う)
    closed: false,
    send(m) {
      if (endpoint.closed) return;
      const copy = cloneForWire(m);
      const jitter = jitterMs > 0 ? rng.range(0, jitterMs) : 0;
      let arrival = lastPumpNow + latencyMs + jitter;
      // jitter で前のメッセージより早くなっても、届く順番は入れ替えない。
      if (arrival < outLink.lastArrival) arrival = outLink.lastArrival;
      outLink.lastArrival = arrival;
      outLink.queue.push({ msg: copy, arrival });
    },
    onMessage(fn) {
      messageHandlers.push(fn);
    },
    onClose(fn) {
      closeHandlers.push(fn);
    },
    close() {
      if (endpoint.closed) return;
      endpoint.closed = true;
      const peer = endpoint.peer;
      if (peer && !peer.closed) {
        peer.closed = true;
        for (const fn of peer._closeHandlers) fn();
      }
    },
    pump(now) {
      lastPumpNow = now;
      while (inLink.queue.length > 0 && inLink.queue[0].arrival <= now) {
        const { msg } = inLink.queue.shift();
        for (const fn of messageHandlers) fn(msg);
      }
    },
    _closeHandlers: closeHandlers,
  };

  return endpoint;
}
