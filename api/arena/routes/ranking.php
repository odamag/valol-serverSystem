<?php
// Phase 3: /v1/ranking, /v1/players/{user_id}, /v1/head-to-head ハンドラ。
// Phase 5 以降は arenaActor($db, 'read') を通す（セッション or read/write スコープの
// APIキー必須）。Arena配下のフロントルートは元々すべてログイン必須のため、
// ブラウザから見た挙動はこれまでと変わらない。

// GET /v1/ranking?game={slug|overall} — リーダーボード（read スコープのAPIキーも可）
function arenaHandleRanking(array $params, PDO $db): void {
    arenaActor($db, 'read');
    $gameParam = trim((string)($_GET['game'] ?? 'overall'));

    if ($gameParam === '' || $gameParam === 'overall') {
        $gameId = 0;
        $gameMeta = ['slug' => 'overall', 'name' => '総合', 'icon' => '🏆'];
    } else {
        $stmt = $db->prepare('SELECT id, slug, name, icon FROM arena_games WHERE slug = ?');
        $stmt->execute([$gameParam]);
        $game = $stmt->fetch();
        if (!$game) {
            jsonResponse(['success' => false, 'message' => 'ゲームが見つかりません'], 404);
        }
        $gameId = (int)$game['id'];
        $gameMeta = ['slug' => $game['slug'], 'name' => $game['name'], 'icon' => $game['icon']];
    }

    $stmt = $db->prepare('
        SELECT user_id, username, rating, wins, losses, streak, peak_rating, updated_at
        FROM arena_ratings
        WHERE game_id = ?
        ORDER BY rating DESC, wins DESC
        LIMIT 100
    ');
    $stmt->execute([$gameId]);

    $rank = 0;
    $rows = array_map(function ($r) use (&$rank) {
        $rank++;
        return [
            'rank'        => $rank,
            'user_id'     => (int)$r['user_id'],
            'username'    => $r['username'],
            'rating'      => round((float)$r['rating'], 1),
            'wins'        => (int)$r['wins'],
            'losses'      => (int)$r['losses'],
            'streak'      => (int)$r['streak'],
            'peak_rating' => round((float)$r['peak_rating'], 1),
        ];
    }, $stmt->fetchAll());

    jsonResponse(['success' => true, 'game' => $gameMeta, 'ranking' => $rows]);
}

// GET /v1/players/{user_id} — 個人成績・レート一覧・直近試合（read スコープのAPIキーも可）
function arenaHandlePlayer(array $params, PDO $db): void {
    arenaActor($db, 'read');
    $userId = (int)($params['id'] ?? 0);

    $stmt = $db->prepare('
        SELECT r.game_id, r.rating, r.wins, r.losses, r.streak, r.peak_rating,
               g.slug AS game_slug, g.name AS game_name, g.icon AS game_icon
        FROM arena_ratings r
        LEFT JOIN arena_games g ON g.id = r.game_id
        WHERE r.user_id = ?
        ORDER BY (r.game_id = 0) DESC, g.name
    ');
    $stmt->execute([$userId]);
    $ratings = array_map(function ($r) {
        $isOverall = (int)$r['game_id'] === 0;
        return [
            'game_id'     => (int)$r['game_id'],
            'game_slug'   => $isOverall ? 'overall' : $r['game_slug'],
            'game_name'   => $isOverall ? '総合' : $r['game_name'],
            'game_icon'   => $isOverall ? '🏆' : $r['game_icon'],
            'rating'      => round((float)$r['rating'], 1),
            'wins'        => (int)$r['wins'],
            'losses'      => (int)$r['losses'],
            'streak'      => (int)$r['streak'],
            'peak_rating' => round((float)$r['peak_rating'], 1),
        ];
    }, $stmt->fetchAll());

    $matchStmt = $db->prepare("
        SELECT * FROM arena_matches
        WHERE (player_a_id = ? OR player_b_id = ?) AND status = 'finished'
        ORDER BY finished_at DESC LIMIT 20
    ");
    $matchStmt->execute([$userId, $userId]);
    $recent = array_map(function ($m) use ($db) {
        return arenaSerializeMatch($db, $m);
    }, $matchStmt->fetchAll());

    jsonResponse(['success' => true, 'user_id' => $userId, 'ratings' => $ratings, 'recent_matches' => $recent]);
}

// GET /v1/head-to-head?a={id}&b={id} — 対戦相手別の戦績（arena_matches から集計、専用テーブルは持たない）
function arenaHandleHeadToHead(array $params, PDO $db): void {
    arenaActor($db, 'read');
    $a = (int)($_GET['a'] ?? 0);
    $b = (int)($_GET['b'] ?? 0);
    if ($a <= 0 || $b <= 0 || $a === $b) {
        jsonResponse(['success' => false, 'message' => 'a と b に異なるユーザーIDを指定してください'], 400);
    }

    $stmt = $db->prepare("
        SELECT m.*, g.slug AS game_slug, g.name AS game_name
        FROM arena_matches m
        LEFT JOIN arena_games g ON g.id = m.game_id
        WHERE m.status = 'finished'
          AND ((m.player_a_id = ? AND m.player_b_id = ?) OR (m.player_a_id = ? AND m.player_b_id = ?))
        ORDER BY m.finished_at DESC
    ");
    $stmt->execute([$a, $b, $b, $a]);
    $rows = $stmt->fetchAll();

    $aWins = 0;
    $bWins = 0;
    $matches = [];
    foreach ($rows as $row) {
        $aIsPlayerA = (int)$row['player_a_id'] === $a;
        $aWon = ($aIsPlayerA && $row['winner_side'] === 'A') || (!$aIsPlayerA && $row['winner_side'] === 'B');
        if ($aWon) {
            $aWins++;
        } else {
            $bWins++;
        }
        $matches[] = [
            'public_id'   => $row['public_id'],
            'game_slug'   => $row['game_slug'],
            'game_name'   => $row['game_name'],
            'winner_side' => $row['winner_side'],
            'a_won'       => $aWon,
            'score_a'     => (int)$row['score_a'],
            'score_b'     => (int)$row['score_b'],
            'finished_at' => $row['finished_at'] !== null ? (int)$row['finished_at'] : null,
        ];
    }

    jsonResponse([
        'success' => true,
        'a'       => $a,
        'b'       => $b,
        'a_wins'  => $aWins,
        'b_wins'  => $bWins,
        'matches' => $matches,
    ]);
}
