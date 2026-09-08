// s3.ts の単体テスト。AWS API を一切呼ばない純粋関数のみを対象にする。
// node:test ランナーは使わず、node:assert のみで検証する自前ランナー形式にする
//（失敗したら process.exit(1)）。実行: `ts-node test/s3.test.ts`

import assert from 'node:assert/strict';
import { isAllowedImageContentType, isOwnTmpKey } from '../src/lib/s3';

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

console.log('s3.test.ts');

// ── isAllowedImageContentType ────────────────────────────────────────
test('isAllowedImageContentType: image/png は許可', () => {
  assert.equal(isAllowedImageContentType('image/png'), true);
});

test('isAllowedImageContentType: image/jpeg は許可', () => {
  assert.equal(isAllowedImageContentType('image/jpeg'), true);
});

test('isAllowedImageContentType: image/webp は許可', () => {
  assert.equal(isAllowedImageContentType('image/webp'), true);
});

test('isAllowedImageContentType: image/gif は拒否', () => {
  assert.equal(isAllowedImageContentType('image/gif'), false);
});

test('isAllowedImageContentType: text/plain は拒否', () => {
  assert.equal(isAllowedImageContentType('text/plain'), false);
});

test('isAllowedImageContentType: undefined は拒否', () => {
  assert.equal(isAllowedImageContentType(undefined), false);
});

test('isAllowedImageContentType: 空文字は拒否', () => {
  assert.equal(isAllowedImageContentType(''), false);
});

test('isAllowedImageContentType: 数値など文字列以外は拒否', () => {
  assert.equal(isAllowedImageContentType(123), false);
});

// ── isOwnTmpKey（最重要のセキュリティ境界。重点的にテストする） ──────────────
const DISCORD_ID = '123456789';
const RECORD_ID = '2026-09-09_a1b2c3d4e5f67890a1b2c3d4e5f67890';

test('isOwnTmpKey: 正しい prefix は true', () => {
  assert.equal(isOwnTmpKey(`tmp/${DISCORD_ID}/${RECORD_ID}/uuid-1234`, DISCORD_ID, RECORD_ID), true);
});

test('isOwnTmpKey: 他人の discordId のキーは false', () => {
  assert.equal(isOwnTmpKey(`tmp/999999999/${RECORD_ID}/uuid-1234`, DISCORD_ID, RECORD_ID), false);
});

test('isOwnTmpKey: 他人の recordId のキーは false', () => {
  const otherRecordId = '2026-09-09_ffffffffffffffffffffffffffffffff';
  assert.equal(isOwnTmpKey(`tmp/${DISCORD_ID}/${otherRecordId}/uuid-1234`, DISCORD_ID, RECORD_ID), false);
});

test('isOwnTmpKey: ".." を含むキーは false', () => {
  assert.equal(isOwnTmpKey(`tmp/${DISCORD_ID}/../${RECORD_ID}/uuid-1234`, DISCORD_ID, RECORD_ID), false);
});

test('isOwnTmpKey: ファイル名部分に ".." を含むキーは false', () => {
  assert.equal(isOwnTmpKey(`tmp/${DISCORD_ID}/${RECORD_ID}/../../etc/passwd`, DISCORD_ID, RECORD_ID), false);
});

test('isOwnTmpKey: photos/ 配下のキーは false', () => {
  assert.equal(isOwnTmpKey(`photos/${DISCORD_ID}/${RECORD_ID}/uuid-1234`, DISCORD_ID, RECORD_ID), false);
});

test('isOwnTmpKey: prefix が途中一致するだけの discordId は false（tmp/123456789/... に対し discordId=12345）', () => {
  assert.equal(isOwnTmpKey(`tmp/123456789/${RECORD_ID}/uuid-1234`, '12345', RECORD_ID), false);
});

test('isOwnTmpKey: prefix が途中一致するだけの recordId は false', () => {
  const longerRecordId = `${RECORD_ID}extra`;
  assert.equal(isOwnTmpKey(`tmp/${DISCORD_ID}/${longerRecordId}/uuid-1234`, DISCORD_ID, RECORD_ID), false);
});

test('isOwnTmpKey: さらに下の階層に潜ろうとするキー（余分な "/" を含む）は false', () => {
  assert.equal(isOwnTmpKey(`tmp/${DISCORD_ID}/${RECORD_ID}/sub/uuid-1234`, DISCORD_ID, RECORD_ID), false);
});

test('isOwnTmpKey: ファイル名部分が空（末尾が prefix そのもの）は false', () => {
  assert.equal(isOwnTmpKey(`tmp/${DISCORD_ID}/${RECORD_ID}/`, DISCORD_ID, RECORD_ID), false);
});

test('isOwnTmpKey: 空文字は false', () => {
  assert.equal(isOwnTmpKey('', DISCORD_ID, RECORD_ID), false);
});

test('isOwnTmpKey: 完全に無関係なキーは false', () => {
  assert.equal(isOwnTmpKey('etc/passwd', DISCORD_ID, RECORD_ID), false);
});

if (failures > 0) {
  console.error(`\ns3.test.ts: ${failures} failure(s)`);
  process.exit(1);
} else {
  console.log('s3.test.ts: all tests passed\n');
}
