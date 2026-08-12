<?php
// Discord OAuth2 コールバック — コードをトークンに交換してセッションを開始
session_start();
require_once dirname(__DIR__) . '/common.php';

$config = require __DIR__ . '/discord_config.php';

// ── ヘルパー ──────────────────────────────────────────────────────────────
function discordPost(string $url, array $fields): array {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => http_build_query($fields),
        CURLOPT_HTTPHEADER     => ['Content-Type: application/x-www-form-urlencoded'],
        CURLOPT_TIMEOUT        => 10,
    ]);
    $body = curl_exec($ch);
    curl_close($ch);
    return $body ? (json_decode($body, true) ?? []) : [];
}

function discordGet(string $url, string $token): array {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER     => ["Authorization: Bearer $token"],
        CURLOPT_TIMEOUT        => 10,
    ]);
    $body = curl_exec($ch);
    curl_close($ch);
    return $body ? (json_decode($body, true) ?? []) : [];
}

function redirectError(string $reason): void {
    header('Location: /login?discord_error=' . urlencode($reason));
    exit;
}

// ── state 検証（CSRF対策）────────────────────────────────────────────────
$state        = $_GET['state'] ?? '';
$storedState  = $_SESSION['discord_state']      ?? '';
$storedTime   = $_SESSION['discord_state_time'] ?? 0;

unset($_SESSION['discord_state'], $_SESSION['discord_state_time']);

if (!$state || !hash_equals($storedState, $state)) {
    redirectError('invalid_state');
}

// state の有効期限（10分）
if (time() - $storedTime > 600) {
    redirectError('state_expired');
}

// ユーザーがDiscord認証を拒否した場合
if (isset($_GET['error'])) {
    redirectError('denied');
}

$code = $_GET['code'] ?? '';
if (!$code) {
    redirectError('no_code');
}

// ── コード → アクセストークン ─────────────────────────────────────────────
$tokenData = discordPost('https://discord.com/api/oauth2/token', [
    'client_id'     => $config['client_id'],
    'client_secret' => $config['client_secret'],
    'grant_type'    => 'authorization_code',
    'code'          => $code,
    'redirect_uri'  => $config['redirect_uri'],
]);

$accessToken = $tokenData['access_token'] ?? null;
if (!$accessToken) {
    redirectError('token_exchange_failed');
}

// ── Discord ユーザー情報を取得 ─────────────────────────────────────────────
$discordUser = discordGet('https://discord.com/api/users/@me', $accessToken);

$discordId = $discordUser['id'] ?? null;
if (!$discordId) {
    redirectError('user_fetch_failed');
}

// 表示名: global_name (新形式) > username
$displayName = $discordUser['global_name'] ?? $discordUser['username'] ?? 'Discord User';

// ── DB でユーザーを検索 / 新規作成 ────────────────────────────────────────
$db = getDB();

// Discord連携テーブル（初回のみ作成）
$db->exec("
    CREATE TABLE IF NOT EXISTS discord_users (
        discord_id TEXT    PRIMARY KEY,
        user_id    INTEGER NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
    )
");

// users テーブルが未作成の環境に備えて作成
$db->exec("
    CREATE TABLE IF NOT EXISTS users (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    TEXT    NOT NULL UNIQUE,
        username   TEXT    NOT NULL,
        otp_secret TEXT    NOT NULL DEFAULT ''
    )
");

try {
    // Discordリンクが既に存在するか確認
    $stmt = $db->prepare("SELECT user_id FROM discord_users WHERE discord_id = ?");
    $stmt->execute([$discordId]);
    $link = $stmt->fetch(PDO::FETCH_ASSOC);

    if ($link) {
        // ── 既存ユーザー：そのままログイン ──────────────────────────────
        $userId = (int)$link['user_id'];

        $stmt = $db->prepare("SELECT username FROM users WHERE id = ?");
        $stmt->execute([$userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        // usernameが変わっていれば同期
        if ($row && $row['username'] !== $displayName) {
            $db->prepare("UPDATE users SET username = ? WHERE id = ?")->execute([$displayName, $userId]);
        }
        $username = $row['username'] ?? $displayName;

    } else {
        // ── 新規ユーザー：users + discord_users に挿入 ──────────────────
        $db->beginTransaction();

        $internalId = 'discord_' . $discordId;

        // users テーブルへ追加（既に同IDで存在する場合は取得のみ）
        $stmt = $db->prepare("SELECT id FROM users WHERE user_id = ?");
        $stmt->execute([$internalId]);
        $existing = $stmt->fetch(PDO::FETCH_ASSOC);

        if ($existing) {
            $userId = (int)$existing['id'];
        } else {
            $db->prepare("INSERT INTO users (user_id, username, otp_secret) VALUES (?, ?, '')")
               ->execute([$internalId, $displayName]);
            $userId = (int)$db->lastInsertId();
        }

        // discord_users にリンクを保存
        $db->prepare("INSERT OR IGNORE INTO discord_users (discord_id, user_id, created_at) VALUES (?, ?, ?)")
           ->execute([$discordId, $userId, time()]);

        $db->commit();
        $username = $displayName;
    }

} catch (PDOException $e) {
    if ($db->inTransaction()) $db->rollBack();
    redirectError('db_error');
}

// ── セッション開始 ──────────────────────────────────────────────────────
$_SESSION['user_id']     = $userId;
$_SESSION['username']    = $username;
$_SESSION['last_active'] = time();

// React SPA のサーバーページへリダイレクト
header('Location: /server');
exit;
