<?php
session_start();
require_once dirname(__DIR__) . '/common.php';

$now = time();

function getPredictDB(): PDO {
    $path = dirname(dirname(__DIR__)) . '/db-folder/lol_predict.db';
    $db   = new PDO('sqlite:' . $path);
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $db->exec("PRAGMA journal_mode=WAL");
    $db->exec("
        CREATE TABLE IF NOT EXISTS lol_matches (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            match_id     TEXT    UNIQUE NOT NULL,
            team1_name   TEXT    NOT NULL,
            team2_name   TEXT    NOT NULL,
            team1_code   TEXT    DEFAULT '',
            team2_code   TEXT    DEFAULT '',
            league_name  TEXT    DEFAULT '',
            scheduled_at INTEGER,
            result       TEXT,
            is_resolved  INTEGER DEFAULT 0,
            created_at   INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS lol_predictions (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    INTEGER NOT NULL,
            match_id   TEXT    NOT NULL,
            prediction TEXT    NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(user_id, match_id)
        );
        CREATE TABLE IF NOT EXISTS lol_points (
            user_id      INTEGER PRIMARY KEY,
            username     TEXT,
            total_points INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS lol_meta (
            key   TEXT PRIMARY KEY,
            value TEXT
        );
    ");
    return $db;
}

// eSports API から全リーグ一覧を取得
function fetchLeagues(): ?array {
    $url = 'https://esports-api.lolesports.com/persisted/gw/getLeagues?hl=ja-JP';
    $ch  = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 10,
        CURLOPT_HTTPHEADER     => ['x-api-key: 0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z'],
    ]);
    $body = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($code !== 200 || !$body) return null;
    $data = json_decode($body, true);
    return is_array($data) ? $data : null;
}

// eSports API からスケジュールを取得
function fetchEsportsSchedule(): ?array {
    $url = 'https://esports-api.lolesports.com/persisted/gw/getSchedule?hl=ja-JP';
    $ch  = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 10,
        CURLOPT_HTTPHEADER     => ['x-api-key: 0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z'],
    ]);
    $body = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($code !== 200 || !$body) return null;
    $data = json_decode($body, true);
    return is_array($data) ? $data : null;
}

