import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoopbackPair } from '../net/loopback.js';
import { createRng } from '../core/rng.js';

test('pump(now) を呼ぶまで届かない', () => {
  const [a, b] = createLoopbackPair();
  const received = [];
  b.onMessage((m) => received.push(m));

  a.send({ hello: 1 });
  assert.equal(received.length, 0);
  a.pump(0); // 送信側の pump は自分のキューに影響しない
  assert.equal(received.length, 0);

  b.pump(0);
  assert.equal(received.length, 1);
  assert.deepEqual(received[0], { hello: 1 });
});

test('latencyMs どおりに届く', () => {
  const [a, b] = createLoopbackPair({ latencyMs: 100 });
  const received = [];
  b.onMessage((m) => received.push(m));

  a.pump(1000); // 送った時刻は最後に pump された時刻
  a.send({ n: 1 });

  b.pump(1099);
  assert.equal(received.length, 0, '届く前');
  b.pump(1100);
  assert.equal(received.length, 1, 'ちょうど届く時刻');
});

test('順番が変わらない(jitter があっても)', () => {
  // rng.range を常に大きい値→小さい値の順で返すダミーにして、後発のメッセージのほうが
  // 先発より短い遅延になるケースを作る。それでも届く順は送った順を保つはず。
  const values = [9, 0, 5];
  let i = 0;
  const rng = { range: () => values[i++] };
  const [a, b] = createLoopbackPair({ latencyMs: 10, jitterMs: 10, rng });
  const received = [];
  b.onMessage((m) => received.push(m.n));

  a.pump(0);
  a.send({ n: 1 }); // arrival = 0 + 10 + 9 = 19
  a.send({ n: 2 }); // 素の arrival = 0 + 10 + 0 = 10 だが、前のメッセージ(19)より早くならない → 19
  a.send({ n: 3 }); // 素の arrival = 0 + 10 + 5 = 15 だが、前(19)より早くならない → 19

  b.pump(19);
  assert.deepEqual(received, [1, 2, 3]);
});

test('jitterMs を使うのに rng がないとエラーになる', () => {
  assert.throws(() => createLoopbackPair({ jitterMs: 10 }));
});

test('jitterMs を使うと rng.range(0, jitterMs) の範囲で揺れる(決定的な rng で確かめる)', () => {
  const rng = createRng(1);
  const [a, b] = createLoopbackPair({ latencyMs: 50, jitterMs: 20, rng });
  const received = [];
  b.onMessage(() => received.push(true));

  a.pump(0);
  a.send({});
  // jitter は 0〜20 の範囲なので、遅延は 50〜70 の間のはず
  b.pump(69);
  const beforeUpper = received.length;
  b.pump(70);
  assert.ok(received.length >= beforeUpper);
  assert.ok(received.length <= 1);
});

test('close() で相手の onClose が呼ばれる', () => {
  const [a, b] = createLoopbackPair();
  let closed = false;
  b.onClose(() => {
    closed = true;
  });
  a.close();
  assert.equal(closed, true);
});

test('close() は自分側の onClose は呼ばない', () => {
  const [a, b] = createLoopbackPair();
  let aClosed = false;
  a.onClose(() => {
    aClosed = true;
  });
  a.close();
  assert.equal(aClosed, false);
});

test('close() 後に送っても届かない', () => {
  const [a, b] = createLoopbackPair();
  const received = [];
  b.onMessage((m) => received.push(m));
  a.close();
  a.send({ x: 1 });
  b.pump(1000);
  assert.equal(received.length, 0);
});

test('関数を含むメッセージを送るとエラーになる', () => {
  const [a] = createLoopbackPair();
  assert.throws(() => a.send({ fn: () => {} }), TypeError);
});

test('双方向に送れる', () => {
  const [a, b] = createLoopbackPair({ latencyMs: 10 });
  const aReceived = [];
  const bReceived = [];
  a.onMessage((m) => aReceived.push(m));
  b.onMessage((m) => bReceived.push(m));

  a.pump(0);
  b.pump(0);
  a.send({ from: 'a' });
  b.send({ from: 'b' });

  a.pump(10);
  b.pump(10);
  assert.deepEqual(aReceived, [{ from: 'b' }]);
  assert.deepEqual(bReceived, [{ from: 'a' }]);
});
