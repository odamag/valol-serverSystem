<?php
session_start();
require_once dirname(__DIR__) . '/common.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed'], 405);
}

$data  = json_decode(file_get_contents('php://input'), true);
$token = trim($data['deviceToken'] ?? '');

if ($token === '' || !preg_match('/^[0-9a-f]{64}$/', $token)) {
    jsonResponse(['success' => false, 'message' => '無効なトークンです']);
}

try {
    $db = getDB();

    // 30日以上使われていないトークンを削除
    $db->exec('DELETE FROM site_tokens WHERE last_used_at < ' . (time() - 30 * 86400));

    $stmt = $db->prepare('SELECT id FROM site_tokens WHERE token = ?');
    $stmt->execute([$token]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$row) {
        jsonResponse(['success' => false, 'message' => 'デバイスが見つかりません']);
    }

    $stmt2 = $db->prepare('UPDATE site_tokens SET last_used_at = ? WHERE token = ?');
    $stmt2->execute([time(), $token]);

    $_SESSION['site_auth'] = true;

    jsonResponse(['success' => true]);
} catch (PDOException $e) {
    jsonResponse(['success' => false, 'message' => 'デバイス認証エラー'], 500);
}
