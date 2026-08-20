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

    $season = arenaCurrentSeason($db);

    $stmt = $db->prepare('
        SELECT user_id, username, rating, wins, losses, streak, peak_rating,
               season_games, placement_done, updated_at
        FROM arena_ratings
        WHERE game_id = ?
    ');
    $stmt->execute([$gameId]);

    // 並び順は「表示ランク」で決める。配置期間中は内部レートより低く抑えられるため、
    // 数戦だけ勝ったプレイヤーが上位に来ない。
    $rows = array_map(function ($r) use ($season) {
        $d = arenaDecorateRatingRow($r, $season);
        return array_merge([
            'user_id'     => (int)$r['user_id'],
            'username'    => $r['username'],
            'wins'        => (int)$r['wins'],
            'losses'      => (int)$r['losses'],
            'streak'      => (int)$r['streak'],
            'peak_rating' => round((float)$r['peak_rating'], 1),
        ], $d);
    }, $stmt->fetchAll());

    usort($rows, function ($x, $y) {
        if ($x['display_rating'] === $y['display_rating']) {
            return $y['wins'] - $x['wins'];
        }
        return $y['display_rating'] <=> $x['display_rating'];
    });
    $rows = array_slice($rows, 0, 100);
    foreach ($rows as $i => $_) {
        $rows[$i]['rank'] = $i + 1;
    }

    jsonResponse([
        'success' => true,
        'game'    => $gameMeta,
        'season'  => arenaSerializeSeason($season),
        'ranking' => $rows,
    ]);
}

