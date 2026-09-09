// ログイン後リダイレクト先の安全性チェック。
// App.jsx（RequireLogin/PostLoginRedirect）と Login.jsx の両方から使うため、
// ここに1箇所だけ定義する（重複定義すると片方だけ直し忘れる事故が起きるため）。

// 外部サイトへ飛ばされないように、内部パスだけを許可する。
//
// 弾く必要があるもの:
//   "//evil.com"   … ブラウザがプロトコル相対URLとして解釈する
//   "/\evil.com"   … 多くのブラウザがバックスラッシュをスラッシュとして正規化するため
//                    実質 "//evil.com" と同じになる（@ の位置は本来バックスラッシュ）
//   制御文字・空白 … ブラウザがURL解釈時に除去するため、タブ入りなどの細工が通り得る
//
// 現在の呼び出し元は react-router の navigate()（クライアント側ルーティング）なので、
// 上記が素通りしても外部遷移は起きない。ただし共有ヘルパーであり、後から
// window.location に使われた途端に穴になるため、入口で弾いておく。
const BACKSLASH = String.fromCharCode(92)

export function isSafeInternalPath(p) {
  if (typeof p !== 'string' || p === '') return false
  if (/[\u0000-\u001f\u007f\s]/.test(p)) return false
  if (p.includes(BACKSLASH)) return false
  return p.startsWith('/') && !p.startsWith('//')
}
