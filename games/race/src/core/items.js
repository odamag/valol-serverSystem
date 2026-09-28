/**
 * アイテムの種類と抽選(設計書 8.1節)。
 * 表は「首位か・首位とどれだけ差があるか」で選ぶ(元仕様7.3節を一般化)。2人なら元仕様と同じ結果になる。
 * DOM・three・Date.now・Math.random には触れない(設計書 2.2節)。乱数は渡された rng だけを使う。
 */

/** @type {string[]} アイテムの種類。表のキーと同じ並びにしておく(rollItem の抽選で使う) */
export const ITEMS = ['Dash', 'Rocket', 'Homing', 'Oil', 'Shield'];

/**
 * rank と首位との差(gapRatio)から使う表の名前を選ぶ(設計書 8.1節)。
 * - rank 1(首位)は常に 'leader'。
 * - それ以外は、gapRatio が farGapRatio 以上なら 'far'、未満なら 'near'。
 * @param {number} rank 1始まりの順位
 * @param {number} gapRatio 首位との差(コース1周に対する割合。首位は0)
 * @param {object} cfg makeConfig() が返す設定
 * @returns {'leader'|'near'|'far'}
 */
export function tableNameFor(rank, gapRatio, cfg) {
  if (rank <= 1) return 'leader';
  return gapRatio >= cfg.items.farGapRatio ? 'far' : 'near';
}

/**
 * rank と gapRatio から使う抽選表(アイテム名→重み)を返す。
 * @param {number} rank
 * @param {number} gapRatio
 * @param {object} cfg
 * @returns {Record<string, number>}
 */
export function tableFor(rank, gapRatio, cfg) {
  return cfg.items.tables[tableNameFor(rank, gapRatio, cfg)];
}

/**
 * 表に従ってアイテムを1つ抽選する。`force` が渡されればそれをそのまま返す(抽選しない)。
 * @param {object} params
 * @param {number} params.rank
 * @param {number} params.gapRatio
 * @param {ReturnType<typeof import('../../../_shared/core/rng.js').createRng>} params.rng
 * @param {object} params.cfg
 * @param {string|null} [params.force]
 * @returns {string} ITEMS のいずれか
 */
export function rollItem({ rank, gapRatio, rng, cfg, force }) {
  if (force) return force;
  const table = tableFor(rank, gapRatio, cfg);
  const total = ITEMS.reduce((sum, name) => sum + (table[name] || 0), 0);
  // 重みの合計が 0(表の設定ミス)のときは、確実に何かを返すため一様に選ぶ
  if (total <= 0) return ITEMS[rng.int(ITEMS.length)];
  let x = rng.range(0, total);
  for (const name of ITEMS) {
    const w = table[name] || 0;
    if (x < w) return name;
    x -= w;
  }
  // 浮動小数の誤差で抜けた場合の保険:最後のアイテムを返す
  return ITEMS[ITEMS.length - 1];
}
