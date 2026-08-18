<?php
// Arena API フロントコントローラ。ルーティングとディスパッチのみを担う。
session_start();

require_once dirname(__DIR__) . '/common.php';
require_once __DIR__ . '/lib/db.php';
require_once __DIR__ . '/lib/auth.php';
require_once __DIR__ . '/lib/seed.php';
require_once __DIR__ . '/routes/read.php';

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
    ['GET', '#^/v1/games/(?P<slug>[a-z0-9_-]+)/entries$#', 'arenaHandleGameEntries'],
    ['GET', '#^/v1/me$#',                          'arenaHandleMe'],
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
