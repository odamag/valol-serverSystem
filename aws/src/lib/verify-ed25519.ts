import { createPublicKey, verify, type KeyObject } from 'node:crypto';

// `discord-interactions` パッケージには依存しない。Node 標準の node:crypto だけで完結させる。
//
// Discord の公開鍵は「生の32バイト Ed25519 公開鍵」として渡ってくるが、node:crypto の
// createPublicKey は SPKI (SubjectPublicKeyInfo) 形式の DER を要求する。
// 生の32バイト鍵の前にこの固定ヘッダを付けるだけで正しい SPKI DER になる
// （Ed25519 の SPKI ヘッダは鍵の値に依存しない固定バイト列のため）。
const DER_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

// 公開鍵オブジェクトはモジュールスコープでキャッシュする。
// ただし DISCORD_PUBLIC_KEY が空文字（未設定）の状態でモジュール読み込み時に生成しようとすると
// createPublicKey が例外を投げてハンドラのコールドスタート自体が失敗してしまう。
// そのため生成は遅延させ、初回の verifyEd25519 呼び出し時に行う。
let cachedKey: KeyObject | undefined;
let cachedKeyHex: string | undefined;

function getPublicKey(publicKeyHex: string): KeyObject {
  if (cachedKey && cachedKeyHex === publicKeyHex) {
    return cachedKey;
  }
  const rawKey = Buffer.from(publicKeyHex, 'hex');
  const der = Buffer.concat([DER_PREFIX, rawKey]);
  cachedKey = createPublicKey({ key: der, format: 'der', type: 'spki' });
  cachedKeyHex = publicKeyHex;
  return cachedKey;
}

/**
 * Discord Interactions の署名を検証する。
 *
 * @param publicKeyHex Discord Developer Portal に表示される Public Key（16進文字列）
 * @param timestamp    X-Signature-Timestamp ヘッダの値
 * @param rawBody      リクエストの生ボディ（JSON.parse/stringify を経由していないバイト列）
 * @param signatureHex X-Signature-Ed25519 ヘッダの値（16進文字列）
 */
export function verifyEd25519(
  publicKeyHex: string,
  timestamp: string,
  rawBody: Buffer,
  signatureHex: string,
): boolean {
  try {
    const key = getPublicKey(publicKeyHex);
    const message = Buffer.concat([Buffer.from(timestamp, 'utf8'), rawBody]);
    const signature = Buffer.from(signatureHex, 'hex');
    // Ed25519 では digest アルゴリズムを指定しない（node:crypto の慣例で第一引数は null）。
    return verify(null, message, key, signature);
  } catch {
    // 不正な16進文字列・不正な署名長など、フォーマット異常時は例外になるので握りつぶして false を返す。
    // ここで例外を外に漏らすと、単なる「署名不一致」ではなく 500 エラーになってしまう。
    return false;
  }
}
