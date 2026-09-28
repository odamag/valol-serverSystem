/**
 * 通信の下位層のインターフェース(約束 11節)。実体は持たない(JSDoc の @typedef だけ)。
 * `loopback.js`(ヘッドレス・テスト用)と `peer.js`(PeerJS。ブラウザ専用、別タスク)が、
 * このインターフェースを満たすオブジェクトを作る。`channel.js` はこの上に乗る。
 *
 * @typedef {object} Transport
 * @property {(msg: object) => void} send
 *   メッセージを送る。JSON にできるプレーンオブジェクトであること。
 * @property {(fn: (msg: object) => void) => void} onMessage
 *   メッセージを受け取るたびに呼ばれるハンドラを登録する(複数登録できる)。
 * @property {(fn: () => void) => void} onClose
 *   接続が閉じたときに呼ばれるハンドラを登録する(複数登録できる)。
 * @property {() => void} close
 *   接続を閉じる。相手側の `onClose` を呼ぶ。
 * @property {(now: number) => void} pump
 *   届く時刻になったメッセージを配る。loopback だけが意味を持つ(PeerJS 側は何もしない)。
 */

export {};
