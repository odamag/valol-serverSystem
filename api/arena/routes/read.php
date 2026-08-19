<?php
// Phase 1: 読み取り系ハンドラ（/v1/users, /v1/games, /v1/games/{slug}/entries, /v1/me）

// GET /v1/users — 対戦相手を選ぶためのユーザー一覧（ログイン必須。read スコープのAPIキーも可）
function arenaHandleUsers(array $params, PDO $db): void {
    $user = arenaActor($db, 'read');

    try {
        $authDb = getDB();
        $stmt = $authDb->prepare('SELECT id, username FROM users WHERE id != ? ORDER BY username');
        $stmt->execute([$user['id']]);
        $rows = $stmt->fetchAll();
    } catch (PDOException $e) {
        // users テーブルが未作成の環境でも 500 にせず空配列を返す
        error_log('[arena] /v1/users lookup failed: ' . $e->getMessage());
        $rows = [];
    }

    $users = array_map(function ($row) {
        return ['id' => (int)$row['id'], 'username' => (string)$row['username']];
    }, $rows);

    jsonResponse(['success' => true, 'users' => $users]);
}

// GET /v1/games — 有効なゲーム一覧（+各ゲームの有効なルールセット）
// ?playable_with={user_id} で、自分と指定相手の両方が所持しているゲームだけに絞る
// read スコープのAPIキーも利用可（Discordボットが対戦候補ゲームを問い合わせる用途）
function arenaHandleGames(array $params, PDO $db): void {
    $actor        = arenaActor($db, 'read');
    $playableWith = isset($_GET['playable_with']) ? (int)$_GET['playable_with'] : null;
    $viewerId     = $playableWith !== null ? $actor['id'] : null;

    $sql = 'SELECT * FROM arena_games WHERE enabled = 1';
    $args = [];
    if ($playableWith !== null) {
        $sql .= '
            AND id IN (SELECT game_id FROM arena_user_games WHERE user_id = ?)
            AND id IN (SELECT game_id FROM arena_user_games WHERE user_id = ?)
        ';
        $args[] = $viewerId;
        $args[] = $playableWith;
    }
    $sql .= ' ORDER BY sort_order, name';

    $stmt = $db->prepare($sql);
    $stmt->execute($args);
    $games = $stmt->fetchAll();

    $rulesetStmt = $db->prepare('
        SELECT id, slug, name, sequence, turn_seconds, mirror_allowed, fearless, is_default
        FROM arena_rulesets
        WHERE game_id = ? AND enabled = 1
        ORDER BY is_default DESC, name
    ');

    $result = [];
    foreach ($games as $game) {
        $rulesetStmt->execute([(int)$game['id']]);
        $rulesets = array_map(function ($r) {
            return [
                'id'             => (int)$r['id'],
                'slug'           => $r['slug'],
                'name'           => $r['name'],
                'sequence'       => json_decode($r['sequence'], true) ?: [],
                'turn_seconds'   => (int)$r['turn_seconds'],
                'mirror_allowed' => (bool)$r['mirror_allowed'],
                'fearless'       => (bool)$r['fearless'],
                'is_default'     => (bool)$r['is_default'],
            ];
        }, $rulesetStmt->fetchAll());

        $result[] = [
            'id'           => (int)$game['id'],
            'slug'         => $game['slug'],
            'name'         => $game['name'],
            'entry_label'  => $game['entry_label'],
            'icon'         => $game['icon'],
            'sort_order'   => (int)$game['sort_order'],
            'entry_source' => $game['entry_source'],
            'rulesets'     => $rulesets,
        ];
    }

    jsonResponse(['success' => true, 'games' => $result]);
}

// GET /v1/games/{slug}/entries — 有効なエントリー一覧。ETag で 304 対応
// read スコープのAPIキーも利用可
function arenaHandleGameEntries(array $params, PDO $db): void {
    arenaActor($db, 'read');
    $slug = $params['slug'] ?? '';

    $stmt = $db->prepare('SELECT id FROM arena_games WHERE slug = ? AND enabled = 1');
    $stmt->execute([$slug]);
    $game = $stmt->fetch();
    if (!$game) {
        jsonResponse(['success' => false, 'message' => 'ゲームが見つかりません'], 404);
    }
    $gameId = (int)$game['id'];

    $metaStmt = $db->prepare('
        SELECT COALESCE(MAX(updated_at), 0) AS max_updated, COUNT(*) AS cnt
        FROM arena_entries WHERE game_id = ? AND enabled = 1
    ');
    $metaStmt->execute([$gameId]);
    $meta = $metaStmt->fetch();
    $etag = 'W/"' . sha1($gameId . ':' . $meta['max_updated'] . ':' . $meta['cnt']) . '"';

    $ifNoneMatch = $_SERVER['HTTP_IF_NONE_MATCH'] ?? '';
    header('ETag: ' . $etag);
    if ($ifNoneMatch !== '' && $ifNoneMatch === $etag) {
        http_response_code(304);
        exit;
    }

    $entryStmt = $db->prepare('
        SELECT id, slug, name, image_url, tags
        FROM arena_entries
        WHERE game_id = ? AND enabled = 1
        ORDER BY name
    ');
    $entryStmt->execute([$gameId]);
    $entries = array_map(function ($e) {
        return [
            'id'        => (int)$e['id'],
            'slug'      => $e['slug'],
            'name'      => $e['name'],
            'image_url' => $e['image_url'],
            'tags'      => $e['tags'],
        ];
    }, $entryStmt->fetchAll());

    jsonResponse(['success' => true, 'entries' => $entries]);
}

// GET /v1/games/{slug}/stats — ゲーム内エントリーごとのピック/バン数・勝率統計（Phase 6）。
// ?user_id= を指定すると、「そのユーザーの側（A/B）で行われた」PICK/BANだけに絞り込む
// （＝そのプレイヤーの得意/よく使うエントリーを見る用途）。
//
// 絞り込みは actor_id（実際にボタンを押した人）ではなく side→player_a_id/player_b_id の
// 対応で行う。理由：ローカルモードでは作成者が両側を操作するため、actor_id で絞ると
// 「相手の側のPICK」まで作成者自身の記録として数えてしまう。また、タイムアウトによる
// 自動選択は actor_id が NULL になるため、actor_id基準だと自動選択されたPICKがその
// プレイヤーの記録から漏れてしまう（＝自動選択で勝った試合の勝率が反映されない）。
// side基準ならローカル/オンライン・手動/自動のいずれでも「その試合のその選手の持ち球」
// として一貫して数えられる。
// N+1 を避けるため、エントリーごとの集計は1本のグループ化SQLで行う。
function arenaHandleGameStats(array $params, PDO $db): void {
    arenaActor($db, 'read');
    $slug = $params['slug'] ?? '';

    $game = arenaFindGameBySlug($db, $slug);
    if (!$game) {
        jsonResponse(['success' => false, 'message' => 'ゲームが見つかりません'], 404);
    }
    $gameId = (int)$game['id'];

    $userId = null;
    if (isset($_GET['user_id']) && $_GET['user_id'] !== '') {
        if (!is_numeric($_GET['user_id'])) {
            jsonResponse(['success' => false, 'message' => 'user_id は数値で指定してください'], 400);
        }
        $userId = (int)$_GET['user_id'];
    }

    // ピック率・バン率の母数：このゲームで実際にドラフトが行われた試合数
    // （waiting=相手待ちのみ・cancelled=中止 はドラフトが成立していないため除外）
    $totalSql = "
        SELECT COUNT(*) FROM arena_matches
        WHERE game_id = ? AND status IN ('drafting', 'playing', 'reported', 'finished')
    ";
    $totalArgs = [$gameId];
    if ($userId !== null) {
        $totalSql .= ' AND (player_a_id = ? OR player_b_id = ?)';
        $totalArgs[] = $userId;
        $totalArgs[] = $userId;
    }
    $totalStmt = $db->prepare($totalSql);
    $totalStmt->execute($totalArgs);
    $totalMatches = (int)$totalStmt->fetchColumn();

    // エントリーごとのピック数・バン数・（確定試合のみの）勝敗数を1本のSQLで集計する。
    // action='ban' の行には side はあるが勝敗と無関係なので wins/losses の対象から外す。
    $statsSql = "
        SELECT
            e.id AS entry_id, e.slug AS entry_slug, e.name AS entry_name, e.image_url AS entry_image_url,
            SUM(CASE WHEN a.action = 'pick' THEN 1 ELSE 0 END) AS picks,
            SUM(CASE WHEN a.action = 'ban' THEN 1 ELSE 0 END) AS bans,
            SUM(CASE WHEN a.action = 'pick' AND m.status = 'finished' AND a.side = m.winner_side THEN 1 ELSE 0 END) AS wins,
            SUM(CASE WHEN a.action = 'pick' AND m.status = 'finished' AND a.side != m.winner_side THEN 1 ELSE 0 END) AS losses
        FROM arena_actions a
        JOIN arena_matches m ON m.id = a.match_id
        JOIN arena_entries e ON e.id = a.entry_id
        WHERE m.game_id = ?
    ";
    $statsArgs = [$gameId];
    if ($userId !== null) {
        // 「そのユーザーの側で行われたPICK/BAN」に絞る（上のコメント参照）。
        // タイムアウト自動選択（actor_id=NULL）もここでは除外されない＝正しくその
        // プレイヤーの記録として数える。
        $statsSql .= " AND ((a.side = 'A' AND m.player_a_id = ?) OR (a.side = 'B' AND m.player_b_id = ?))";
        $statsArgs[] = $userId;
        $statsArgs[] = $userId;
    }
    $statsSql .= ' GROUP BY e.id, e.slug, e.name, e.image_url ORDER BY picks DESC, bans DESC, e.name';

    $statsStmt = $db->prepare($statsSql);
    $statsStmt->execute($statsArgs);

    $stats = array_map(function ($r) use ($totalMatches) {
        $picks = (int)$r['picks'];
        $bans = (int)$r['bans'];
        $wins = (int)$r['wins'];
        $losses = (int)$r['losses'];
        $matchesCounted = $wins + $losses; // 勝率の分母（未確定試合を除いた実数）
        return [
            'entry_id'        => (int)$r['entry_id'],
            'entry_slug'      => $r['entry_slug'],
            'entry_name'      => $r['entry_name'],
            'entry_image_url' => $r['entry_image_url'],
            'picks'           => $picks,
            'bans'            => $bans,
            'wins'            => $wins,
            'losses'          => $losses,
            'matches_counted' => $matchesCounted,
            'pick_rate'       => $totalMatches > 0 ? round($picks / $totalMatches, 4) : null,
            'ban_rate'        => $totalMatches > 0 ? round($bans / $totalMatches, 4) : null,
            'win_rate'        => $matchesCounted > 0 ? round($wins / $matchesCounted, 4) : null,
        ];
    }, $statsStmt->fetchAll());

    jsonResponse([
        'success'       => true,
        'game'          => [
            'slug'        => $game['slug'],
            'name'        => $game['name'],
            'entry_label' => $game['entry_label'],
            'icon'        => $game['icon'],
        ],
        'user_id'       => $userId,
        'total_matches' => $totalMatches,
        'stats'         => $stats,
    ]);
}

// GET /v1/me — 現在のユーザー + is_admin（フロントで管理者リンクの表示可否に使う）
//
// admin_bootstrap_available: arena_admins がまだ空かどうか。
// ロリポップ ライトプランには SSH が無く CLI を叩けないため、最初の管理者は
// Web 画面から登録できなければならない。このフラグが true のときはフロント側も
// 管理画面を開けるようにし、そこで管理APIを叩いた時点で
// requireArenaAdmin() が本人を最初の管理者として登録する。
//
// read スコープのAPIキー + X-Arena-Discord-Id でも呼べる。Discordボットが
// 自分の discord_id が正しく users にマッピングされているかを確認する用途
// （is_admin はあくまで解決先ユーザーの情報であり、APIキー自体に管理者権限を渡すものではない）。
function arenaHandleMe(array $params, PDO $db): void {
    $user = arenaActor($db, 'read');
    $adminCount = (int)$db->query('SELECT COUNT(*) FROM arena_admins')->fetchColumn();
    jsonResponse([
        'success'                   => true,
        'id'                        => $user['id'],
        'username'                  => $user['username'],
        'is_admin'                  => isArenaAdmin($db, $user['id']),
        'admin_bootstrap_available' => $adminCount === 0,
    ]);
}
