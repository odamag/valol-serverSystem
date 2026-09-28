/**
 * ゲストがホストの時刻に合わせるための時刻同期(約束 8節)。
 * ゲストは 1 秒ごとに `ping` を送り、`pong` を受け取るたびに `onPong` を呼ぶ。
 * @returns {{ onPong(c: number, h: number, t1: number): void, offset(): number, hostNow(localNow: number): number }}
 */
export function createClockSync() {
  // 直近5回ぶんの offset。中央値を使うことで、1回だけ遅れた pong に引きずられないようにする。
  const samples = [];

  /**
   * @param {number} c ping を送ったときの、ゲストの時刻
   * @param {number} h pong に入っていた、ホストの時刻
   * @param {number} t1 pong を受け取ったときの、ゲストの時刻
   */
  function onPong(c, h, t1) {
    // 約束 8節: offset = h + (t1 - c) / 2 - t1(往復時間の半分を片道の遅延と見なす)
    const sample = h + (t1 - c) / 2 - t1;
    samples.push(sample);
    if (samples.length > 5) samples.shift();
  }

  function offset() {
    if (samples.length === 0) return 0;
    const sorted = samples.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }

  /** ゲストの時計での `localNow` を、推定したホスト時刻に変換する */
  function hostNow(localNow) {
    return localNow + offset();
  }

  return { onPong, offset, hostNow };
}
