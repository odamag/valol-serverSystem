<?php
// 読み取り系ハンドラ（/v1/users, /v1/games, /v1/formats, /v1/me）。
// セクション12の再設計により、ゲームは「タイトルそのもの」になったため
// entries/rulesets（旧 /v1/games/{slug}/entries, /v1/games/{slug}/stats）は廃止。

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

// arena_games の1行をクライアント向けにシリアライズする（タイトルそのもの。エントリー概念なし）
function arenaSerializeGameRow(array $g): array {
    return [
        'id'         => (int)$g['id'],
        'slug'       => $g['slug'],
        'name'       => $g['name'],
        'icon'       => $g['icon'],
        'sort_order' => (int)$g['sort_order'],
    ];
}

// GET /v1/games — 有効なゲームタイトル一覧。
// ?playable_with={user_id} で、自分と指定相手の両方が所持しているタイトルだけに絞る
// （シリーズ作成画面でのプール候補確認用）。read スコープのAPIキーも利用可。
function arenaHandleGames(array $params, PDO $db): void {
    $actor        = arenaActor($db, 'read');
    $playableWith = isset($_GET['playable_with']) ? (int)$_GET['playable_with'] : null;

    $sql = 'SELECT * FROM arena_games WHERE enabled = 1';
    $args = [];
    if ($playableWith !== null) {
        $sql .= '
            AND id IN (SELECT game_id FROM arena_user_games WHERE user_id = ?)
            AND id IN (SELECT game_id FROM arena_user_games WHERE user_id = ?)
        ';
        $args[] = $actor['id'];
        $args[] = $playableWith;
    }
    $sql .= ' ORDER BY sort_order, name';

    $stmt = $db->prepare($sql);
    $stmt->execute($args);
    $games = array_map('arenaSerializeGameRow', $stmt->fetchAll());

    jsonResponse(['success' => true, 'games' => $games]);
}

// GET /v1/formats — 有効なタイトルドラフト書式の一覧（read スコープのAPIキーも可）
function arenaHandleFormats(array $params, PDO $db): void {
    arenaActor($db, 'read');
    $stmt = $db->query('SELECT * FROM arena_formats WHERE enabled = 1 ORDER BY is_default DESC, name');
    $formats = array_map('arenaSerializeFormatRow', $stmt->fetchAll());
    jsonResponse(['success' => true, 'formats' => $formats]);
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
