<?php
// 共通ユーティリティ

function getDB() {
    $path = dirname(__DIR__) . '/db-folder/auth.db';
    $db = new PDO('sqlite:' . $path);
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $db->exec("
        CREATE TABLE IF NOT EXISTS site_tokens (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            token        TEXT    NOT NULL UNIQUE,
            device_name  TEXT,
            created_at   INTEGER NOT NULL,
            last_used_at INTEGER NOT NULL
        )
    ");
    return $db;
}

// デバイストークンを生成（64文字の16進数）
function generateDeviceToken(): string {
    return bin2hex(random_bytes(32));
}

// User-Agentから簡易デバイス名を生成
function deviceNameFromUA(string $ua): string {
    if (preg_match('/iPhone/', $ua))       return 'iPhone';
    if (preg_match('/iPad/', $ua))         return 'iPad';
    if (preg_match('/Android/', $ua))      return 'Android';
    if (preg_match('/Macintosh/', $ua))    return 'Mac';
    if (preg_match('/Windows/', $ua))      return 'Windows PC';
    if (preg_match('/Linux/', $ua))        return 'Linux PC';
    return 'Unknown Device';
}

function jsonResponse($data, $code = 200) {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function requireAuth() {
    if (!isset($_SESSION['user_id'])) {
        jsonResponse(['success' => false, 'message' => '認証が必要です'], 401);
    }
}

function requireSiteAuth() {
    if (!isset($_SESSION['site_auth']) || $_SESSION['site_auth'] !== true) {
        jsonResponse(['success' => false, 'message' => 'サイト認証が必要です'], 401);
    }
}

function verifyTOTP($secret, $otp) {
    $key = base32_decode($secret);
    $timestamp = floor(time() / 30);

    // 時刻ズレ対応: 前後1ウィンドウも許容
    for ($offset = -1; $offset <= 1; $offset++) {
        $t = $timestamp + $offset;
        $hash = hash_hmac('sha1', pack('N*', 0) . pack('N*', $t), $key, true);
        $pos  = ord($hash[19]) & 0x0F;
        $code = (
            ((ord($hash[$pos])     & 0x7F) << 24) |
            ((ord($hash[$pos + 1]) & 0xFF) << 16) |
            ((ord($hash[$pos + 2]) & 0xFF) <<  8) |
            ( ord($hash[$pos + 3]) & 0xFF)
        ) % 1000000;
        if (hash_equals(sprintf('%06d', $code), (string)$otp)) {
            return true;
        }
    }
    return false;
}

function base32_decode($input) {
    $chars  = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    $bits   = '';
    $output = '';
    for ($i = 0; $i < strlen($input); $i++) {
        $pos = strpos($chars, strtoupper($input[$i]));
        if ($pos !== false) {
            $bits .= str_pad(decbin($pos), 5, '0', STR_PAD_LEFT);
        }
    }
    for ($i = 0; $i + 8 <= strlen($bits); $i += 8) {
        $output .= chr(bindec(substr($bits, $i, 8)));
    }
    return $output;
}
