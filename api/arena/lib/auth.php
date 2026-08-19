<?php
// Arena機能の認証・認可ヘルパー。
// arena.db は auth.db と JOIN できないため、resolveActor() は
// getDB()（api/common.php）で別ハンドルを開いて discord_users を引く。

// ログイン必須。$_SESSION から現在のユーザーを返す。未ログインなら 401。
function requireArenaUser(): array {
    if (!isset($_SESSION['user_id'])) {
        jsonResponse(['success' => false, 'message' => '認証が必要です'], 401);
    }
    return [
        'id'       => (int)$_SESSION['user_id'],
        'username' => (string)($_SESSION['username'] ?? ''),
    ];
}

// 指定ユーザーが arena_admins に登録済みか
function isArenaAdmin(PDO $db, int $userId): bool {
    $stmt = $db->prepare('SELECT 1 FROM arena_admins WHERE user_id = ?');
    $stmt->execute([$userId]);
    return (bool)$stmt->fetchColumn();
}

// 管理者必須。arena_admins が空なら、最初にこの関数を叩いたログインユーザーを
// 自動的に管理者登録する（ロリポップ ライトプランに SSH が無いための自己ブートストラップ）。
//
// ★重要：管理者権限は必ずセッション認証だけで判定する。API キー（Bearer認証）には
// write スコープを持っていても管理者権限を絶対に渡さない。requireArenaUser() は
// $_SESSION['user_id'] しか見ないため、Authorization ヘッダの有無に関わらず
// セッションが無ければここで 401 になる（= arenaActor() を経由させない）。
function requireArenaAdmin(PDO $db): array {
    $user = requireArenaUser();

    $count = (int)$db->query('SELECT COUNT(*) FROM arena_admins')->fetchColumn();
    if ($count === 0) {
        $stmt = $db->prepare('
            INSERT INTO arena_admins (user_id, username, granted_by, created_at)
            VALUES (?, ?, ?, ?)
        ');
        $stmt->execute([$user['id'], $user['username'], $user['id'], time()]);
        return $user;
    }

    if (!isArenaAdmin($db, $user['id'])) {
        jsonResponse(['success' => false, 'message' => '管理者権限が必要です'], 403);
    }
    return $user;
}

// 実行者を解決する。セッション優先、無ければ Bearer トークン（arena_api_keys）で
// Discord ボット等からの代理実行を許可する。解決できなければ null。
//
// 戻り値には 'auth_source'（'session'|'key'）と 'scopes'（key の場合のみ、
// カンマ区切りの scopes 列をトリム済み配列にしたもの。session の場合は null＝無制限）
// を含める。呼び出し側（arenaActor()）がここでスコープ判定を行う。
function resolveActor(PDO $db): ?array {
    if (isset($_SESSION['user_id'])) {
        return [
            'id'          => (int)$_SESSION['user_id'],
            'username'    => (string)($_SESSION['username'] ?? ''),
            'auth_source' => 'session',
            'scopes'      => null,
        ];
    }

    $header = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if (!preg_match('/^Bearer\s+(\S+)/i', $header, $m)) {
        return null;
    }
    $rawKey  = $m[1];
    $keyHash = hash('sha256', $rawKey);

    // revoked_at IS NULL がここで効くため、失効済みキーは常に「見つからなかった」扱い
    // ＝401（fail closed）。生鍵は決してログにも戻り値にも含めない。
    $stmt = $db->prepare('
        SELECT id, scopes FROM arena_api_keys
        WHERE key_hash = ? AND revoked_at IS NULL
    ');
    $stmt->execute([$keyHash]);
    $keyRow = $stmt->fetch();
    if (!$keyRow) {
        return null;
    }

    $db->prepare('UPDATE arena_api_keys SET last_used_at = ? WHERE id = ?')
       ->execute([time(), (int)$keyRow['id']]);

    $scopes = array_filter(array_map('trim', explode(',', (string)$keyRow['scopes'])));

    // 代理実行対象を X-Arena-Discord-Id ヘッダ or ボディの discord_id から解決
    $discordId = $_SERVER['HTTP_X_ARENA_DISCORD_ID'] ?? '';
    if ($discordId === '') {
        $body = json_decode(file_get_contents('php://input'), true);
        $discordId = is_array($body) ? (string)($body['discord_id'] ?? '') : '';
    }
    if ($discordId === '') {
        return null;
    }

    // users / discord_users は auth.db 側にあり、環境によっては未作成のことがあるため
    // PDOException を「見つからなかった」扱いにして握りつぶす（500 にしない）。
    try {
        $authDb = getDB();
        $stmt = $authDb->prepare('
            SELECT u.id AS id, u.username AS username
            FROM discord_users du
            JOIN users u ON u.id = du.user_id
            WHERE du.discord_id = ?
        ');
        $stmt->execute([$discordId]);
        $row = $stmt->fetch();
        if (!$row) {
            return null;
        }
        return [
            'id'          => (int)$row['id'],
            'username'    => (string)$row['username'],
            'auth_source' => 'key',
            'scopes'      => array_values($scopes),
        ];
    } catch (PDOException $e) {
        error_log('[arena] resolveActor discord lookup failed: ' . $e->getMessage());
        return null;
    }
}

// エンドポイントの入口で呼ぶ本体。セッションまたは有効なAPIキーで実行者を解決し、
// 解決できなければ401、キー認証でスコープ不足なら403で応答する（いずれもここで exit する）。
// セッション認証（ブラウザ）はスコープ制限を受けない＝Phase 1〜4の挙動と完全に同じ。
//
// $requiredScope は 'read' か 'write' を渡す。管理系エンドポイントには使わないこと
// （requireArenaAdmin() を使う。API キーは決して管理者権限を持たない）。
function arenaActor(PDO $db, string $requiredScope = 'read'): array {
    $actor = resolveActor($db);
    if ($actor === null) {
        jsonResponse(['success' => false, 'message' => '認証が必要です'], 401);
    }

    if ($actor['auth_source'] === 'key') {
        $scopes = $actor['scopes'] ?? [];
        if (!in_array($requiredScope, $scopes, true)) {
            jsonResponse(['success' => false, 'message' => 'このAPIキーにはこの操作を行う権限（スコープ）がありません'], 403);
        }
    }

    return ['id' => $actor['id'], 'username' => $actor['username']];
}
