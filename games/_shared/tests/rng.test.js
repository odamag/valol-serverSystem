import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from '../core/rng.js';

test('同じ seed なら同じ列を返す(決定的)', () => {
  const a = createRng(12345);
  const b = createRng(12345);
  const seqA = Array.from({ length: 20 }, () => a.next());
  const seqB = Array.from({ length: 20 }, () => b.next());
  assert.deepEqual(seqA, seqB);
});

test('違う seed なら違う列を返す', () => {
  const a = createRng(1);
  const b = createRng(2);
  const seqA = Array.from({ length: 10 }, () => a.next());
  const seqB = Array.from({ length: 10 }, () => b.next());
  assert.notDeepEqual(seqA, seqB);
});

test('next() は [0, 1) の範囲', () => {
  const rng = createRng(999);
  for (let i = 0; i < 1000; i++) {
    const v = rng.next();
    assert.ok(v >= 0 && v < 1, `v=${v} が範囲外`);
  }
});

test('range(a, b) は [a, b) の範囲', () => {
  const rng = createRng(7);
  for (let i = 0; i < 500; i++) {
    const v = rng.range(-3, 5);
    assert.ok(v >= -3 && v < 5);
  }
});

test('int(n) は 0 以上 n 未満の整数', () => {
  const rng = createRng(42);
  for (let i = 0; i < 500; i++) {
    const v = rng.int(6);
    assert.ok(Number.isInteger(v));
    assert.ok(v >= 0 && v < 6);
  }
});

test('pick(arr) は配列の要素のどれかを返す', () => {
  const rng = createRng(5);
  const arr = ['a', 'b', 'c'];
  for (let i = 0; i < 50; i++) {
    assert.ok(arr.includes(rng.pick(arr)));
  }
});

test('shuffle(arr) は並べ替えだけをする(元の配列は変えず、要素の集合は同じ)', () => {
  const rng = createRng(3);
  const original = [1, 2, 3, 4, 5, 6, 7, 8];
  const copyBefore = original.slice();
  const shuffled = rng.shuffle(original);

  // 元の配列を変えていない
  assert.deepEqual(original, copyBefore);
  // 別の配列インスタンスを返す
  assert.notEqual(shuffled, original);
  // 要素の集合(多重集合)は変わらない
  assert.deepEqual(shuffled.slice().sort((a, b) => a - b), original.slice().sort((a, b) => a - b));
  assert.equal(shuffled.length, original.length);
});

test('shuffle は seed が同じなら同じ結果', () => {
  const arr = [1, 2, 3, 4, 5];
  const s1 = createRng(555).shuffle(arr);
  const s2 = createRng(555).shuffle(arr);
  assert.deepEqual(s1, s2);
});

test('fork() は親と違う列を生む子を作る(親の seed から決定的)', () => {
  const parentA = createRng(2024);
  const childA = parentA.fork();

  const parentB = createRng(2024);
  const childB = parentB.fork();

  const seqChildA = Array.from({ length: 10 }, () => childA.next());
  const seqChildB = Array.from({ length: 10 }, () => childB.next());
  // 同じ親 seed から fork した子は同じ列になる
  assert.deepEqual(seqChildA, seqChildB);

  // 子は親そのものとは違う乱数生成器
  const freshParent = createRng(2024);
  const parentSeq = Array.from({ length: 10 }, () => freshParent.next());
  assert.notDeepEqual(seqChildA, parentSeq);
});
