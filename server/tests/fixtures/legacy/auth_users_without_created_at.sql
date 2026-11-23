-- 旧 auth.db（users に created_at 列が無い形。discord_callback.php が作る形）
-- import-legacy のテストが、一時ファイルの DB にこの SQL を流して使う。
CREATE TABLE users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT    NOT NULL UNIQUE,
    username   TEXT    NOT NULL,
    otp_secret TEXT    NOT NULL DEFAULT ''
);
CREATE TABLE discord_users (
    discord_id TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
);
CREATE TABLE site_tokens (
    token      TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
);

-- Discord と紐付いた 3 人（id 1・3・5）と、OTP だけの 1 人（id 2）
INSERT INTO users (id, user_id, username, otp_secret) VALUES
    (1, 'discord_100000000000000001', 'たろう', ''),
    (2, 'otp_only', 'OTPだけの人', 'JBSWY3DPEHPK3PXP'),
    (3, 'discord_100000000000000003', 'はなこ', ''),
    (5, 'discord_100000000000000005', 'じろう', '');
INSERT INTO discord_users (discord_id, user_id, created_at) VALUES
    ('100000000000000001', 1, 1700000001),
    ('100000000000000003', 3, 1700000003),
    ('100000000000000005', 5, 1700000005);
INSERT INTO site_tokens (token, created_at) VALUES ('old-device-token', 1700000000);
