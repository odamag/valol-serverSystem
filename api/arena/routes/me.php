<?php
// Phase 2: 所持ゲーム（arena_user_games）関連ハンドラ。

// GET /v1/me/games — 自分の所持ゲーム一覧
function arenaHandleMeGamesGet(array $params, PDO $db): void {
    $user = requireArenaUser();

    $stmt = $db->prepare('
        SELECT g.id, g.slug, g.name, g.entry_label, g.icon
        FROM arena_user_games ug
        JOIN arena_games g ON g.id = ug.game_id
        WHERE ug.user_id = ?
        ORDER BY g.sort_order, g.name
    ');
    $stmt->execute([$user['id']]);
    $games = array_map(function ($g) {
        return [
            'id'          => (int)$g['id'],
            'slug'        => $g['slug'],
            'name'        => $g['name'],
            'entry_label' => $g['entry_label'],
            'icon'        => $g['icon'],
        ];
    }, $stmt->fetchAll());

    jsonResponse(['success' => true, 'games' => $games]);
}

// PUT /v1/me/games — 所持ゲームを {slugs:[...]} で一括置換する（削除→挿入をトランザクションで実行）
// 存在しないスラッグはエラーにせず無視する
function arenaHandleMeGamesPut(array $params, PDO $db): void {
    $user = requireArenaUser();

    $raw  = file_get_contents('php://input');
    $body = json_decode($raw, true);
    if (!is_array($body) || !isset($body['slugs']) || !is_array($body['slugs'])) {
        jsonResponse(['success' => false, 'message' => '{"slugs":[...]} の形式で指定してください'], 400);
    }

    $slugs = array_values(array_unique(array_map('strval', $body['slugs'])));

    $db->beginTransaction();
    try {
        $db->prepare('DELETE FROM arena_user_games WHERE user_id = ?')->execute([$user['id']]);

        if (!empty($slugs)) {
            $placeholders = implode(',', array_fill(0, count($slugs), '?'));
            $idStmt = $db->prepare("SELECT id FROM arena_games WHERE enabled = 1 AND slug IN ($placeholders)");
            $idStmt->execute($slugs);
            $gameIds = array_map(function ($r) {
                return (int)$r['id'];
            }, $idStmt->fetchAll());

            $insertStmt = $db->prepare('INSERT INTO arena_user_games (user_id, game_id, created_at) VALUES (?, ?, ?)');
            $now = time();
            foreach ($gameIds as $gameId) {
                $insertStmt->execute([$user['id'], $gameId, $now]);
            }
        }

        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        throw $e;
    }

    arenaHandleMeGamesGet($params, $db);
}
