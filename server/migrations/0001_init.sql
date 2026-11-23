-- 設計書 10 §6.4 のスキーマ。
-- 日時はすべて UNIX 秒の整数。期限の列は持たず、last_seen_at / last_used_at に
-- 期間を足して判定する（期間を変えたとき、既存の行も新しい期間で判定されるようにするため）。

-- ユーザー（Discord ログインだけなので discord_users と 1 つにした）
CREATE TABLE users (
  id            INTEGER PRIMARY KEY,          -- 旧 auth.db の users.id を引き継ぐ
  discord_id    TEXT    NOT NULL UNIQUE,
  display_name  TEXT    NOT NULL,             -- global_name、なければ username。ログインのたびに更新
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash   BLOB    PRIMARY KEY,           -- SHA-256(sid の値)
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE site_passes (
  token_hash   BLOB    PRIMARY KEY,           -- SHA-256(site_pass の値)
  device_name  TEXT    NOT NULL,              -- User-Agent から作る（今の deviceNameFromUA と同じ分け方）
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
