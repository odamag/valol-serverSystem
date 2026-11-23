-- 旧 auth.db（users に created_at 列が有る形。古い登録処理が作った形）
-- import-legacy は users の created_at を読まず、discord_users.created_at を使う。
CREATE TABLE users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT    NOT NULL UNIQUE,
    username   TEXT    NOT NULL,
    otp_secret TEXT    NOT NULL DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE discord_users (
    discord_id TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
);

-- Discord と紐付いた 2 人（id 10・11）と、OTP だけの 2 人（id 12・13）
INSERT INTO users (id, user_id, username, otp_secret, created_at) VALUES
    (10, 'discord_200000000000000010', 'Alice', '', '2024-01-02 03:04:05'),
    (11, 'discord_200000000000000011', 'ボブ', '', '2024-02-03 04:05:06'),
    (12, 'otp_a', 'OTP A', 'AAAA', '2024-03-04 05:06:07'),
    (13, 'otp_b', 'OTP B', 'BBBB', NULL);
INSERT INTO discord_users (discord_id, user_id, created_at) VALUES
    ('200000000000000010', 10, 1710000010),
    ('200000000000000011', 11, 1710000011);