// GET /v1/players/{user_id} — 個人成績・レート一覧（read スコープのAPIキーも可）
// 直近シリーズの一覧はR2（結果申告・Elo反映）実装後に追加する。
function arenaHandlePlayer(array $params, PDO $db): void {
    arenaActor($db, 'read');
    $userId = (int)($params['id'] ?? 0);

    $stmt = $db->prepare('
        SELECT r.game_id, r.rating, r.wins, r.losses, r.streak, r.peak_rating,
               r.season_games, r.placement_done,
               g.slug AS game_slug, g.name AS game_name, g.icon AS game_icon
        FROM arena_ratings r
        LEFT JOIN arena_games g ON g.id = r.game_id
        WHERE r.user_id = ?
        ORDER BY (r.game_id = 0) DESC, (r.game_id = -1) DESC, g.name
    ');
    $stmt->execute([$userId]);
    $season = arenaCurrentSeason($db);
    $ratings = array_map(function ($r) use ($season) {
        $gid = (int)$r['game_id'];
        if ($gid === 0) {
            [$slug, $name, $icon] = ['overall', '総合', '🏆'];
        } elseif ($gid === -1) {
            [$slug, $name, $icon] = ['series', 'シリーズ', '🎴'];
        } else {
            [$slug, $name, $icon] = [$r['game_slug'], $r['game_name'], $r['game_icon']];
        }
        return array_merge([
            'game_id'     => $gid,
            'game_slug'   => $slug,
            'game_name'   => $name,
            'game_icon'   => $icon,
            'wins'        => (int)$r['wins'],
            'losses'      => (int)$r['losses'],
            'streak'      => (int)$r['streak'],
            'peak_rating' => round((float)$r['peak_rating'], 1),
        ], arenaDecorateRatingRow($r, $season));
    }, $stmt->fetchAll());

    jsonResponse([
        'success'  => true,
        'user_id'  => $userId,
        'season'   => arenaSerializeSeason($season),
        'ratings'  => $ratings,
        'recent_series' => [],
    ]);
}

// GET /v1/head-to-head?a={id}&b={id} — 対戦相手別の戦績。
// 専用テーブルは持たず arena_series / arena_series_games から集計する。
function arenaHandleHeadToHead(array $params, PDO $db): void {
    arenaActor($db, 'read');
    $a = (int)($_GET['a'] ?? 0);
    $b = (int)($_GET['b'] ?? 0);
    if ($a <= 0 || $b <= 0 || $a === $b) {
        jsonResponse(['success' => false, 'message' => 'a と b に異なるユーザーIDを指定してください'], 400);
    }

    $stmt = $db->prepare("
        SELECT id, public_id, winner_side, side_a_user_id, side_b_user_id, wins_a, wins_b, finished_at
        FROM arena_series
        WHERE status = 'finished'
          AND ((player1_id = ? AND player2_id = ?) OR (player1_id = ? AND player2_id = ?))
        ORDER BY finished_at DESC
        LIMIT 30
    ");
    $stmt->execute([$a, $b, $b, $a]);
    $rows = $stmt->fetchAll();

    // 各シリーズの試合内訳を1クエリでまとめて引く（N+1を避ける）
    $byId = [];
    if ($rows) {
        $ids = array_map(function ($r) { return (int)$r['id']; }, $rows);
        $in  = implode(',', array_fill(0, count($ids), '?'));
        $gStmt = $db->prepare("
            SELECT sg.series_id, sg.game_no, sg.game_id, sg.is_decider, sg.picked_by, sg.winner_side,
                   g.slug AS game_slug, g.name AS game_name, g.icon AS game_icon
            FROM arena_series_games sg
            JOIN arena_games g ON g.id = sg.game_id
            WHERE sg.series_id IN ($in)
            ORDER BY sg.series_id, sg.game_no
        ");
        $gStmt->execute($ids);
        foreach ($gStmt->fetchAll() as $g) {
            $byId[(int)$g['series_id']][] = $g;
        }
    }

    // シリーズ側から見た勝敗と、タイトル別の勝敗を同時に積む
    $aWins = 0;
    $bWins = 0;
    $perTitle = [];   // slug => [name, icon, a_wins, b_wins]
    $streak   = ['side' => null, 'count' => 0];
    $series   = [];

    foreach ($rows as $row) {
        $sid   = (int)$row['id'];
        $sideA = $row['side_a_user_id'] !== null ? (int)$row['side_a_user_id'] : null;
        $winnerId = null;
        if ($row['winner_side'] === 'A') {
            $winnerId = $sideA;
        } elseif ($row['winner_side'] === 'B') {
            $winnerId = $row['side_b_user_id'] !== null ? (int)$row['side_b_user_id'] : null;
        }
        if ($winnerId === $a) {
            $aWins++;
        } elseif ($winnerId === $b) {
            $bWins++;
        }

        // 直近から数えた連勝（最初に見た勝者が途切れるまで）
        if ($streak['side'] === null && $winnerId !== null) {
            $streak['side']  = $winnerId === $a ? 'a' : 'b';
            $streak['count'] = 1;
        } elseif ($streak['count'] > 0 && $winnerId !== null) {
            $cur = $winnerId === $a ? 'a' : 'b';
            if ($cur === $streak['side'] && $streak['count'] === count($series)) {
                $streak['count']++;
            }
        }

        $games = [];
        foreach (($byId[$sid] ?? []) as $g) {
            $gWinnerId = null;
            if ($g['winner_side'] === 'A') {
                $gWinnerId = $sideA;
            } elseif ($g['winner_side'] === 'B') {
                $gWinnerId = $row['side_b_user_id'] !== null ? (int)$row['side_b_user_id'] : null;
            }
            if ($gWinnerId !== null) {
                $slug = $g['game_slug'];
                if (!isset($perTitle[$slug])) {
                    $perTitle[$slug] = [
                        'game_slug' => $slug, 'game_name' => $g['game_name'], 'game_icon' => $g['game_icon'],
                        'a_wins' => 0, 'b_wins' => 0, 'total' => 0,
                    ];
                }
                $perTitle[$slug][$gWinnerId === $a ? 'a_wins' : 'b_wins']++;
                $perTitle[$slug]['total']++;
            }
            $games[] = [
                'game_no'    => (int)$g['game_no'],
                'game_slug'  => $g['game_slug'],
                'game_name'  => $g['game_name'],
                'game_icon'  => $g['game_icon'],
                'is_decider' => (bool)$g['is_decider'],
                'picked_by'  => $g['picked_by'],
                'winner_id'  => $gWinnerId,
            ];
        }

        $series[] = [
            'public_id'   => $row['public_id'],
            'winner_id'   => $winnerId,
            'wins_a'      => (int)$row['wins_a'],
            'wins_b'      => (int)$row['wins_b'],
            'side_a_user_id' => $sideA,
            'finished_at' => $row['finished_at'] !== null ? (int)$row['finished_at'] : null,
            'games'       => $games,
        ];
    }

    $perTitleList = array_values($perTitle);
    usort($perTitleList, function ($x, $y) { return $y['total'] - $x['total']; });

    jsonResponse([
        'success'   => true,
        'a'         => $a,
        'b'         => $b,
        'a_wins'    => $aWins,
        'b_wins'    => $bWins,
        'total'     => count($rows),
        'streak'    => $streak,
        'per_title' => $perTitleList,
        'series'    => $series,
    ]);
}

// GET /v1/title-stats[?user_id=] — タイトル別のBAN率 / PICK率 / 勝率。
// ?user_id= は「どちらの陣営だったか」で絞る（actor_id ではない）。
// ローカルモードでは作成者が両側を操作し、タイムアウト自動選択は actor_id が NULL に
// なるため、actor_id で絞ると数字がずれる。
function arenaHandleTitleStats(array $params, PDO $db): void {
    arenaActor($db, 'read');
    $userId = isset($_GET['user_id']) ? (int)$_GET['user_id'] : null;

    // 母数：ドラフトが完了したシリーズ数
    $totalStmt = $db->prepare("
        SELECT COUNT(*) FROM arena_series
        WHERE status IN ('playing','finished')
          AND (? IS NULL OR side_a_user_id = ? OR side_b_user_id = ?)
    ");
    $totalStmt->execute([$userId, $userId, $userId]);
    $totalSeries = (int)$totalStmt->fetchColumn();

    // BAN/PICK/Decider の回数（arena_series_actions を陣営で絞る）
    $actStmt = $db->prepare("
        SELECT a.game_id, a.action, COUNT(*) AS c
        FROM arena_series_actions a
        JOIN arena_series s ON s.id = a.series_id
        WHERE s.status IN ('playing','finished')
          AND (
                ? IS NULL
             OR (a.side = 'A' AND s.side_a_user_id = ?)
             OR (a.side = 'B' AND s.side_b_user_id = ?)
          )
        GROUP BY a.game_id, a.action
    ");
    $actStmt->execute([$userId, $userId, $userId]);

    $acc = [];
    $touch = function (&$acc, $gid) {
        if (!isset($acc[$gid])) {
            $acc[$gid] = ['bans' => 0, 'picks' => 0, 'deciders' => 0, 'wins' => 0, 'losses' => 0];
        }
    };
    foreach ($actStmt->fetchAll() as $r) {
        $gid = (int)$r['game_id'];
        $touch($acc, $gid);
        if ($r['action'] === 'ban') {
            $acc[$gid]['bans'] += (int)$r['c'];
        } elseif ($r['action'] === 'pick') {
            $acc[$gid]['picks'] += (int)$r['c'];
        } else {
            $acc[$gid]['deciders'] += (int)$r['c'];
        }
    }

    // 実施された試合の勝敗（陣営でスコープ）
    $winStmt = $db->prepare("
        SELECT sg.game_id,
               SUM(CASE WHEN (? IS NULL AND sg.winner_side IS NOT NULL)
                          OR (sg.winner_side = 'A' AND s.side_a_user_id = ?)
                          OR (sg.winner_side = 'B' AND s.side_b_user_id = ?)
                        THEN 1 ELSE 0 END) AS wins,
               COUNT(*) AS played
        FROM arena_series_games sg
        JOIN arena_series s ON s.id = sg.series_id
        WHERE sg.winner_side IS NOT NULL
          AND (? IS NULL OR s.side_a_user_id = ? OR s.side_b_user_id = ?)
        GROUP BY sg.game_id
    ");
    $winStmt->execute([$userId, $userId, $userId, $userId, $userId, $userId]);
    foreach ($winStmt->fetchAll() as $r) {
        $gid = (int)$r['game_id'];
        $touch($acc, $gid);
        $played = (int)$r['played'];
        $wins   = (int)$r['wins'];
        // user_id 指定なしのときは「Aの勝ち数」を wins として扱わず、played のみ意味を持たせる
        $acc[$gid]['wins']   = $userId === null ? 0 : $wins;
        $acc[$gid]['losses'] = $userId === null ? 0 : $played - $wins;
        $acc[$gid]['played'] = $played;
    }

    $gameStmt = $db->query('SELECT id, slug, name, icon FROM arena_games ORDER BY sort_order, name');
    $stats = [];
    foreach ($gameStmt->fetchAll() as $g) {
        $gid = (int)$g['id'];
        if (!isset($acc[$gid])) {
            continue;
        }
        $row    = $acc[$gid];
        $played = $row['played'] ?? 0;
        $decided = $row['wins'] + $row['losses'];
        $stats[] = [
            'game_id'   => $gid,
            'game_slug' => $g['slug'],
            'game_name' => $g['name'],
            'game_icon' => $g['icon'],
            'bans'      => $row['bans'],
            'picks'     => $row['picks'],
            'deciders'  => $row['deciders'],
            'played'    => $played,
            'wins'      => $row['wins'],
            'losses'    => $row['losses'],
            'ban_rate'  => $totalSeries > 0 ? round($row['bans'] / $totalSeries, 3) : 0,
            'pick_rate' => $totalSeries > 0 ? round($row['picks'] / $totalSeries, 3) : 0,
            'win_rate'  => $decided > 0 ? round($row['wins'] / $decided, 3) : null,
        ];
    }
    usort($stats, function ($x, $y) { return ($y['picks'] + $y['bans']) - ($x['picks'] + $x['bans']); });

    jsonResponse([
        'success'       => true,
        'user_id'       => $userId,
        'total_series'  => $totalSeries,
        'stats'         => $stats,
    ]);
}
