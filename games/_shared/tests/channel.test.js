import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoopbackPair } from '../net/loopback.js';
import { wrapChannel } from '../net/channel.js';

test('frame と game のメッセージが混ざらずに届く', () => {
  const [t1, t2] = createLoopbackPair();
  const chA = wrapChannel(t1);
  const chB = wrapChannel(t2);

  const frameMsgs = [];
  const gameMsgs = [];
  chB.frame.onMessage((m) => frameMsgs.push(m));
  chB.game.onMessage((gi, m) => gameMsgs.push({ gi, m }));

  chA.frame.send({ t: 'hello' });
  chA.game.send(3, { t: 'kartState', x: 1 });

  t1.pump(0);
  t2.pump(0);

  assert.deepEqual(frameMsgs, [{ t: 'hello' }]);
  assert.deepEqual(gameMsgs, [{ gi: 3, m: { t: 'kartState', x: 1 } }]);
});

test('game のメッセージに gi がつく(gi の一致確認はしない。そのまま渡す)', () => {
  const [t1, t2] = createLoopbackPair();
  const chA = wrapChannel(t1);
  const chB = wrapChannel(t2);

  const seen = [];
  chB.game.onMessage((gi, m) => seen.push(gi));

  chA.game.send(1, { t: 'a' });
  chA.game.send(2, { t: 'b' }); // 古いインスタンスあてでも channel は捨てない(枠の役目)

  t1.pump(0);
  t2.pump(0);

  assert.deepEqual(seen, [1, 2]);
});

test('複数のハンドラを登録できる', () => {
  const [t1, t2] = createLoopbackPair();
  const chA = wrapChannel(t1);
  const chB = wrapChannel(t2);

  let count = 0;
  chB.frame.onMessage(() => count++);
  chB.frame.onMessage(() => count++);

  chA.frame.send({ t: 'x' });
  t1.pump(0);
  t2.pump(0);

  assert.equal(count, 2);
});

test('元の transport が使える(close / onClose の中継)', () => {
  const [t1, t2] = createLoopbackPair();
  const chA = wrapChannel(t1);
  const chB = wrapChannel(t2);

  let closed = false;
  chB.transport.onClose(() => {
    closed = true;
  });
  chA.transport.close();

  assert.equal(closed, true);
});

test('c が f でも g でもない packet は無視する', () => {
  const [t1, t2] = createLoopbackPair();
  wrapChannel(t1);
  const chB = wrapChannel(t2);

  const frameMsgs = [];
  const gameMsgs = [];
  chB.frame.onMessage((m) => frameMsgs.push(m));
  chB.game.onMessage((gi, m) => gameMsgs.push(m));

  t1.send({ c: 'x', m: { t: 'weird' } });
  t2.pump(0);

  assert.deepEqual(frameMsgs, []);
  assert.deepEqual(gameMsgs, []);
});
