<?php
session_start();
require_once dirname(__DIR__) . '/common.php';

jsonResponse([
    'loggedIn' => isset($_SESSION['user_id']),
    'userId'   => $_SESSION['user_id']   ?? null,
    'username' => $_SESSION['username']  ?? null,
]);
