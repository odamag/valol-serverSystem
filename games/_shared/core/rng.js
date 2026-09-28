/**
 * 決定的な乱数生成器(mulberry32)。
 * ホストとゲストで同じ seed から同じ乱数列を作れるように、`Math.random()` の代わりにこれだけを使う(約束 10節)。
 * @param {number} seed
 * @returns {{ next(): number, range(a: number, b: number): number, int(n: number): number,
 *             pick<T>(arr: T[]): T, shuffle<T>(arr: T[]): T[], fork(): ReturnType<typeof createRng> }}
 */
export function createRng(seed) {
  // 状態は 32bit 整数として持つ。seed が浮動小数や範囲外でも安定するように >>> 0 で正規化する。
  let state = seed >>> 0;

  /** 0以上1未満の一様乱数(mulberry32) */
  function next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** a以上b未満の実数 */
  function range(a, b) {
    return a + next() * (b - a);
  }

  /** 0以上n未満の整数 */
  function int(n) {
    return Math.floor(next() * n);
  }

  /** 配列からランダムに1つ選ぶ */
  function pick(arr) {
    return arr[int(arr.length)];
  }

  /** Fisher-Yates。元の配列は変えず、新しい配列を返す */
  function shuffle(arr) {
    const copy = arr.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = int(i + 1);
      const tmp = copy[i];
      copy[i] = copy[j];
      copy[j] = tmp;
    }
    return copy;
  }

  /**
   * 子の乱数生成器を作る。次の乱数値から新しい seed を作るので、
   * 何度呼んでも違う(が、親の seed から決定的に決まる)子ができる。
   */
  function fork() {
    const childSeed = Math.floor(next() * 0xffffffff) >>> 0;
    return createRng(childSeed);
  }

  return { next, range, int, pick, shuffle, fork };
}
