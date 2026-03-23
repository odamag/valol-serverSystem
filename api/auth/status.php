<?php
session_start();
require_once dirname(__DIR__) . '/common.php';

const SESSION_TIMEOUT = 1800; // 30分

if (isset($_SESSION['user_id'])) {
    $lastActive = $_SESSION['last_active'] ?? 0;
    if (time() - $lastActive > SESSION_TIMEOUT) {
        session_destroy();
        jsonResponse(['loggedIn' => false, 'userId' => null, 'username' => null, 'reason' => 'timeout']);
    }
    $_SESSION['last_active'] = time();
}

jsonResponse([
    'loggedIn' => isset($_SESSION['user_id']),
    'userId'   => $_SESSION['user_id']   ?? null,
    'username' => $_SESSION['username']  ?? null,
]);
