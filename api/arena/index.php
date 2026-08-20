<?php
// Arena API フロントコントローラ。ルーティングとディスパッチのみを担う。
session_start();

require_once dirname(__DIR__) . '/common.php';
require_once __DIR__ . '/lib/db.php';
require_once __DIR__ . '/lib/auth.php';
require_once __DIR__ . '/lib/format.php';
require_once __DIR__ . '/lib/seed.php';
require_once __DIR__ . '/lib/series.php';
require_once __DIR__ . '/lib/rating.php';
require_once __DIR__ . '/routes/read.php';
require_once __DIR__ . '/routes/admin.php';
require_once __DIR__ . '/routes/me.php';
require_once __DIR__ . '/routes/series.php';
require_once __DIR__ . '/routes/result.php';
require_once __DIR__ . '/routes/ranking.php';

// ── リクエストパスの解決 ──────────────────────────────────────────
// 1. ?path= （PHPビルトインサーバーは .htaccess を読まないため、ローカル検証用の
//    フォールバックとして必須。本番でもリライトが効かない場合の保険になる）
// 2. PATH_INFO
// 3. REQUEST_URI を /api/arena 以降として解析
function arenaResolvePath(): string {
    if (isset($_GET['path']) && $_GET['path'] !== '') {
        $path = $_GET['path'];
    } elseif (!empty($_SERVER['PATH_INFO'])) {
        $path = $_SERVER['PATH_INFO'];
    } else {
        $uri  = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/';
        $path = preg_replace('#^/api/arena(/index\.php)?#', '', $uri);
        if ($path === '' || $path === null) {
            $path = '/';
        }
    }
    if ($path === '' || $path[0] !== '/') {
        $path = '/' . $path;
    }
    return $path;
}

