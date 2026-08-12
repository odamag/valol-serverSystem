<?php
session_start();
require_once dirname(dirname(__DIR__)) . '/api/common.php';

$now = time();

// ─────────────────────────────────────────────────────────────────────────────
// DB
// ─────────────────────────────────────────────────────────────────────────────
function getValDB(): PDO {
    $path = dirname(dirname(__DIR__)) . '/db-folder/valorant_predict.db';
    $db   = new PDO('sqlite:' . $path);
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $db->exec("PRAGMA journal_mode=WAL");
    $db->exec("
        CREATE TABLE IF NOT EXISTS val_matches (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            match_id     TEXT    UNIQUE NOT NULL,
            team1_name   TEXT    NOT NULL,
            team2_name   TEXT    NOT NULL,
            tournament   TEXT    DEFAULT '',
            round_info   TEXT    DEFAULT '',
            scheduled_at INTEGER,
            result       TEXT,
            is_resolved  INTEGER DEFAULT 0,
            is_manual    INTEGER DEFAULT 0,
            created_at   INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS val_predictions (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    INTEGER NOT NULL,
            match_id   TEXT    NOT NULL,
            prediction TEXT    NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(user_id, match_id)
        );
        CREATE TABLE IF NOT EXISTS val_points (
            user_id      INTEGER PRIMARY KEY,
            username     TEXT,
            total_points INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS val_meta (
            key   TEXT PRIMARY KEY,
            value TEXT
        );
    ");
    return $db;
}

// ─────────────────────────────────────────────────────────────────────────────
// PandaScore API
// ─────────────────────────────────────────────────────────────────────────────
function pandaFetch(string $path): ?array {
    require_once __DIR__ . '/config.php';
    $url = 'https://api.pandascore.co' . $path;
    $ch  = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 10,
        CURLOPT_HTTPHEADER     => ['Authorization: Bearer ' . PANDASCORE_KEY],
    ]);
    $body = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($code !== 200 || !$body) return null;
    $data = json_decode($body, true);
    return is_array($data) ? $data : null;
}

// opponents 配列からチーム名を取得
function pandaTeamName(array $opponents, int $idx): string {
    return $opponents[$idx]['opponent']['name'] ?? 'TBD';
}

// ─────────────────────────────────────────────────────────────────────────────
// ポイント付与
// ─────────────────────────────────────────────────────────────────────────────
function resolveMatch(PDO $db, string $matchId, string $result): void {
    $stmt = $db->prepare("SELECT user_id, prediction FROM val_predictions WHERE match_id = ?");
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
            INSERT INTO val_points (user_id, total_points)
            VALUES (?, ?)
            ON CONFLICT(user_id) DO UPDATE SET total_points = total_points + excluded.total_points
        ");
        foreach ($preds as $p) {
            if ($p['prediction'] === $result) {
                $upd->execute([$p['user_id'], $points]);
            }
        }
    }

    $db->prepare("UPDATE val_matches SET is_resolved = 1, result = ? WHERE match_id = ?")
       ->execute([$result, $matchId]);
}

