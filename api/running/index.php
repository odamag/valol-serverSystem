<?php
// Running API フロントコントローラ。
// React SPA からの /api/running/... リクエストを HMAC 署名付きで AWS API Gateway
// へ転送する薄いプロキシ層。ビジネスロジックは一切持たず、認証・パス検証・
// 署名・転送・応答の透過のみを行う。
session_start();

require_once dirname(__DIR__) . '/common.php';
require_once __DIR__ . '/lib/aws.php';

// ── リクエストパスの解決 ──────────────────────────────────────────
// 1. ?path= （PHPビルトインサーバーは .htaccess を読まないため、ローカル検証用の
//    フォールバックとして必須。本番でもリライトが効かない場合の保険になる）
// 2. PATH_INFO
// 3. REQUEST_URI を /api/running 以降として解析
function runningResolvePath(): string {
    if (isset($_GET['path']) && $_GET['path'] !== '') {
        $path = $_GET['path'];
    } elseif (!empty($_SERVER['PATH_INFO'])) {
        $path = $_SERVER['PATH_INFO'];
    } else {
        $uri  = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/';
        $path = preg_replace('#^/api/running(/index\.php)?#', '', $uri);
        if ($path === '' || $path === null) {
            $path = '/';
        }
    }
    if ($path === '' || $path[0] !== '/') {
        $path = '/' . $path;
    }
    return $path;
}

// ── パスのホワイトリスト ────────────────────────────────────────
// [HTTPメソッド, パス正規表現]
//
// なぜホワイトリストが要るか: {proxy+} のような無検査の丸ごと中継にすると、
// AWS 側に将来生える内部エンドポイント（管理用・デバッグ用など）まで、
// 検証なしに外部へ露出させてしまう。PHP 側で許可するパスとメソッドを
// 明示的に列挙することで、公開面を最小限に保つ。
$ALLOWED = [
    ['GET',    '#^/v1/records$#'],
    ['POST',   '#^/v1/records$#'],
    ['PATCH',  '#^/v1/records/[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9a-f]{32}$#'],
    ['DELETE', '#^/v1/records/[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9a-f]{32}$#'],
    ['POST',   '#^/v1/records/[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9a-f]{32}/photo-url$#'],
    ['POST',   '#^/v1/records/[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9a-f]{32}/photo$#'],
    ['GET',    '#^/v1/ranking$#'],
    ['GET',    '#^/v1/me/summary$#'],
    ['GET',    '#^/v1/settings$#'],
];

// パスとメソッドをホワイトリストと照合する。
// マッチしたがメソッドだけ違う場合は 405、まったくマッチしなければ 404。
function runningCheckAllowed(array $allowed, string $path, string $method): void {
    $matchedPathButNotMethod = false;

    foreach ($allowed as [$allowedMethod, $regex]) {
        if (!preg_match($regex, $path)) {
            continue;
        }
        if ($allowedMethod !== $method) {
            $matchedPathButNotMethod = true;
            continue;
        }
        return; // OK
    }

    if ($matchedPathButNotMethod) {
        jsonResponse(['success' => false, 'message' => 'Method Not Allowed'], 405);
    }
    jsonResponse(['success' => false, 'message' => 'Not Found'], 404);
}

try {
    requireAuth();

    // discord_id をボディやヘッダから受け取る経路は絶対に作らない。
    // 必ずセッションの user_id から auth.db を引いて解決した値のみを署名対象にする
    // （そうしないとクライアントが任意の discord_id を名乗って転送させられてしまう）。
    $discordId = null;
    try {
        $authDb = getDB();
        $stmt = $authDb->prepare('
            SELECT du.discord_id AS discord_id
            FROM discord_users du
            WHERE du.user_id = ?
        ');
        $stmt->execute([(int)$_SESSION['user_id']]);
        $row = $stmt->fetch();
        if ($row) {
            $discordId = (string)$row['discord_id'];
        }
    } catch (PDOException $e) {
        // discord_users テーブルが未作成などの環境でクラッシュさせない。
        // ただしこの場合は「見つからなかった」ではなく設定不備なので 500 にする。
        error_log('[running] discord_id lookup failed: ' . $e->getMessage());
        jsonResponse(['success' => false, 'message' => 'サーバーエラーが発生しました'], 500);
    }

    if ($discordId === null) {
        jsonResponse(['success' => false, 'message' => 'ランニング機能を使うには Discord でログインしてください'], 403);
    }

    $path   = runningResolvePath();
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

    runningCheckAllowed($ALLOWED, $path, $method);

    // GET / DELETE ではボディを読まない
    $body = '';
    if ($method !== 'GET' && $method !== 'DELETE') {
        $body = (string)file_get_contents('php://input');
        // 画像は S3 直接アップロードのため、この API に大きなボディは来ない想定。
        if (strlen($body) > 16384) {
            jsonResponse(['success' => false, 'message' => 'リクエストボディが大きすぎます'], 413);
        }
    }

    // ?path= フォールバック時、転送クエリから path キーを除く
    $q = $_GET;
    unset($q['path']);
    $query = http_build_query($q);

    $configPath = __DIR__ . '/config.php';
    if (!file_exists($configPath)) {
        error_log('[running] config.php が配置されていません');
        jsonResponse(['success' => false, 'message' => '設定ファイルが配置されていません'], 500);
    }
    $config = require $configPath;

    // 設定漏れは「AWS 側で 401 が返るだけ」という分かりにくい形で表面化するため、
    // ここで先に弾いて原因の分かるエラーにする。
    if (!is_array($config) || empty($config['api_base']) || empty($config['shared_secret'])) {
        error_log('[running] config.php の api_base / shared_secret が未設定です');
        jsonResponse(['success' => false, 'message' => '設定ファイルが正しく設定されていません'], 500);
    }

    $res = runningForward($config, $method, $path, $query, $discordId, $body);

    if ($res['status'] === 0) {
        jsonResponse(['success' => false, 'message' => 'ランニングサーバーに接続できませんでした。しばらくしてからお試しください'], 503);
    }

    $decoded = json_decode((string)$res['body'], true);
    if (!is_array($decoded) || !array_key_exists('success', $decoded)) {
        error_log('[running] unexpected upstream response: status=' . $res['status'] . ' body=' . substr((string)$res['body'], 0, 500));
        jsonResponse(['success' => false, 'message' => 'サーバーエラーが発生しました'], 502);
    }

    // AWS 側も { success: bool, message: '日本語' } 形式で返す規約のため、
    // PHP 側でのフィールドマッピングは不要。そのまま透過する。
    jsonResponse($decoded, $res['status']);
} catch (Throwable $e) {
    error_log('[running] unhandled error: ' . $e->getMessage());
    jsonResponse(['success' => false, 'message' => 'サーバーエラーが発生しました'], 500);
}
