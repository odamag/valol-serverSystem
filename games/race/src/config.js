/**
 * MG01 Race の設定値(設計書 4節)。数値はすべてここから読み、コードに直接書かない(設計書 2.2節)。
 */

/** @type {object} 既定値。書き換えない(`makeConfig` がコピーを返す) */
export const RaceConfig = {
  laps: 2,
  timeLimitSec: 180,
  countdownSec: 3,
  startDelaySec: 1, // createGame からカウントダウン開始までの余裕(全員の生成を待つ)
  fixedDt: 1 / 60,

  finishRule: 'grace', // 'grace' | 'first'(約束 5節)
  finishGraceSec: 15, // 'grace' のとき、1位のゴールからこの秒数で打ち切る

  colors: [0x3b82f6, 0xef4444, 0x22c55e, 0xeab308, 0xa855f7, 0xf97316, 0x06b6d4, 0xec4899],
  // slot の順。0=青、1=赤(元仕様の A/B と同じ)

  kart: {
    maxSpeed: 26, // m/s(約94km/h)
    accel: 16,
    brakeDecel: 32,
    reverseMaxSpeed: 8,
    reverseAccel: 10,
    coastDecel: 5,
    overSpeedDecel: 20, // 最高速度を超えているときに落とす速さ(芝に入ったときなど)
    offroadMaxFactor: 0.5, // 芝での最高速度の倍率(元仕様4節)
    turnRateLow: 2.6,
    turnRateHigh: 1.6,
    turnFullSpeed: 4,
    radius: 1.1,
    wallRestitution: 0.5,
    wallSpeedKeep: 0.9,
    kartPushSpeedKeep: 0.95,
  },

  boost: { accelMul: 1.8 },
  boostPad: { durationSec: 1.0, bonus: 0.4, halfLength: 1.5, halfWidth: 2.5 },

  spin: { durationSec: 1.2, decelRate: 4, invulnAfterSec: 1.0, visualTurns: 2 },

  items: {
    dash: { durationSec: 2.0, bonus: 0.5 },
    rocket: { speed: 45, lifeSec: 3, radius: 0.7, ownerGraceSec: 0.5, spawnOffset: 3 },
    homing: {
      speed: 40,
      lifeSec: 8,
      radius: 0.7,
      ownerGraceSec: 0.5,
      spawnOffset: 3,
      turnRate: 3.5,
      directRange: 30,
      guideAhead: 15,
    },
    oil: {
      lifeSec: 15,
      radius: 1.8,
      ownerGraceSec: 1.0,
      dropOffset: 4,
      throwDistance: 18,
      throwSec: 0.5,
    },
    shield: { durationSec: 5 },
    // 抽選表(元仕様7.3節を、首位との差で選ぶ形に一般化。2人なら元仕様と同じ)
    tables: {
      leader: { Dash: 15, Rocket: 20, Homing: 0, Oil: 40, Shield: 25 },
      near: { Dash: 30, Rocket: 35, Homing: 15, Oil: 10, Shield: 10 },
      far: { Dash: 35, Rocket: 20, Homing: 40, Oil: 0, Shield: 5 },
    },
    farGapRatio: 0.25, // 首位との差がコース1/4周以上なら far
  },

  itemBox: { respawnSec: 5, rouletteSec: 0.8, pickupRadius: 1.8 },

  rubberband: { maxBonus: 0.06, fullGapRatio: 0.25 }, // 0にすれば無効

  wrongWay: { dotThreshold: -0.2, minSpeed: 3, holdSec: 0.8 },

  finished: { maxSpeedMul: 0.6 }, // ゴール後はボットが流す(10.2節)

  autopilot: {
    lookaheadBase: 12,
    lookaheadPerSpeed: 0.5,
    steerGain: 2.0,
    slowAngle: 0.6,
    speedJitter: 0.05,
    itemDelayMinSec: 0.5,
    itemDelayMaxSec: 2.0,
    laneOffsetMax: 4, // ボットごとに走るラインを左右にずらす(8台が一列に並ばないように)
  },

  net: { sendHz: 20, progressHz: 10, interpDelayMs: 100, extrapolateMaxMs: 200 },

  test: { effects: false, effectsMinSec: 4, effectsMaxSec: 8, forceItem: null, forceItemBySlot: {} },
};

/** overrides がプレーンオブジェクト(配列でない)かどうか */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `base` に `overrides` を深いマージしたコピーを返す。どちらの引数も変えない。
 * 配列は(部分マージせずに)まるごと置き換える。
 * @param {object} base
 * @param {object} [overrides]
 * @returns {object}
 */
function deepMerge(base, overrides) {
  // base 自体を深く複製する(ネストしたオブジェクト・配列も含めて参照を切る)。
  // overrides に出てこないキーも base の別インスタンスにしておかないと、
  // 呼び出し側が cfg を書き換えたときに元の RaceConfig まで書き換わってしまう。
  const result = deepClone(base);
  if (!overrides) return result;
  for (const key of Object.keys(overrides)) {
    const overrideValue = overrides[key];
    const baseValue = result[key];
    if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
      result[key] = deepMerge(baseValue, overrideValue);
    } else if (isPlainObject(overrideValue)) {
      result[key] = deepMerge({}, overrideValue);
    } else if (Array.isArray(overrideValue)) {
      result[key] = overrideValue.slice();
    } else {
      result[key] = overrideValue;
    }
  }
  return result;
}

/** プレーンオブジェクトと配列だけを再帰的に複製する(関数や Map などは扱わない。設定値は JSON 互換のため) */
function deepClone(value) {
  if (Array.isArray(value)) return value.map(deepClone);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) out[key] = deepClone(value[key]);
    return out;
  }
  return value;
}

/**
 * `RaceConfig` を上書きしたコピーを返す(`ctx.settings` がここに渡る)。元の `RaceConfig` は変えない。
 * @param {object} [overrides]
 * @returns {typeof RaceConfig}
 */
export function makeConfig(overrides) {
  return deepMerge(RaceConfig, overrides);
}