// 試合を結果確定させてポイントを付与する
// ポイント = floor(100 * 総投票数 / 当選側投票数)
// → 少数派に投票した人ほど高倍率
function resolveMatch(PDO $db, string $matchId, string $result): void {
    $stmt = $db->prepare("SELECT user_id, prediction FROM lol_predictions WHERE match_id = ?");
    $stmt->execute([$matchId]);
    $preds = $stmt->fetchAll(PDO::FETCH_ASSOC);

    $total    = count($preds);
    $winCount = 0;
    foreach ($preds as $p) {
        if ($p['prediction'] === $result) $winCount++;
    }

    if ($total > 0 && $winCount > 0) {
        $points = (int)floor(100 * $total / $winCount);
        $upd = $db->prepare("
            INSERT INTO lol_points (user_id, total_points)
            VALUES (?, ?)
            ON CONFLICT(user_id) DO UPDATE SET total_points = total_points + excluded.total_points
        ");
        foreach ($preds as $p) {
            if ($p['prediction'] === $result) {
                $upd->execute([$p['user_id'], $points]);
            }
        }
    }

    $db->prepare("UPDATE lol_matches SET is_resolved = 1, result = ? WHERE match_id = ?")
       ->execute([$result, $matchId]);
}

// 表示対象リーグ（名前の部分一致で判定）
const ALLOWED_LEAGUES = ['LCK', 'LCP', 'First Stand', 'MSI', 'Worlds'];

// Tier2以下は除外（部分一致）
const BLOCKED_KEYWORDS = ['Challengers', 'Academy', 'Proving Grounds', 'Amateur'];

function isAllowedLeague(string $name): bool {
    foreach (BLOCKED_KEYWORDS as $blocked) {
        if (stripos($name, $blocked) !== false) return false;
    }
    foreach (ALLOWED_LEAGUES as $allowed) {
        if (stripos($name, $allowed) !== false) return true;
    }
    return false;
}

// eSports API と同期し、完了した試合を自動解決する（±7日ウィンドウ）
function syncAndAutoResolve(PDO $db): void {
    // 対象外リーグのレコードをDBから削除
    $notLike = implode(' AND ', array_map(fn($l) => "league_name NOT LIKE ?", ALLOWED_LEAGUES));
    $params  = array_map(fn($l) => "%{$l}%", ALLOWED_LEAGUES);
    $badIds  = $db->prepare("SELECT match_id FROM lol_matches WHERE {$notLike}");
    $badIds->execute($params);
    $ids = $badIds->fetchAll(PDO::FETCH_COLUMN);

    // Tier2キーワードを含むレコードも削除（例: LCK Challengers）
    $blocked = implode(' OR ', array_map(fn($k) => "league_name LIKE ?", BLOCKED_KEYWORDS));
    $blockedIds = $db->prepare("SELECT match_id FROM lol_matches WHERE {$blocked}");
    $blockedIds->execute(array_map(fn($k) => "%{$k}%", BLOCKED_KEYWORDS));
    $ids = array_unique(array_merge($ids, $blockedIds->fetchAll(PDO::FETCH_COLUMN)));

    if ($ids) {
        $ph = implode(',', array_fill(0, count($ids), '?'));
        $db->prepare("DELETE FROM lol_predictions WHERE match_id IN ({$ph})")->execute($ids);
        $db->prepare("DELETE FROM lol_matches    WHERE match_id IN ({$ph})")->execute($ids);
    }

    // ── クールダウン: 10分以内なら API fetch を skip ─────────────
    $now2 = time();
    $COOLDOWN = 600;
    $row = $db->query("SELECT value FROM lol_meta WHERE key = 'last_sync'")->fetch(PDO::FETCH_ASSOC);
    if ($row && ($now2 - (int)$row['value']) < $COOLDOWN) return;
    $db->prepare("INSERT INTO lol_meta (key, value) VALUES ('last_sync', ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value")
       ->execute([$now2]);

    $data = fetchEsportsSchedule();
    if (!$data || !isset($data['data']['schedule']['events'])) return;

    $now         = time();
    $windowStart = $now - 7 * 86400;
    $windowEnd   = $now + 7 * 86400;

    foreach ($data['data']['schedule']['events'] as $ev) {
        if (($ev['type'] ?? '') !== 'match') continue;

        // 対象リーグ以外はスキップ
        $leagueName = $ev['league']['name'] ?? '';
        if (!isAllowedLeague($leagueName)) continue;

        $match = $ev['match'] ?? null;
        if (!$match) continue;

        $matchId     = (string)($match['id'] ?? '');
        $teams       = $match['teams'] ?? [];
        if (!$matchId || count($teams) < 2) continue;

        $scheduledAt = isset($ev['startTime']) ? strtotime($ev['startTime']) : null;
        if ($scheduledAt && ($scheduledAt < $windowStart || $scheduledAt > $windowEnd)) continue;

        $t1 = $teams[0];
        $t2 = $teams[1];

        // 存在しなければ挿入
        $db->prepare("
            INSERT OR IGNORE INTO lol_matches
                (match_id, team1_name, team2_name, team1_code, team2_code, league_name, scheduled_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ")->execute([
            $matchId,
            $t1['name'] ?? $t1['code'] ?? 'Team 1',
            $t2['name'] ?? $t2['code'] ?? 'Team 2',
            $t1['code'] ?? '',
            $t2['code'] ?? '',
            $ev['league']['name'] ?? '',
            $scheduledAt,
            $now,
        ]);

        // completed になっていたら自動解決
        if (($ev['state'] ?? '') === 'completed') {
            $chk = $db->prepare("SELECT is_resolved FROM lol_matches WHERE match_id = ?");
            $chk->execute([$matchId]);
            $row = $chk->fetch(PDO::FETCH_ASSOC);

            if ($row && !$row['is_resolved']) {
                $outcome = $t1['result']['outcome'] ?? null;
                if ($outcome === 'win') {
                    resolveMatch($db, $matchId, 'team1');
                } elseif ($outcome === 'loss') {
                    resolveMatch($db, $matchId, 'team2');
                }
            }
        }
    }
}

// ────────────────────────────────────────────────────────────────────────
// ルーティング
// ────────────────────────────────────────────────────────────────────────
$body   = [];
$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? '';

if ($method === 'POST') {
    $body   = json_decode(file_get_contents('php://input'), true) ?? [];
    $action = $body['action'] ?? $action;
}

$db = getPredictDB();

switch ($action) {

    // ── 試合一覧（+ API同期）─────────────────────────────────────────
    case 'matches':
        syncAndAutoResolve($db);

        $userId = $_SESSION['user_id'] ?? null;

        $likeClauses = implode(' OR ', array_map(fn($l) => "m.league_name LIKE ?", ALLOWED_LEAGUES));
        $likeParams  = array_map(fn($l) => "%{$l}%", ALLOWED_LEAGUES);
        $stmt = $db->prepare("
            SELECT m.*,
                (SELECT COUNT(*) FROM lol_predictions WHERE match_id = m.match_id AND prediction = 'team1') AS v1,
                (SELECT COUNT(*) FROM lol_predictions WHERE match_id = m.match_id AND prediction = 'team2') AS v2
            FROM lol_matches m
            WHERE {$likeClauses}
            ORDER BY m.is_resolved ASC, m.scheduled_at ASC, m.created_at ASC
        ");
        $stmt->execute($likeParams);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        foreach ($rows as &$r) {
            $v1    = (int)$r['v1'];
            $v2    = (int)$r['v2'];
            $total = $v1 + $v2;

            $r['team1_votes']      = $v1;
            $r['team2_votes']      = $v2;
            $r['total_votes']      = $total;
            // 倍率：投票が少ない側ほど高倍率
            $r['team1_multiplier'] = ($v1 > 0 && $total > 0) ? round($total / $v1, 1) : null;
            $r['team2_multiplier'] = ($v2 > 0 && $total > 0) ? round($total / $v2, 1) : null;
            $r['my_prediction']    = null;

            if ($userId) {
                $s = $db->prepare("SELECT prediction FROM lol_predictions WHERE user_id = ? AND match_id = ?");
                $s->execute([$userId, $r['match_id']]);
                $p = $s->fetch(PDO::FETCH_ASSOC);
                $r['my_prediction'] = $p ? $p['prediction'] : null;
            }

            unset($r['v1'], $r['v2']);
        }

        jsonResponse(['success' => true, 'matches' => $rows]);
        break;

    // ── 投票 ──────────────────────────────────────────────────────────
    case 'vote':
        if (!isset($_SESSION['user_id'])) {
            jsonResponse(['success' => false, 'message' => 'ログインが必要です'], 401);
        }

        $matchId    = (string)($body['match_id']   ?? '');
        $prediction = (string)($body['prediction'] ?? '');

        if (!$matchId || !in_array($prediction, ['team1', 'team2'], true)) {
            jsonResponse(['success' => false, 'message' => '無効な入力です'], 400);
        }

        $chk = $db->prepare("SELECT is_resolved FROM lol_matches WHERE match_id = ?");
        $chk->execute([$matchId]);
        $m = $chk->fetch(PDO::FETCH_ASSOC);

        if (!$m)              jsonResponse(['success' => false, 'message' => '試合が見つかりません'], 404);
        if ($m['is_resolved']) jsonResponse(['success' => false, 'message' => 'この試合は既に終了しています'], 400);

        $userId   = $_SESSION['user_id'];
        $username = $_SESSION['username'] ?? 'Unknown';

        $db->prepare("
            INSERT INTO lol_predictions (user_id, match_id, prediction, created_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, match_id) DO UPDATE SET prediction = excluded.prediction
        ")->execute([$userId, $matchId, $prediction, $now]);

        // ポイントテーブルにユーザーが未登録なら登録（0点で）
        $db->prepare("
            INSERT OR IGNORE INTO lol_points (user_id, username, total_points)
            VALUES (?, ?, 0)
        ")->execute([$userId, $username]);

        jsonResponse(['success' => true]);
        break;

    // ── リーダーボード ────────────────────────────────────────────────
    case 'leaderboard':
        $rows = $db->query("
            SELECT
                lp.user_id,
                lp.username,
                lp.total_points,
                (SELECT COUNT(*) FROM lol_predictions WHERE user_id = lp.user_id) AS total_preds,
                (SELECT COUNT(*)
                    FROM lol_predictions pr
                    JOIN lol_matches lm ON lm.match_id = pr.match_id
                    WHERE pr.user_id = lp.user_id
                      AND lm.is_resolved = 1
                      AND pr.prediction  = lm.result
                ) AS correct_preds
            FROM lol_points lp
            ORDER BY lp.total_points DESC
            LIMIT 20
        ")->fetchAll(PDO::FETCH_ASSOC);

        jsonResponse(['success' => true, 'rankings' => $rows]);
        break;

    // ── 利用可能なリーグ一覧 ──────────────────────────────────────────────
    case 'leagues':
        $data = fetchLeagues();
        if (!$data || !isset($data['data']['leagues'])) {
            jsonResponse(['success' => false, 'message' => 'リーグ一覧の取得に失敗しました'], 502);
        }
        $leagues = array_map(fn($l) => [
            'id'     => $l['id']   ?? '',
            'name'   => $l['name'] ?? '',
            'region' => $l['region'] ?? '',
        ], $data['data']['leagues']);

        // region でソート
        usort($leagues, fn($a, $b) => strcmp($a['region'], $b['region']));

        jsonResponse(['success' => true, 'leagues' => $leagues]);
        break;

    default:
        jsonResponse(['success' => false, 'message' => '不明なアクションです'], 400);
}
