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
        // 一覧なので series サマリは省略（series_id 自体は含まれる）
        return arenaSerializeMatch($db, $m, false);
    }, $matchStmt->fetchAll());

    jsonResponse(['success' => true, 'user_id' => $userId, 'ratings' => $ratings, 'recent_matches' => $recent]);
}

// GET /v1/head-to-head?a={id}&b={id} — 対戦相手別の戦績（arena_matches から集計、専用テーブルは持たない）。
// Phase 6: ゲーム別の内訳・連勝連敗（現在のストリーク）・直近試合ごとのBAN/PICK内訳を追加。
// 「直近試合一覧」は表示件数を絞るが、通算成績・ゲーム別内訳・ストリークは全履歴から計算する。
const ARENA_H2H_RECENT_LIMIT = 30;

function arenaHandleHeadToHead(array $params, PDO $db): void {
    arenaActor($db, 'read');
    $a = (int)($_GET['a'] ?? 0);
    $b = (int)($_GET['b'] ?? 0);
    if ($a <= 0 || $b <= 0 || $a === $b) {
        jsonResponse(['success' => false, 'message' => 'a と b に異なるユーザーIDを指定してください'], 400);
    }

    $stmt = $db->prepare("
        SELECT m.*, g.slug AS game_slug, g.name AS game_name, g.icon AS game_icon
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
    $perGame = []; // slug => ['game_slug','game_name','game_icon','a_wins','b_wins','total']
    // rows は finished_at 降順（最新が先頭）。streak は先頭から同じ勝者が続く間だけ
    // 数え、食い違った時点で確定する（＝現在の連勝/連敗）。
    $streakSide = null; // 'a' | 'b' | null（対戦履歴なし）
    $streakCount = 0;
    $streakDone = false;

    foreach ($rows as $row) {
        $aIsPlayerA = (int)$row['player_a_id'] === $a;
        $aWon = ($aIsPlayerA && $row['winner_side'] === 'A') || (!$aIsPlayerA && $row['winner_side'] === 'B');
        $side = $aWon ? 'a' : 'b';

        if ($aWon) {
            $aWins++;
        } else {
            $bWins++;
        }

        $gSlug = $row['game_slug'] ?? '?';
        if (!isset($perGame[$gSlug])) {
            $perGame[$gSlug] = [
                'game_slug' => $gSlug,
                'game_name' => $row['game_name'],
                'game_icon' => $row['game_icon'],
                'a_wins'    => 0,
                'b_wins'    => 0,
                'total'     => 0,
            ];
        }
        $perGame[$gSlug]['total']++;
        if ($aWon) {
            $perGame[$gSlug]['a_wins']++;
        } else {
            $perGame[$gSlug]['b_wins']++;
        }

        if (!$streakDone) {
            if ($streakSide === null) {
                $streakSide = $side;
                $streakCount = 1;
            } elseif ($side === $streakSide) {
                $streakCount++;
            } else {
                $streakDone = true;
            }
        }
    }

    // 直近試合（表示件数を絞る）のBAN/PICK内訳をグループ化SQLで1本にまとめて取得（N+1回避）
    $recentRows = array_slice($rows, 0, ARENA_H2H_RECENT_LIMIT);
    $actionsByMatch = [];
    if (!empty($recentRows)) {
        $matchIds = array_map(function ($r) {
            return (int)$r['id'];
        }, $recentRows);
        $placeholders = implode(',', array_fill(0, count($matchIds), '?'));
        $actStmt = $db->prepare("
            SELECT a.match_id, a.seq, a.action, a.side, a.entry_id, e.slug AS entry_slug, e.name AS entry_name
            FROM arena_actions a
            LEFT JOIN arena_entries e ON e.id = a.entry_id
            WHERE a.match_id IN ($placeholders) AND a.entry_id IS NOT NULL
            ORDER BY a.match_id, a.seq
        ");
        $actStmt->execute($matchIds);
        foreach ($actStmt->fetchAll() as $r) {
            $actionsByMatch[(int)$r['match_id']][] = $r;
        }
    }

    $matches = [];
    foreach ($recentRows as $row) {
        $aIsPlayerA = (int)$row['player_a_id'] === $a;
        $aWon = ($aIsPlayerA && $row['winner_side'] === 'A') || (!$aIsPlayerA && $row['winner_side'] === 'B');

        $picksA = [];
        $picksB = [];
        $bans = [];
        foreach ($actionsByMatch[(int)$row['id']] ?? [] as $act) {
            $entry = ['entry_id' => (int)$act['entry_id'], 'slug' => $act['entry_slug'], 'name' => $act['entry_name']];
            if ($act['action'] === 'ban') {
                $bans[] = $entry;
            } elseif ($act['side'] === 'A') {
                $picksA[] = $entry;
            } else {
                $picksB[] = $entry;
            }
        }
        // player_a/player_b（試合内の実際のサイド）を a/b 引数の視点に並べ替える
        $aPicks = $aIsPlayerA ? $picksA : $picksB;
        $bPicks = $aIsPlayerA ? $picksB : $picksA;

        $matches[] = [
            'public_id'   => $row['public_id'],
            'mode'        => $row['mode'],
            'game_slug'   => $row['game_slug'],
            'game_name'   => $row['game_name'],
            'game_icon'   => $row['game_icon'],
            'winner_side' => $row['winner_side'],
            'a_won'       => $aWon,
            'score_a'     => (int)$row['score_a'],
            'score_b'     => (int)$row['score_b'],
            'finished_at' => $row['finished_at'] !== null ? (int)$row['finished_at'] : null,
            'series_id'   => $row['series_id'],
            'a_picks'     => $aPicks,
            'b_picks'     => $bPicks,
            'bans'        => $bans,
        ];
    }

    jsonResponse([
        'success'  => true,
        'a'        => $a,
        'b'        => $b,
        'a_wins'   => $aWins,
        'b_wins'   => $bWins,
        'total'    => count($rows),
        'streak'   => ['side' => $streakSide, 'count' => $streakCount],
        'per_game' => array_values($perGame),
        'matches'  => $matches,
    ]);
}
