// commands.ts の共有ユーティリティ（時間のパース/整形など）の単体テスト。
// node:test ランナーは使わず、node:assert のみで検証する自前ランナー形式にする
//（既存の jst.test.ts / validate.test.ts と同じスタイル）。実行: `ts-node test/commands.test.ts`

import assert from 'node:assert/strict';
import {
  formatClock,
  formatPace,
  formatRecordChoiceName,
  parseClockToSeconds,
  shouldBeEphemeral,
  weatherLabel,
  type DiscordInteraction,
} from '../src/lib/commands';
import { buildWebUrl } from '../src/handlers/worker';

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

// ── buildWebUrl ─────────────────────────────────────────────────────
test('buildWebUrl: 末尾スラッシュ無しのoriginに/runningを付ける', () => {
  assert.equal(buildWebUrl('https://valol.jellybean.jp'), 'https://valol.jellybean.jp/running');
});

test('buildWebUrl: 末尾スラッシュ有りのoriginでも二重スラッシュにならない', () => {
  assert.equal(buildWebUrl('https://valol.jellybean.jp/'), 'https://valol.jellybean.jp/running');
});

test('buildWebUrl: 空文字はnull（呼び出し側で未設定エラーを返すため）', () => {
  assert.equal(buildWebUrl(''), null);
});

test('buildWebUrl: パス無しの短いoriginでも動く', () => {
  assert.equal(buildWebUrl('https://x.jp'), 'https://x.jp/running');
});

// ── shouldBeEphemeral ─────────────────────────────────────────────────
// `/run add` `/run rank` は private:true のときだけ ephemeral、それ以外
// （list/delete/web/me、/run-admin 全サブコマンド、未知・不正な構造）は常に ephemeral。

/** テスト用に最小限の DiscordInteraction を組み立てる。 */
function buildInteraction(
  commandName: string,
  subName: string,
  options: { name: string; type: number; value?: string | number | boolean }[] = [],
): DiscordInteraction {
  return {
    id: 'i1',
    application_id: 'a1',
    type: 2,
    token: 't1',
    data: {
      name: commandName,
      options: [{ name: subName, type: 1, options }],
    },
  };
}

test('shouldBeEphemeral: /run add で private 未指定は公開(false)', () => {
  const interaction = buildInteraction('run', 'add', []);
  assert.equal(shouldBeEphemeral(interaction), false);
});

test('shouldBeEphemeral: /run add で private:false は公開(false)', () => {
  const interaction = buildInteraction('run', 'add', [{ name: 'private', type: 5, value: false }]);
  assert.equal(shouldBeEphemeral(interaction), false);
});

test('shouldBeEphemeral: /run add で private:true は本人のみ(true)', () => {
  const interaction = buildInteraction('run', 'add', [{ name: 'private', type: 5, value: true }]);
  assert.equal(shouldBeEphemeral(interaction), true);
});

test('shouldBeEphemeral: /run rank で private 未指定は公開(false)', () => {
  const interaction = buildInteraction('run', 'rank', []);
  assert.equal(shouldBeEphemeral(interaction), false);
});

test('shouldBeEphemeral: /run rank で private:true は本人のみ(true)', () => {
  const interaction = buildInteraction('run', 'rank', [{ name: 'private', type: 5, value: true }]);
  assert.equal(shouldBeEphemeral(interaction), true);
});

test('shouldBeEphemeral: /run list は常に本人のみ(true)', () => {
  const interaction = buildInteraction('run', 'list', []);
  assert.equal(shouldBeEphemeral(interaction), true);
});

test('shouldBeEphemeral: /run me は常に本人のみ(true)', () => {
  const interaction = buildInteraction('run', 'me', []);
  assert.equal(shouldBeEphemeral(interaction), true);
});

test('shouldBeEphemeral: /run delete は常に本人のみ(true)', () => {
  const interaction = buildInteraction('run', 'delete', []);
  assert.equal(shouldBeEphemeral(interaction), true);
});

test('shouldBeEphemeral: /run web は常に本人のみ(true)', () => {
  const interaction = buildInteraction('run', 'web', []);
  assert.equal(shouldBeEphemeral(interaction), true);
});

test('shouldBeEphemeral: /run-admin threshold-set は常に本人のみ(true)', () => {
  const interaction = buildInteraction('run-admin', 'threshold-set', []);
  assert.equal(shouldBeEphemeral(interaction), true);
});

test('shouldBeEphemeral: 未知のコマンド名は安全側で本人のみ(true)', () => {
  const interaction = buildInteraction('unknown-command', 'add', []);
  assert.equal(shouldBeEphemeral(interaction), true);
});

test('shouldBeEphemeral: data が欠けた不正な構造は安全側で本人のみ(true)', () => {
  const interaction: DiscordInteraction = { id: 'i1', application_id: 'a1', type: 2, token: 't1' };
  assert.equal(shouldBeEphemeral(interaction), true);
});

test('shouldBeEphemeral: options が欠けた不正な構造は安全側で本人のみ(true)', () => {
  const interaction: DiscordInteraction = {
    id: 'i1',
    application_id: 'a1',
    type: 2,
    token: 't1',
    data: { name: 'run' },
  };
  assert.equal(shouldBeEphemeral(interaction), true);
});

if (failures > 0) {
  console.error(`\ncommands.test.ts: ${failures} failure(s)`);
  process.exit(1);
} else {
  console.log('commands.test.ts: all tests passed\n');
}
