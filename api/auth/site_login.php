<?php
session_start();
require_once dirname(__DIR__) . '/common.php';
require_once dirname(__DIR__) . '/site_config.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed'], 405);
}

$data     = json_decode(file_get_contents('php://input'), true);
$password = $data['password'] ?? '';

if ($password === '') {
    jsonResponse(['success' => false, 'message' => 'パスワードを入力してください']);
}

if (SITE_PASSWORD_HASH === 'SET_YOUR_HASH_HERE') {
    jsonResponse(['success' => false, 'message' => 'サイトパスワードが未設定です。api/site_config.php を設定してください。'], 503);
}

if (!password_verify($password, SITE_PASSWORD_HASH)) {
    jsonResponse(['success' => false, 'message' => 'パスワードが正しくありません']);
}

$_SESSION['site_auth'] = true;

try {
    $db         = getDB();
    $token      = generateDeviceToken();
    $deviceName = deviceNameFromUA($_SERVER['HTTP_USER_AGENT'] ?? '');
    $now        = time();

    $stmt = $db->prepare(
        'INSERT INTO site_tokens (token, device_name, created_at, last_used_at) VALUES (?, ?, ?, ?)'
    );
    $stmt->execute([$token, $deviceName, $now, $now]);

    jsonResponse(['success' => true, 'deviceToken' => $token]);
} catch (PDOException $e) {
    // トークン保存失敗でもログイン自体は成功として扱う
    jsonResponse(['success' => true, 'deviceToken' => null]);
}
