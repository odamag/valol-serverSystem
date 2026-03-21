<?php
session_start();
require_once dirname(__DIR__) . '/common.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed'], 405);
}

$data     = json_decode(file_get_contents('php://input'), true);
$id       = trim($data['id']       ?? '');
$username = trim($data['username'] ?? '');

if ($id === '' || $username === '') {
    jsonResponse(['success' => false, 'message' => 'IDとユーザー名を入力してください']);
}

try {
    $db   = getDB();
    $stmt = $db->prepare('SELECT id FROM users WHERE user_id = ?');
    $stmt->execute([$id]);
    if ($stmt->fetch()) {
        jsonResponse(['success' => false, 'message' => 'そのIDはすでに使用されています']);
    }

    // Base32シークレットキー生成
    $chars  = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    $secret = '';
    for ($i = 0; $i < 16; $i++) {
        $secret .= $chars[random_int(0, 31)];
    }

    $stmt = $db->prepare('INSERT INTO users (user_id, username, otp_secret) VALUES (?, ?, ?)');
    $stmt->execute([$id, $username, $secret]);

    // OTP URI生成
    $otpUri = 'otpauth://totp/' . rawurlencode('ServerController:' . $id)
            . '?secret=' . rawurlencode($secret)
            . '&issuer=ServerController'
            . '&algorithm=SHA1&digits=6&period=30';

    jsonResponse([
        'success'   => true,
        'secretKey' => $secret,
        'otpUri'    => $otpUri,
    ]);
} catch (PDOException $e) {
    jsonResponse(['success' => false, 'message' => 'アカウント作成エラー'], 500);
}
