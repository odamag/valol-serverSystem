/**
 * 枠(frame)のメッセージ(約束 8節)。
 * ここで作るのはチャンネルで包む前の `m` の中身だけ。`{ c: 'f' | 'g', gi?, m }` で包むのは
 * `_shared/net/channel.js`(T2)の役目なので、このファイルはそれを知らない。
 */

/** 枠のプロトコルのバージョン。ゲストの `hello.v` がこれと違えば `reject: 'version'` */
export const FRAME_VERSION = 1;

/** 枠のメッセージの種類(`m.t`)。値と定数名を一致させておく(ログやテストで見分けやすいように) */
export const FRAME_MSG = Object.freeze({
  HELLO: 'hello',
  PING: 'ping',
  LEAVE: 'leave',
  WELCOME: 'welcome',
  REJECT: 'reject',
  PONG: 'pong',
  ROSTER: 'roster',
  START_GAME: 'startGame',
  PLAYER_LEFT: 'playerLeft',
  END_GAME: 'endGame',
  PAUSED: 'paused',
  RESUMED: 'resumed',
});

/**
 * 各メッセージの作成関数。`msg.<t名>(...)` の形にそろえる(race 側の `game/protocol.js` と同じ流儀)。
 * 戻り値はすべて `m` の中身(`t` を含む、JSON にできるプレーンオブジェクト)。
 */
export const msg = {
  // ゲスト → ホスト
  /** @param {string} playerId @param {string} name */
  hello: (playerId, name) => ({ t: FRAME_MSG.HELLO, v: FRAME_VERSION, playerId, name }),
  /** @param {number} c ゲストの時刻(送信時) */
  ping: (c) => ({ t: FRAME_MSG.PING, c }),
  leave: () => ({ t: FRAME_MSG.LEAVE }),

  // ホスト → ゲスト
  /** @param {number} slot @param {Array<object>} roster @param {string} phase */
  welcome: (slot, roster, phase) => ({ t: FRAME_MSG.WELCOME, slot, roster, phase }),
  /** @param {'full'|'version'} reason */
  reject: (reason) => ({ t: FRAME_MSG.REJECT, reason }),
  /** @param {number} c ゲストが送った時刻(そのまま返す) @param {number} h ホストの時刻 */
  pong: (c, h) => ({ t: FRAME_MSG.PONG, c, h }),
  /** @param {Array<{slot:number,name:string,kind:'human'|'bot',connected:boolean,waiting:boolean}>} players */
  roster: (players) => ({ t: FRAME_MSG.ROSTER, players }),
  /** @param {number} gi @param {string} gameId @param {number} seed @param {Array<object>} roster @param {object} settings */
  startGame: (gi, gameId, seed, roster, settings) => ({
    t: FRAME_MSG.START_GAME,
    gi,
    gameId,
    seed,
    roster,
    settings,
  }),
  /** @param {number} gi @param {number} slot */
  playerLeft: (gi, slot) => ({ t: FRAME_MSG.PLAYER_LEFT, gi, slot }),
  /** @param {number} gi @param {object} result */
  endGame: (gi, result) => ({ t: FRAME_MSG.END_GAME, gi, result }),
  paused: () => ({ t: FRAME_MSG.PAUSED }),
  resumed: () => ({ t: FRAME_MSG.RESUMED }),
};
