// running_hmac.json を作る。受ける側（aws/src/lib/verify-hmac.ts）と同じ式で期待値を計算する。
// なぜ Node で作るか: 受ける側が仕様の正なので、Rust の実装とは別の実装で期待値を出すため。
// 使い方: node server/tests/fixtures/gen_running_hmac.mjs > server/tests/fixtures/running_hmac.json
import { createHash, createHmac } from 'node:crypto';

// ダミーの値（本物の秘密ではない）
const SECRET = 'dummy-shared-secret-for-tests';
const DISCORD_ID = '123456789012345678';
const ID = '2026-03-05_0123456789abcdef0123456789abcdef';

const inputs = [
  { name: 'get_no_query', method: 'GET', path: '/v1/settings', query: '', ts: '1767225600', nonce: '00112233445566778899aabbccddeeff', body: '' },
  { name: 'get_with_query', method: 'GET', path: '/v1/records', query: 'limit=20&cursor=eyJwayI6IkEjMSJ9', ts: '1767225601', nonce: 'ffeeddccbbaa99887766554433221100', body: '' },
  { name: 'post_japanese_body', method: 'POST', path: '/v1/records', query: '', ts: '1767225602', nonce: 'a0a1a2a3a4a5a6a7a8a9aaabacadaeaf', body: '{"distanceKm":5.2,"memo":"朝ラン、気持ちよかった🏃"}' },
  { name: 'patch_record', method: 'PATCH', path: `/v1/records/${ID}`, query: '', ts: '1767225603', nonce: 'b0b1b2b3b4b5b6b7b8b9babbbcbdbebf', body: '{"memo":"更新","updatedAt":"2026-03-05T06:00:00.000Z"}' },
  { name: 'delete_with_query', method: 'DELETE', path: `/v1/records/${ID}`, query: 'updatedAt=2026-03-05T06%3A00%3A00.000Z', ts: '1767225604', nonce: 'c0c1c2c3c4c5c6c7c8c9cacbcccdcecf', body: '' },
];

const cases = inputs.map((c) => {
  const bodyHash = createHash('sha256').update(Buffer.from(c.body, 'utf8')).digest('hex');
  const canonical = [c.method, c.path, c.query, DISCORD_ID, c.ts, c.nonce, bodyHash].join('\n');
  const signature = createHmac('sha256', SECRET).update(canonical).digest('hex');
  return { ...c, discordId: DISCORD_ID, secret: SECRET, canonical, signature };
});

process.stdout.write(JSON.stringify(cases, null, 2) + '\n');