// ─────────────────────────────────────────────────────────────────────────────
// PandaScore 同期（upcoming 取り込み + finished で自動解決）
// ─────────────────────────────────────────────────────────────────────────────
function syncFromPandascore(PDO $db): void {
    $now = time();

    // ── クールダウン: 10分以内なら skip ──────────────────────────
    $COOLDOWN = 600;
    $row = $db->query("SELECT value FROM val_meta WHERE key = 'last_sync'")->fetch(PDO::FETCH_ASSOC);
    if ($row && ($now - (int)$row['value']) < $COOLDOWN) return;
    $db->prepare("INSERT INTO val_meta (key, value) VALUES ('last_sync', ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value")
       ->execute([$now]);

    // ── upcoming: 予定試合を取り込む ──────────────────────────────
    $upcoming = pandaFetch('/valorant/matches/upcoming?per_page=50&sort=scheduled_at');
    if (is_array($upcoming)) {
        foreach ($upcoming as $m) {
            $matchId   = 'ps_' . $m['id'];
            $opponents = $m['opponents'] ?? [];

            // VCT 以外はDB から削除して skip
            $leagueName = strtoupper(substr($m['league']['name'] ?? '', 0, 3));
            if ($leagueName !== 'VCT') {
                $db->prepare("DELETE FROM val_matches WHERE match_id = ? AND is_manual = 0")->execute([$matchId]);
                $db->prepare("DELETE FROM val_predictions WHERE match_id = ?")->execute([$matchId]);
                continue;
            }

            if (count($opponents) < 2) continue;

            $team1      = pandaTeamName($opponents, 0);
            $team2      = pandaTeamName($opponents, 1);
            $serieName  = trim($m['serie']['name'] ?? '');
            $leagueBase = $m['league']['name'] ?? '';

            // Pacific / Masters / Champions 以外は除外（Game Changers含む）
            $allowed = ['Pacific', 'Masters', 'Champions'];
            $ok = false;
            foreach ($allowed as $kw) {
                if (stripos($serieName, $kw) !== false) { $ok = true; break; }
            }
            if (!$ok) {
                $db->prepare("DELETE FROM val_matches WHERE match_id = ? AND is_manual = 0")->execute([$matchId]);
                $db->prepare("DELETE FROM val_predictions WHERE match_id = ?")->execute([$matchId]);
                continue;
            }
            $league     = $serieName ? $leagueBase . ' ' . $serieName : $leagueBase;
            $roundInfo  = $m['tournament']['name'] ?? '';
            $ts         = isset($m['scheduled_at']) ? strtotime($m['scheduled_at']) : null;

            $db->prepare("
                INSERT INTO val_matches
                    (match_id, team1_name, team2_name, tournament, round_info, scheduled_at, is_manual, created_at)
                VALUES (?, ?, ?, ?, ?, ?, 0, ?)
                ON CONFLICT(match_id) DO UPDATE SET
                    team1_name   = excluded.team1_name,
                    team2_name   = excluded.team2_name,
                    tournament   = excluded.tournament,
                    round_info   = excluded.round_info,
                    scheduled_at = excluded.scheduled_at
            ")->execute([$matchId, $team1, $team2, $league, $roundInfo, $ts, $now]);
        }
    }

    // ── finished: 結果確定した試合を自動解決 ──────────────────────
    $past = pandaFetch('/valorant/matches/past?per_page=50&sort=-scheduled_at');
    if (is_array($past)) {
        foreach ($past as $m) {
            $matchId   = 'ps_' . $m['id'];
            $winnerId  = $m['winner_id'] ?? null;
            $opponents = $m['opponents'] ?? [];

            // VCT 以外はDB から削除
            $leagueName = strtoupper(substr($m['league']['name'] ?? '', 0, 3));
            if ($leagueName !== 'VCT') {
                $db->prepare("DELETE FROM val_matches WHERE match_id = ? AND is_manual = 0")->execute([$matchId]);
                $db->prepare("DELETE FROM val_predictions WHERE match_id = ?")->execute([$matchId]);
                continue;
            }

            // Pacific / Masters / Champions 以外は除外（Game Changers含む）
            $serieName = trim($m['serie']['name'] ?? '');
            $allowed = ['Pacific', 'Masters', 'Champions'];
            $ok = false;
            foreach ($allowed as $kw) {
                if (stripos($serieName, $kw) !== false) { $ok = true; break; }
            }
            if (!$ok) {
                $db->prepare("DELETE FROM val_matches WHERE match_id = ? AND is_manual = 0")->execute([$matchId]);
                $db->prepare("DELETE FROM val_predictions WHERE match_id = ?")->execute([$matchId]);
                continue;
            }

            if (!$winnerId || count($opponents) < 2) continue;

            $chk = $db->prepare("SELECT is_resolved FROM val_matches WHERE match_id = ?");
            $chk->execute([$matchId]);
            $row = $chk->fetch(PDO::FETCH_ASSOC);
            if (!$row || $row['is_resolved']) continue;

            $opp1Id = $opponents[0]['opponent']['id'] ?? null;
            $result = ($winnerId == $opp1Id) ? 'team1' : 'team2';
            resolveMatch($db, $matchId, $result);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ルーティング
// ─────────────────────────────────────────────────────────────────────────────
$body   = [];
$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? '';

if ($method === 'POST') {
    $body   = json_decode(file_get_contents('php://input'), true) ?? [];
    $action = $body['action'] ?? $action;
}

$db = getValDB();

switch ($action) {

    // ── 試合一覧 ──────────────────────────────────────────────────────────
    case 'matches':
        syncFromPandascore($db);

        $userId = $_SESSION['user_id'] ?? null;

        $rows = $db->query("
            SELECT m.*,
                (SELECT COUNT(*) FROM val_predictions WHERE match_id = m.match_id AND prediction = 'team1') AS v1,
                (SELECT COUNT(*) FROM val_predictions WHERE match_id = m.match_id AND prediction = 'team2') AS v2
            FROM val_matches m
            ORDER BY m.is_resolved ASC, m.scheduled_at ASC, m.created_at ASC
        ")->fetchAll(PDO::FETCH_ASSOC);

        foreach ($rows as &$r) {
            $v1    = (int)$r['v1'];
            $v2    = (int)$r['v2'];
            $total = $v1 + $v2;
            $r['team1_votes']      = $v1;
            $r['team2_votes']      = $v2;
            $r['total_votes']      = $total;
            $r['team1_multiplier'] = ($v1 > 0 && $total > 0) ? round($total / $v1, 1) : null;
            $r['team2_multiplier'] = ($v2 > 0 && $total > 0) ? round($total / $v2, 1) : null;
            $r['my_prediction']    = null;

            if ($userId) {
                $s = $db->prepare("SELECT prediction FROM val_predictions WHERE user_id = ? AND match_id = ?");
                $s->execute([$userId, $r['match_id']]);
                $p = $s->fetch(PDO::FETCH_ASSOC);
                $r['my_prediction'] = $p ? $p['prediction'] : null;
            }
            unset($r['v1'], $r['v2']);
        }

        jsonResponse(['success' => true, 'matches' => $rows]);
        break;

    // ── 投票 ─────────────────────────────────────────────────────────────
    case 'vote':
        if (!isset($_SESSION['user_id'])) {
            jsonResponse(['success' => false, 'message' => 'ログインが必要です'], 401);
        }

        $matchId    = (string)($body['match_id']   ?? '');
        $prediction = (string)($body['prediction'] ?? '');

        if (!$matchId || !in_array($prediction, ['team1', 'team2'], true)) {
            jsonResponse(['success' => false, 'message' => '無効な入力です'], 400);
        }

        $chk = $db->prepare("SELECT is_resolved FROM val_matches WHERE match_id = ?");
        $chk->execute([$matchId]);
        $m = $chk->fetch(PDO::FETCH_ASSOC);

        if (!$m)               jsonResponse(['success' => false, 'message' => '試合が見つかりません'], 404);
        if ($m['is_resolved']) jsonResponse(['success' => false, 'message' => 'この試合は終了しています'], 400);

        $userId   = $_SESSION['user_id'];
        $username = $_SESSION['username'] ?? 'Unknown';

        $db->prepare("
            INSERT INTO val_predictions (user_id, match_id, prediction, created_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, match_id) DO UPDATE SET prediction = excluded.prediction
        ")->execute([$userId, $matchId, $prediction, $now]);

        $db->prepare("INSERT OR IGNORE INTO val_points (user_id, username, total_points) VALUES (?, ?, 0)")
           ->execute([$userId, $username]);

        jsonResponse(['success' => true]);
        break;

    // ── 手動試合登録 ──────────────────────────────────────────────────────
    case 'add_match':
        if (!isset($_SESSION['user_id'])) {
            jsonResponse(['success' => false, 'message' => 'ログインが必要です'], 401);
        }

        $team1      = trim($body['team1']      ?? '');
        $team2      = trim($body['team2']      ?? '');
        $tournament = trim($body['tournament'] ?? '');
        $roundInfo  = trim($body['round_info'] ?? '');
        $schedTs    = isset($body['scheduled_at']) ? (int)$body['scheduled_at'] : null;

        if (!$team1 || !$team2) {
            jsonResponse(['success' => false, 'message' => 'チーム名を入力してください'], 400);
        }

        $matchId = 'manual_' . uniqid('', true);

        $db->prepare("
            INSERT INTO val_matches
                (match_id, team1_name, team2_name, tournament, round_info, scheduled_at, is_manual, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 1, ?)
        ")->execute([$matchId, $team1, $team2, $tournament, $roundInfo, $schedTs, $now]);

        jsonResponse(['success' => true, 'match_id' => $matchId]);
        break;

    // ── 手動結果確定 ──────────────────────────────────────────────────────
    case 'resolve':
        if (!isset($_SESSION['user_id'])) {
            jsonResponse(['success' => false, 'message' => 'ログインが必要です'], 401);
        }

        $matchId = (string)($body['match_id'] ?? '');
        $result  = (string)($body['result']   ?? '');

        if (!$matchId || !in_array($result, ['team1', 'team2'], true)) {
            jsonResponse(['success' => false, 'message' => '無効な入力です'], 400);
        }

        $chk = $db->prepare("SELECT is_resolved FROM val_matches WHERE match_id = ?");
        $chk->execute([$matchId]);
        $m = $chk->fetch(PDO::FETCH_ASSOC);

        if (!$m)               jsonResponse(['success' => false, 'message' => '試合が見つかりません'], 404);
        if ($m['is_resolved']) jsonResponse(['success' => false, 'message' => '既に確定済みです'], 400);

        resolveMatch($db, $matchId, $result);
        jsonResponse(['success' => true]);
        break;

    // ── リーダーボード ────────────────────────────────────────────────────
    case 'leaderboard':
        $rows = $db->query("
            SELECT
                lp.user_id,
                lp.username,
                lp.total_points,
                (SELECT COUNT(*) FROM val_predictions WHERE user_id = lp.user_id) AS total_preds,
                (SELECT COUNT(*)
                    FROM val_predictions pr
                    JOIN val_matches lm ON lm.match_id = pr.match_id
                    WHERE pr.user_id = lp.user_id
                      AND lm.is_resolved = 1
                      AND pr.prediction  = lm.result
                ) AS correct_preds
            FROM val_points lp
            ORDER BY lp.total_points DESC
            LIMIT 20
        ")->fetchAll(PDO::FETCH_ASSOC);

        jsonResponse(['success' => true, 'rankings' => $rows]);
        break;

    // ── 同期クールダウンリセット（デバッグ用）────────────────────────────
    case 'reset_sync':
        if (!isset($_SESSION['user_id'])) {
            jsonResponse(['success' => false, 'message' => 'ログインが必要です'], 401);
        }
        $db->prepare("DELETE FROM val_meta WHERE key = 'last_sync'")->execute();
        syncFromPandascore($db);
        jsonResponse(['success' => true, 'message' => 'sync完了']);
        break;

    default:
        jsonResponse(['success' => false, 'message' => '不明なアクションです'], 400);
}
