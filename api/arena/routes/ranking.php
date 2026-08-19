<?php
// /v1/ranking, /v1/players/{user_id}, /v1/head-to-head ハンドラ。
// すべて arenaActor($db, 'read') を通す（セッション or read/write スコープの
// APIキー必須）。Arena配下のフロントルートは元々すべてログイン必須のため、
// ブラウザから見た挙動はこれまでと変わらない。
//
// ★R1時点の注意：結果申告・Elo反映（旧 arenaApplyMatchResult 相当）はR2で実装する。
// そのため arena_ratings / arena_rating_history はまだ実際には書き込まれず、
// 以下のエンドポイントは配線だけ済ませてあり実質空のデータを返す。
// game_id の意味は db.php のコメントの通り：正の値=タイトル別 / 0=総合 / -1=シリーズ別。

// GET /v1/ranking?game={slug|overall|series} — リーダーボード（read スコープのAPIキーも可）
function arenaHandleRanking(array $params, PDO $db): void {
    arenaActor($db, 'read');
    $gameParam = trim((string)($_GET['game'] ?? ($_GET['scope'] ?? 'overall')));

    if ($gameParam === '' || $gameParam === 'overall') {
        $gameId = 0;
        $gameMeta = ['slug' => 'overall', 'name' => '総合', 'icon' => '🏆'];
    } elseif ($gameParam === 'series') {
        $gameId = -1;
        $gameMeta = ['slug' => 'series', 'name' => 'シリーズ', 'icon' => '🎴'];
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

// GET /v1/players/{user_id} — 個人成績・レート一覧（read スコープのAPIキーも可）
// 直近シリーズの一覧はR2（結果申告・Elo反映）実装後に追加する。
function arenaHandlePlayer(array $params, PDO $db): void {
    arenaActor($db, 'read');
    $userId = (int)($params['id'] ?? 0);

    $stmt = $db->prepare('
        SELECT r.game_id, r.rating, r.wins, r.losses, r.streak, r.peak_rating,
               g.slug AS game_slug, g.name AS game_name, g.icon AS game_icon
        FROM arena_ratings r
        LEFT JOIN arena_games g ON g.id = r.game_id
        WHERE r.user_id = ?
        ORDER BY (r.game_id = 0) DESC, (r.game_id = -1) DESC, g.name
    ');
    $stmt->execute([$userId]);
    $ratings = array_map(function ($r) {
        $gid = (int)$r['game_id'];
        if ($gid === 0) {
            [$slug, $name, $icon] = ['overall', '総合', '🏆'];
        } elseif ($gid === -1) {
            [$slug, $name, $icon] = ['series', 'シリーズ', '🎴'];
        } else {
            [$slug, $name, $icon] = [$r['game_slug'], $r['game_name'], $r['game_icon']];
        }
        return [
            'game_id'     => $gid,
            'game_slug'   => $slug,
            'game_name'   => $name,
            'game_icon'   => $icon,
            'rating'      => round((float)$r['rating'], 1),
            'wins'        => (int)$r['wins'],
            'losses'      => (int)$r['losses'],
            'streak'      => (int)$r['streak'],
            'peak_rating' => round((float)$r['peak_rating'], 1),
        ];
    }, $stmt->fetchAll());

    jsonResponse(['success' => true, 'user_id' => $userId, 'ratings' => $ratings, 'recent_series' => []]);
}

// GET /v1/head-to-head?a={id}&b={id} — 対戦相手別の戦績（arena_series から集計、専用テーブルは持たない）。
// R2でシリーズ確定（arena_series.winner_side の反映）が実装されるまでは常に0件になる。
function arenaHandleHeadToHead(array $params, PDO $db): void {
    arenaActor($db, 'read');
    $a = (int)($_GET['a'] ?? 0);
    $b = (int)($_GET['b'] ?? 0);
    if ($a <= 0 || $b <= 0 || $a === $b) {
        jsonResponse(['success' => false, 'message' => 'a と b に異なるユーザーIDを指定してください'], 400);
    }

    $stmt = $db->prepare("
        SELECT public_id, winner_side, side_a_user_id, side_b_user_id, finished_at
        FROM arena_series
        WHERE status = 'finished'
          AND ((player1_id = ? AND player2_id = ?) OR (player1_id = ? AND player2_id = ?))
        ORDER BY finished_at DESC
    ");
    $stmt->execute([$a, $b, $b, $a]);
    $rows = $stmt->fetchAll();

    $aWins = 0;
    $bWins = 0;
    $series = [];
    foreach ($rows as $row) {
        $winnerId = null;
        if ($row['winner_side'] === 'A') {
            $winnerId = $row['side_a_user_id'] !== null ? (int)$row['side_a_user_id'] : null;
        } elseif ($row['winner_side'] === 'B') {
            $winnerId = $row['side_b_user_id'] !== null ? (int)$row['side_b_user_id'] : null;
        }
        if ($winnerId === $a) {
            $aWins++;
        } elseif ($winnerId === $b) {
            $bWins++;
        }
        $series[] = [
            'public_id'   => $row['public_id'],
            'winner_id'   => $winnerId,
            'finished_at' => $row['finished_at'] !== null ? (int)$row['finished_at'] : null,
        ];
    }

    jsonResponse([
        'success' => true,
        'a'       => $a,
        'b'       => $b,
        'a_wins'  => $aWins,
        'b_wins'  => $bWins,
        'total'   => count($rows),
        'series'  => $series,
    ]);
}
