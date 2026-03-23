<?php
session_start();
require_once dirname(__DIR__) . '/common.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed'], 405);
}

$data = json_decode(file_get_contents('php://input'), true);
$id   = trim($data['id']  ?? '');
$otp  = trim($data['otp'] ?? '');

if ($id === '' || $otp === '') {
    jsonResponse(['success' => false, 'message' => 'IDとOTPを入力してください']);
}

try {
    $db   = getDB();
    $stmt = $db->prepare('SELECT id, username, otp_secret FROM users WHERE user_id = ?');
    $stmt->execute([$id]);
    $user = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$user) {
        jsonResponse(['success' => false, 'message' => 'ユーザーが見つかりません']);
    }

    if (!verifyTOTP($user['otp_secret'], $otp)) {
        jsonResponse(['success' => false, 'message' => 'OTPが正しくありません']);
    }

    $_SESSION['user_id']     = $user['id'];
    $_SESSION['username']    = $user['username'];
    $_SESSION['last_active'] = time();

    jsonResponse(['success' => true, 'username' => $user['username'], 'userId' => $user['id']]);
} catch (PDOException $e) {
    jsonResponse(['success' => false, 'message' => 'ログイン処理エラー'], 500);
}
