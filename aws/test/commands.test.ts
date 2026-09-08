// commands.ts の共有ユーティリティ（時間のパース/整形など）の単体テスト。
// node:test ランナーは使わず、node:assert のみで検証する自前ランナー形式にする
//（既存の jst.test.ts / validate.test.ts と同じスタイル）。実行: `ts-node test/commands.test.ts`

import assert from 'node:assert/strict';
import {
  formatClock,
  formatPace,
  formatRecordChoiceName,
  parseClockToSeconds,
  weatherLabel,
} from '../src/lib/commands';

let failures = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok - ${name}`);
  } catch (err) {
    failures++;
    console.error(`  NG - ${name}`);
    console.error(err instanceof Error ? err.message : err);
  }
}

console.log('commands.test.ts');

// ── parseClockToSeconds ────────────────────────────────────────────
test('parse: mm:ss形式', () => {
  assert.equal(parseClockToSeconds('26:30'), 26 * 60 + 30);
});

test('parse: h:mm:ss形式', () => {
  assert.equal(parseClockToSeconds('1:05:12'), 1 * 3600 + 5 * 60 + 12);
});

test('parse: mm:ssの分は60以上も許容する（90:00 = 1時間30分）', () => {
  assert.equal(parseClockToSeconds('90:00'), 90 * 60);
});

test('parse: h:mm:ssの分・秒が60以上は不正', () => {
  assert.equal(parseClockToSeconds('1:60:00'), null);
  assert.equal(parseClockToSeconds('1:00:60'), null);
});

test('parse: 前後の空白は許容する', () => {
  assert.equal(parseClockToSeconds('  26:30  '), 26 * 60 + 30);
});

test('parse: パースできない形式はnull', () => {
  assert.equal(parseClockToSeconds('abc'), null);
  assert.equal(parseClockToSeconds('26'), null);
  assert.equal(parseClockToSeconds(''), null);
  assert.equal(parseClockToSeconds('1:2:3:4'), null);
});

// ── formatClock ─────────────────────────────────────────────────────
test('format: 1時間未満はmm:ss', () => {
  assert.equal(formatClock(26 * 60 + 30), '26:30');
});

test('format: 1時間以上はh:mm:ss', () => {
  assert.equal(formatClock(1 * 3600 + 5 * 60 + 12), '1:05:12');
});

test('format: 秒未満の桁も0埋めされる', () => {
  assert.equal(formatClock(65), '1:05');
});

// ── formatPace ──────────────────────────────────────────────────────
test('format: ペースはm:ss/km', () => {
  assert.equal(formatPace(306), '5:06/km');
});

// ── weatherLabel ────────────────────────────────────────────────────
test('weatherLabel: 既知の値は日本語ラベルを返す', () => {
  assert.equal(weatherLabel('sunny'), '晴れ');
  assert.equal(weatherLabel('indoor'), '室内');
});

test('weatherLabel: nullや未知の値はundefined', () => {
  assert.equal(weatherLabel(null), undefined);
  assert.equal(weatherLabel(undefined), undefined);
  assert.equal(weatherLabel('typhoon'), undefined);
});

// ── formatRecordChoiceName ──────────────────────────────────────────
test('choiceName: コースありの表示', () => {
  const name = formatRecordChoiceName({
    runDate: '2026-09-09',
    distanceKm: 5.2,
    durationS: 26 * 60 + 30,
    course: '皇居一周',
  });
  assert.equal(name, '09/09 5.2km 26:30 皇居一周');
});

test('choiceName: コース無しの表示', () => {
  const name = formatRecordChoiceName({
    runDate: '2026-09-09',
    distanceKm: 5.2,
    durationS: 26 * 60 + 30,
    course: null,
  });
  assert.equal(name, '09/09 5.2km 26:30');
});

test('choiceName: 100文字を超える場合は切り詰められる（Discordのchoice制約）', () => {
  const name = formatRecordChoiceName({
    runDate: '2026-09-09',
    distanceKm: 5.2,
    durationS: 26 * 60 + 30,
    course: 'a'.repeat(100),
  });
  assert.ok(name.length <= 100, `expected length <= 100, got ${name.length}`);
});

if (failures > 0) {
  console.error(`\ncommands.test.ts: ${failures} failure(s)`);
  process.exit(1);
} else {
  console.log('commands.test.ts: all tests passed\n');
}
