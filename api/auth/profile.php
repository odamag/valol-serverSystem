<?php
session_start();
require_once dirname(__DIR__) . '/common.php';
requireAuth();

if ($_SERVER['REQUEST_METHOD'] === 'DELETE') {
    try {
        $db   = getDB();
        $stmt = $db->prepare('DELETE FROM users WHERE id = ?');
        $stmt->execute([$_SESSION['user_id']]);
        session_destroy();
        jsonResponse(['success' => true]);
    } catch (PDOException $e) {
        jsonResponse(['success' => false, 'message' => 'アカウント削除エラー'], 500);
    }
}

jsonResponse(['success' => false, 'message' => 'Method not allowed'], 405);
