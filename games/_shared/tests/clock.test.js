import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClockSync } from '../frame/clock.js';

/**
 * 擬似環境:片道遅延 100ms、ホストの時計はゲストの時計よりちょうど +5000ms ずれている。
 * ゲストが localTime = t に ping(c = t) を送ると、ホストには t + 100 に届き、
 * そのときのホスト時刻 h = (t + 100) + 5000 を pong で返す。ゲストは t1 = t + 200 に受け取る。
 */
function simulatePong(clock, sentAtLocal) {
  const LATENCY = 100;
  const HOST_OFFSET = 5000;
  const c = sentAtLocal;
  const h = sentAtLocal + LATENCY + HOST_OFFSET;
  const t1 = sentAtLocal + LATENCY * 2;
  clock.onPong(c, h, t1);
}

test('5回の ping/pong の後、hostNow の誤差が 10ms 以内', () => {
  const clock = createClockSync();
  for (let i = 0; i < 5; i++) {
    simulatePong(clock, i * 1000);
  }
  const localNow = 10000;
  const expectedHostNow = localNow + 5000;
  assert.ok(
    Math.abs(clock.hostNow(localNow) - expectedHostNow) <= 10,
    `hostNow=${clock.hostNow(localNow)} expected≈${expectedHostNow}`,
  );
});

test('offset() は直近5回の中央値(6回目以降は古いものを捨てる)', () => {
  const clock = createClockSync();
  // 最初の1回だけ大きく外れた値を混ぜる → 6回以上呼べば捨てられて誤差が消える
  clock.onPong(0, 999999, 200); // 極端な offset
  for (let i = 1; i <= 5; i++) {
    simulatePong(clock, i * 1000);
  }
  const localNow = 8000;
  const expectedHostNow = localNow + 5000;
  assert.ok(Math.abs(clock.hostNow(localNow) - expectedHostNow) <= 10);
});

test('サンプルが1つもないとき offset() は 0', () => {
  const clock = createClockSync();
  assert.equal(clock.offset(), 0);
  assert.equal(clock.hostNow(1234), 1234);
});

test('offset の式どおり: h + (t1 - c) / 2 - t1', () => {
  const clock = createClockSync();
  clock.onPong(100, 5300, 300); // c=100, h=5300, t1=300
  const expected = 5300 + (300 - 100) / 2 - 300; // = 5100
  assert.equal(clock.offset(), expected);
});
