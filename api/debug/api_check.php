<?php
// API疎通確認ツール（ログイン必須）
session_start();
require_once dirname(dirname(__DIR__)) . '/api/common.php';

if (!isset($_SESSION['user_id'])) {
    http_response_code(401);
    die(json_encode(['error' => 'ログインが必要です'], JSON_UNESCAPED_UNICODE));
}

header('Content-Type: application/json; charset=utf-8');

function checkApi(string $label, string $url, array $headers = [], int $timeout = 10): array {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => $timeout,
        CURLOPT_USERAGENT      => 'Mozilla/5.0',
        CURLOPT_HTTPHEADER     => $headers,
    ]);
    $t0   = microtime(true);
    $body = curl_exec($ch);
    $ms   = (int)((microtime(true) - $t0) * 1000);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err  = curl_error($ch);
    curl_close($ch);

    $data    = $body ? json_decode($body, true) : null;
    $preview = null;

    if ($data) {
        // 各APIの「中身がある」ことをひとつだけ確認
        if (isset($data['data']['schedule']['events'])) {
            $count   = count($data['data']['schedule']['events']);
            $preview = "events: {$count}件";
        } elseif (isset($data['data']['leagues'])) {
            $count   = count($data['data']['leagues']);
            $preview = "leagues: {$count}件";
        } elseif (isset($data['data']['segments'])) {
            $count   = count($data['data']['segments']);
            $preview = "segments: {$count}件";
        } elseif (isset($data['data']['status'])) {
            $preview = "status: " . $data['data']['status'];
        } else {
            $preview = mb_substr(json_encode($data, JSON_UNESCAPED_UNICODE), 0, 120) . '...';
        }
    }

    return [
        'label'   => $label,
        'url'     => $url,
        'status'  => $code,
        'ok'      => ($code >= 200 && $code < 300),
        'ms'      => $ms,
        'preview' => $preview,
        'error'   => $err ?: null,
    ];
}

$LOL_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
$lolHeader = ["x-api-key: {$LOL_KEY}"];

// PandaScore VALORANT upcoming の tier 一覧をデバッグ
$tierDebug = (function() {
    $cfg = dirname(__DIR__) . '/valorant/config.php';
    if (!file_exists($cfg)) return ['error' => 'config.php not found'];
    require_once $cfg;
    if (!defined('PANDASCORE_KEY')) return ['error' => 'PANDASCORE_KEY undefined'];

    $url = 'https://api.pandascore.co/valorant/matches/upcoming?per_page=20&sort=scheduled_at';
    $ch  = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 10,
        CURLOPT_HTTPHEADER     => ['Authorization: Bearer ' . PANDASCORE_KEY],
    ]);
    $body = curl_exec($ch);
    $data = $body ? json_decode($body, true) : null;
    if (!is_array($data)) return ['error' => 'invalid response'];

    return array_map(fn($m) => [
        'id'             => $m['id'],
        'name'           => $m['name'] ?? '',
        'league_name'    => $m['league']['name']   ?? '',
        'league_slug'    => $m['league']['slug']   ?? '',
        'league_tier'    => $m['league']['tier']   ?? null,
        'serie_name'     => $m['serie']['name']    ?? '',
        'serie_slug'     => $m['serie']['slug']    ?? '',
        'serie_fullname' => $m['serie']['full_name'] ?? '',
        'tournament'     => $m['tournament']['name'] ?? '',
        'scheduled'      => $m['scheduled_at']     ?? null,
        'league_raw'     => $m['league'] ?? null,
    ], $data);
})();

$results = [
    checkApi(
        'LoL eSports - スケジュール',
        'https://esports-api.lolesports.com/persisted/gw/getSchedule?hl=ja-JP',
        $lolHeader
    ),
    checkApi(
        'LoL eSports - リーグ一覧',
        'https://esports-api.lolesports.com/persisted/gw/getLeagues?hl=ja-JP',
        $lolHeader
    ),
    checkApi(
        'PandaScore - VALORANT upcoming',
        'https://api.pandascore.co/valorant/matches/upcoming?per_page=5',
        (function() {
            $cfg = dirname(__DIR__) . '/valorant/config.php';
            if (!file_exists($cfg)) return [];
            require_once $cfg;
            return defined('PANDASCORE_KEY') ? ['Authorization: Bearer ' . PANDASCORE_KEY] : [];
        })()
    ),
    checkApi(
        'PandaScore - VALORANT past',
        'https://api.pandascore.co/valorant/matches/past?per_page=5&sort=-scheduled_at',
        (function() {
            $cfg = dirname(__DIR__) . '/valorant/config.php';
            if (!file_exists($cfg)) return [];
            require_once $cfg;
            return defined('PANDASCORE_KEY') ? ['Authorization: Bearer ' . PANDASCORE_KEY] : [];
        })()
    ),
];

echo json_encode([
    'checked_at'  => date('Y-m-d H:i:s'),
    'results'     => $results,
    'val_tiers'   => $tierDebug,
], JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
