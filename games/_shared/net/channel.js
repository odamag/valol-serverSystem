/**
 * 1本の `Transport` の上に、枠のメッセージ(`f`)とゲームのメッセージ(`g`)のチャンネルを多重化する(約束 8節)。
 * すべての送信を `{ c: 'f' | 'g', gi?, m }` で包み、受信側は `c` で振り分ける。
 * `gi`(ゲームのインスタンス ID)が今のインスタンスと一致するかどうかの確認は、ここでは行わない
 * (呼び出し側 = 枠(hostFrame/guestFrame、T8)の役目。ここでは gi をそのまま渡す)。
 *
 * @param {import('./transport.js').Transport} transport
 * @returns {{
 *   frame: { send(m: object): void, onMessage(fn: (m: object) => void): void },
 *   game: { send(gi: number, m: object): void, onMessage(fn: (gi: number, m: object) => void): void },
 *   transport: import('./transport.js').Transport,
 * }}
 */
export function wrapChannel(transport) {
  const frameHandlers = [];
  const gameHandlers = [];

  transport.onMessage((packet) => {
    if (!packet || typeof packet !== 'object') return;
    if (packet.c === 'f') {
      for (const fn of frameHandlers) fn(packet.m);
    } else if (packet.c === 'g') {
      for (const fn of gameHandlers) fn(packet.gi, packet.m);
    }
  });

  return {
    frame: {
      send(m) {
        transport.send({ c: 'f', m });
      },
      onMessage(fn) {
        frameHandlers.push(fn);
      },
    },
    game: {
      send(gi, m) {
        transport.send({ c: 'g', gi, m });
      },
      onMessage(fn) {
        gameHandlers.push(fn);
      },
    },
    // close/onClose を中継せず、元の transport をそのまま返す(呼び出し側は channel.transport.close() /
    // channel.transport.onClose(fn) を使う)。二重に close ハンドラを管理しないための判断。詳しくは報告に書く。
    transport,
  };
}
