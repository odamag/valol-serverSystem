/**
 * MG01 Race のゲームメッセージ(設計書 9.2節)。すべて `{ t: 種類, ... }` の JSON。
 * 枠がゲームのインスタンス ID(gi)をつけて包む(約束 4節)ので、ここではラウンド ID を持たない。
 */

/** メッセージの種類(`t`)。値と定数名を一致させる */
export const MSG = Object.freeze({
  // クライアント → ホスト
  KART_STATE: 'kartState',
  REPORT_CHECKPOINT: 'reportCheckpoint',
  REQUEST_PICKUP: 'requestPickup',
  REQUEST_USE_ITEM: 'requestUseItem',
  REPORT_HIT: 'reportHit',

  // ホスト → クライアント
  ROUND_START: 'roundStart',
  KARTS: 'karts',
  PROGRESS: 'progress',
  BOX_STATE: 'boxState',
  ITEM_GRANTED: 'itemGranted',
  ITEM_CLEARED: 'itemCleared',
  SPAWN_OBJ: 'spawnObj',
  OBJ_STATE: 'objState',
  DESPAWN_OBJ: 'despawnObj',
  APPLY_SPIN: 'applySpin',
  APPLY_BOOST: 'applyBoost',
  SHIELD_STATE: 'shieldState',
  PLAYER_FINISHED: 'playerFinished',
  RACE_END: 'raceEnd',
});

/** 各メッセージの作成関数。`msg.<t名>(...)` の形にそろえる。 */
export const msg = {
  // クライアント → ホスト
  /** @param {number} ts @param {number} x @param {number} z @param {number} yaw @param {number} speed @param {number} spinT @param {number} boostT */
  kartState: (ts, x, z, yaw, speed, spinT, boostT) => ({
    t: MSG.KART_STATE,
    ts,
    x,
    z,
    yaw,
    speed,
    spinT,
    boostT,
  }),
  /** @param {number} lap @param {number} cp */
  reportCheckpoint: (lap, cp) => ({ t: MSG.REPORT_CHECKPOINT, lap, cp }),
  /** @param {number} boxId */
  requestPickup: (boxId) => ({ t: MSG.REQUEST_PICKUP, boxId }),
  /** @param {boolean} backward */
  requestUseItem: (backward) => ({ t: MSG.REQUEST_USE_ITEM, backward }),
  /** @param {number} objId */
  reportHit: (objId) => ({ t: MSG.REPORT_HIT, objId }),

  // ホスト → クライアント
  /** @param {number} startAt @param {number} laps @param {Array<{slot:number, gridIndex:number}>} grid */
  roundStart: (startAt, laps, grid) => ({ t: MSG.ROUND_START, startAt, laps, grid }),
  /** @param {number} ts @param {Array<object>} list */
  karts: (ts, list) => ({ t: MSG.KARTS, ts, list }),
  /** @param {number} elapsedMs @param {Array<object>} players */
  progress: (elapsedMs, players) => ({ t: MSG.PROGRESS, elapsedMs, players }),
  /** @param {number} boxId @param {boolean} active */
  boxState: (boxId, active) => ({ t: MSG.BOX_STATE, boxId, active }),
  /** @param {number} slot @param {string} item @param {number} rouletteMs */
  itemGranted: (slot, item, rouletteMs) => ({ t: MSG.ITEM_GRANTED, slot, item, rouletteMs }),
  /** @param {number} slot */
  itemCleared: (slot) => ({ t: MSG.ITEM_CLEARED, slot }),
  /** @param {number} id @param {string} type @param {number} owner @param {number} x @param {number} z @param {number} yaw @param {boolean} active */
  spawnObj: (id, type, owner, x, z, yaw, active) => ({
    t: MSG.SPAWN_OBJ,
    id,
    type,
    owner,
    x,
    z,
    yaw,
    active,
  }),
  /** @param {number} ts @param {Array<object>} objs */
  objState: (ts, objs) => ({ t: MSG.OBJ_STATE, ts, objs }),
  /** @param {number} id @param {'hit'|'expired'|'wall'} reason */
  despawnObj: (id, reason) => ({ t: MSG.DESPAWN_OBJ, id, reason }),
  /** @param {number} slot */
  applySpin: (slot) => ({ t: MSG.APPLY_SPIN, slot }),
  /** @param {number} slot @param {number} durationSec @param {number} bonus */
  applyBoost: (slot, durationSec, bonus) => ({ t: MSG.APPLY_BOOST, slot, durationSec, bonus }),
  /** @param {number} slot @param {boolean} active */
  shieldState: (slot, active) => ({ t: MSG.SHIELD_STATE, slot, active }),
  /** @param {number} slot @param {number} place @param {number} timeMs */
  playerFinished: (slot, place, timeMs) => ({ t: MSG.PLAYER_FINISHED, slot, place, timeMs }),
  /** @param {'allFinished'|'grace'|'first'|'timeout'} reason @param {Array<object>} results */
  raceEnd: (reason, results) => ({ t: MSG.RACE_END, reason, results }),
};
