<?php
// Discord OAuth2 認証開始 — Discord の認証ページへリダイレクト
session_start();

$config = require __DIR__ . '/discord_config.php';

// CSRF 対策: ランダムな state を生成してセッションに保存
$state = bin2hex(random_bytes(16));
$_SESSION['discord_state']      = $state;
$_SESSION['discord_state_time'] = time();

$params = http_build_query([
    'client_id'     => $config['client_id'],
    'redirect_uri'  => $config['redirect_uri'],
    'response_type' => 'code',
    'scope'         => $config['scope'],
    'state'         => $state,
    'prompt'        => 'none',  // 既にDiscord認証済みなら即リダイレクト
]);

header('Location: https://discord.com/api/oauth2/authorize?' . $params);
exit;