// ── ルート表 ─────────────────────────────────────────────────────
// [HTTPメソッド, パス正規表現（名前付きキャプチャ）, ハンドラ]
$routes = [
    ['GET', '#^/v1/users$#',                      'arenaHandleUsers'],
    ['GET', '#^/v1/games$#',                       'arenaHandleGames'],
    ['GET', '#^/v1/formats$#',                     'arenaHandleFormats'],
    ['GET', '#^/v1/me$#',                          'arenaHandleMe'],

    // 所持ゲーム
    ['GET', '#^/v1/me/games$#',                     'arenaHandleMeGamesGet'],
    ['PUT', '#^/v1/me/games$#',                     'arenaHandleMeGamesPut'],

    // シリーズ（タイトルドラフト → 5番勝負）。ローカル / オンライン両モード対応
    ['POST', '#^/v1/series$#',                                          'arenaHandleSeriesCreate'],
    ['GET',  '#^/v1/series$#',                                          'arenaHandleSeriesList'],
    ['GET',  '#^/v1/series/(?P<public_id>[a-f0-9]{8})$#',               'arenaHandleSeriesGet'],
    ['POST', '#^/v1/series/(?P<public_id>[a-f0-9]{8})/join$#',          'arenaHandleSeriesJoin'],
    ['POST', '#^/v1/series/(?P<public_id>[a-f0-9]{8})/roulette$#',      'arenaHandleSeriesRoulette'],
    ['POST', '#^/v1/series/(?P<public_id>[a-f0-9]{8})/choose-side$#',   'arenaHandleSeriesChooseSide'],
    ['GET',  '#^/v1/series/(?P<public_id>[a-f0-9]{8})/draft$#',         'arenaHandleSeriesDraftGet'],
    ['POST', '#^/v1/series/(?P<public_id>[a-f0-9]{8})/draft$#',         'arenaHandleSeriesDraftPost'],
    ['POST', '#^/v1/series/(?P<public_id>[a-f0-9]{8})/cancel$#',        'arenaHandleSeriesCancel'],

    // 5番勝負の勝敗記録（申告 → 相手の承認でElo確定）
    ['POST', '#^/v1/series/(?P<public_id>[a-f0-9]{8})/games/(?P<game_no>\d+)/result$#',  'arenaHandleSeriesGameResult'],
    ['POST', '#^/v1/series/(?P<public_id>[a-f0-9]{8})/games/(?P<game_no>\d+)/confirm$#', 'arenaHandleSeriesGameConfirm'],

    // ランキング
    ['GET', '#^/v1/ranking$#',                       'arenaHandleRanking'],
    ['GET', '#^/v1/players/(?P<id>\d+)$#',           'arenaHandlePlayer'],
    ['GET', '#^/v1/head-to-head$#',                  'arenaHandleHeadToHead'],
    ['GET', '#^/v1/title-stats$#',                   'arenaHandleTitleStats'],
    ['GET', '#^/v1/seasons/current$#',               'arenaHandleSeasonCurrent'],

    // ゲームマスタ / フォーマット管理（管理者のみ。各ハンドラ内で requireArenaAdmin() を呼ぶ）
    ['GET',    '#^/v1/admin/games$#',                         'arenaHandleAdminGamesList'],
    ['POST',   '#^/v1/admin/games$#',                         'arenaHandleAdminGameCreate'],
    ['PATCH',  '#^/v1/admin/games/(?P<slug>[a-z0-9_-]+)$#',   'arenaHandleAdminGameUpdate'],
    ['DELETE', '#^/v1/admin/games/(?P<slug>[a-z0-9_-]+)$#',   'arenaHandleAdminGameDelete'],
    ['GET',    '#^/v1/admin/formats$#',                       'arenaHandleAdminFormatsList'],
    ['POST',   '#^/v1/admin/formats$#',                       'arenaHandleAdminFormatCreate'],
    ['PATCH',  '#^/v1/admin/formats/(?P<id>\d+)$#',           'arenaHandleAdminFormatUpdate'],
    ['DELETE', '#^/v1/admin/formats/(?P<id>\d+)$#',           'arenaHandleAdminFormatDelete'],
    ['POST',   '#^/v1/admin/seasons$#',                       'arenaHandleAdminSeasonStart'],
    ['PATCH',  '#^/v1/admin/seasons/current$#',                'arenaHandleAdminSeasonUpdate'],
    ['GET',    '#^/v1/admin/settings$#',                      'arenaHandleAdminSettingsGet'],
    ['PATCH',  '#^/v1/admin/settings$#',                      'arenaHandleAdminSettingsUpdate'],
    ['GET',    '#^/v1/admin/keys$#',                          'arenaHandleAdminKeysList'],
    ['POST',   '#^/v1/admin/keys$#',                          'arenaHandleAdminKeyCreate'],
    ['DELETE', '#^/v1/admin/keys/(?P<id>\d+)$#',              'arenaHandleAdminKeyDelete'],
    ['GET',    '#^/v1/admin/admins$#',                        'arenaHandleAdminAdminsList'],
    ['POST',   '#^/v1/admin/admins$#',                        'arenaHandleAdminAdminCreate'],
    ['DELETE', '#^/v1/admin/admins/(?P<id>\d+)$#',            'arenaHandleAdminAdminDelete'],
];

function arenaDispatch(array $routes, string $path, string $method, PDO $db): void {
    $matchedPathButNotMethod = false;

    foreach ($routes as [$routeMethod, $regex, $handler]) {
        if (!preg_match($regex, $path, $matches)) {
            continue;
        }
        if ($routeMethod !== $method) {
            $matchedPathButNotMethod = true;
            continue;
        }
        $params = array_filter($matches, 'is_string', ARRAY_FILTER_USE_KEY);
        $handler($params, $db);
        return;
    }

    if ($matchedPathButNotMethod) {
        jsonResponse(['success' => false, 'message' => 'Method Not Allowed'], 405);
    }
    jsonResponse(['success' => false, 'message' => 'Not Found'], 404);
}

try {
    $db = getArenaDB();
    arenaSeed($db);

    $path   = arenaResolvePath();
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

    arenaDispatch($routes, $path, $method, $db);
} catch (Throwable $e) {
    error_log('[arena] unhandled error: ' . $e->getMessage());
    jsonResponse(['success' => false, 'message' => 'サーバーエラーが発生しました'], 500);
}
