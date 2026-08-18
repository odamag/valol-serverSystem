<?php
// Phase 1: 読み取り系ハンドラ（/v1/users, /v1/games, /v1/games/{slug}/entries, /v1/me）

// GET /v1/users — 対戦相手を選ぶためのユーザー一覧（ログイン必須）
function arenaHandleUsers(array $params, PDO $db): void {
    $user = requireArenaUser();

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
function arenaHandleGames(array $params, PDO $db): void {
    $playableWith = isset($_GET['playable_with']) ? (int)$_GET['playable_with'] : null;
    $viewerId     = null;
    if ($playableWith !== null) {
        $user     = requireArenaUser();
        $viewerId = $user['id'];
    }

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
function arenaHandleGameEntries(array $params, PDO $db): void {
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

// GET /v1/me — 現在のユーザー + is_admin（フロントで管理者リンクの表示可否に使う）
function arenaHandleMe(array $params, PDO $db): void {
    $user = requireArenaUser();
    jsonResponse([
        'success'  => true,
        'id'       => $user['id'],
        'username' => $user['username'],
        'is_admin' => isArenaAdmin($db, $user['id']),
    ]);
}
