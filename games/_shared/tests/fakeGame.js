/**
 * frame.test.js が使う、約束 2・3節の形をした小さな偽のゲーム。
 * ホストは `resultDelayMs` だけ update を受けたら `onResult` を一度だけ呼ぶ。
 * 受け取ったゲームのメッセージ、`onPlayerLeft`、`dispose` の呼び出しをすべて記録するだけで、
 * 本物のロジック(コース・アイテムなど)は持たない。`*.test.js` ではないので `node --test` の対象にはならない。
 */

/**
 * @param {{ id?: string, maxPlayers?: number, minPlayers?: number, resultDelayMs?: number,
 *            resultFn?: (ctx: object) => object }} [opts]
 * @returns {{ definition: object, instances: Array<object> }}
 *   `instances` は `createGame` が呼ばれるたびに積まれる記録の配列(検査用)。
 */
export function createFakeGameDefinition(opts = {}) {
  const { id = 'FAKE', maxPlayers = 8, minPlayers = 1, resultDelayMs = 200, resultFn = null } = opts;

  const instances = [];

  function createGame(ctx) {
    const record = {
      ctx,
      role: ctx.role,
      localSlot: ctx.localSlot,
      roster: ctx.roster,
      seed: ctx.seed,
      settings: ctx.settings,
      startedAtNow: null,
      updateCount: 0,
      renderCount: 0,
      received: [], // host: {slot, m} / guest: {m}
      playerLeft: [],
      disposed: false,
      resultSent: false,
    };
    instances.push(record);

    if (ctx.role === 'host') {
      ctx.net.onMessage((slot, m) => record.received.push({ slot, m }));
    } else {
      ctx.net.onMessage((m) => record.received.push({ m }));
    }

    const instance = {
      update(now) {
        if (record.startedAtNow == null) record.startedAtNow = now;
        record.updateCount++;
        if (ctx.role === 'host' && !record.resultSent && now - record.startedAtNow >= resultDelayMs) {
          record.resultSent = true;
          const result = resultFn
            ? resultFn(ctx)
            : { ranking: ctx.roster.map((p) => p.slot), reason: 'finish', details: {} };
          ctx.onResult(result);
        }
      },
      render(now) {
        void now;
        record.renderCount++;
      },
      onPlayerLeft(slot) {
        record.playerLeft.push(slot);
      },
      dispose() {
        record.disposed = true;
      },
    };
    record.instance = instance;
    return instance;
  }

  const definition = {
    id,
    name: 'Fake Game',
    description: 'frame.test.js 用のダミーゲーム',
    minPlayers,
    maxPlayers,
    supportsBots: true,
    estimatedDurationSec: 1,
    createGame,
  };

  return { definition, instances };
}
