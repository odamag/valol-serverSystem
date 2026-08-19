<?php
// 管理者専用ハンドラ（ゲームマスタ / タイトルドラフト書式の管理。所持ゲームとは別枠）。
// すべてのハンドラは冒頭で requireArenaAdmin($db) を呼ぶ。
// ここから作成・更新される行はすべて source='user' とし、created_by/updated_by/updated_at を残す。
//
// セクション12の再設計により、エントリー/ルールセット（キャラクター単位のCRUD）は廃止し、
// 代わりにタイトルドラフト書式（arena_formats）のCRUDを置く。ゲームのCRUDは
// entry_label/entry_source が無くなった以外はそのまま踏襲する。

// ── 共通ヘルパー ─────────────────────────────────────────────────

// リクエストボディを JSON として読む。JSON でなければ 400。
function arenaReadJsonBody(): array {
    $raw = file_get_contents('php://input');
    if ($raw === false || trim($raw) === '') {
        return [];
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        jsonResponse(['success' => false, 'message' => 'リクエストの形式が正しくありません（JSON を送ってください）'], 400);
    }
    return $data;
}

// $body に $allowed 以外のキーが含まれていないか確認する（想定外のフィールドは無視せず拒否）
function arenaCheckAllowedFields(array $body, array $allowed): ?string {
    $unknown = array_diff(array_keys($body), $allowed);
    if (!empty($unknown)) {
        return '不明なフィールドが含まれています: ' . implode(', ', $unknown);
    }
    return null;
}

function arenaValidateSlug(string $slug): ?string {
    if (!preg_match('/^[a-z0-9_-]{1,40}$/', $slug)) {
        return 'スラッグは半角英数字・ハイフン・アンダースコアのみ、1〜40文字で指定してください';
    }
    return null;
}

// 名前からスラッグを自動生成する。ASCII に変換できる部分だけを使い、
// 日本語などで空になった場合は名前のハッシュから安定したスラッグを作る
// （同じ名前なら常に同じスラッグになるので UNIQUE 制約と両立する）。
function arenaSlugify(string $name): string {
    $ascii = preg_replace('/[^\x20-\x7E]/', '', $name); // 非ASCII文字を除去
    $slug  = strtolower(trim((string)$ascii));
    $slug  = preg_replace('/[^a-z0-9]+/', '-', $slug);
    $slug  = trim($slug, '-');
    if ($slug === '') {
        $slug = 'e' . substr(hash('sha1', $name), 0, 10);
    }
    if (strlen($slug) > 40) {
        $slug = rtrim(substr($slug, 0, 40), '-');
    }
    return $slug;
}

function arenaBoolToInt($v): int {
    return !empty($v) ? 1 : 0;
}

// turn_seconds を検証し、有効なら整数を、無効なら null を返す（0〜600の整数のみ許可）
function arenaValidateTurnSeconds($value): ?int {
    if (is_bool($value) || !is_numeric($value)) {
        return null;
    }
    if (is_string($value) && !preg_match('/^-?\d+$/', trim($value))) {
        return null; // "30.5" のような小数文字列は拒否
    }
    if (is_float($value) && floor($value) !== $value) {
        return null; // 30.5 のような小数は拒否
    }
    $n = (int)$value;
    if ($n < 0 || $n > 600) {
        return null;
    }
    return $n;
}

// slug からゲームを引く（管理系は enabled=0 のゲームも編集できるよう絞り込まない）
function arenaFindGameBySlug(PDO $db, string $slug): ?array {
    $stmt = $db->prepare('SELECT * FROM arena_games WHERE slug = ?');
    $stmt->execute([$slug]);
    $row = $stmt->fetch();
    return $row ?: null;
}

function arenaFindFormatById(PDO $db, int $id): ?array {
    $stmt = $db->prepare('SELECT * FROM arena_formats WHERE id = ?');
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    return $row ?: null;
}

// ── ゲーム（タイトルマスタ） ─────────────────────────────────────

// POST /v1/admin/games
function arenaHandleAdminGameCreate(array $params, PDO $db): void {
    $admin = requireArenaAdmin($db);
    $body  = arenaReadJsonBody();

    $allowed = ['slug', 'name', 'icon', 'sort_order'];
    if ($err = arenaCheckAllowedFields($body, $allowed)) {
        jsonResponse(['success' => false, 'message' => $err], 400);
    }

    $name = trim((string)($body['name'] ?? ''));
    if ($name === '') {
        jsonResponse(['success' => false, 'message' => 'ゲーム名を入力してください'], 400);
    }

    $slug = isset($body['slug']) && $body['slug'] !== '' ? (string)$body['slug'] : arenaSlugify($name);
    if ($err = arenaValidateSlug($slug)) {
        jsonResponse(['success' => false, 'message' => $err], 400);
    }

    if (arenaFindGameBySlug($db, $slug)) {
        jsonResponse(['success' => false, 'message' => 'そのスラッグのゲームは既に存在します'], 409);
    }

    $now = time();
    $stmt = $db->prepare('
        INSERT INTO arena_games
            (slug, name, icon, sort_order, source, enabled, created_by, updated_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, \'user\', 1, ?, ?, ?, ?)
    ');
    try {
        $stmt->execute([
            $slug,
            $name,
            (string)($body['icon'] ?? ''),
            (int)($body['sort_order'] ?? 0),
            $admin['id'],
            $admin['id'],
            $now,
            $now,
        ]);
    } catch (PDOException $e) {
        jsonResponse(['success' => false, 'message' => 'そのスラッグのゲームは既に存在します'], 409);
    }

    $game = arenaFindGameBySlug($db, $slug);
    jsonResponse(['success' => true, 'game' => $game]);
}

// PATCH /v1/admin/games/{slug}
function arenaHandleAdminGameUpdate(array $params, PDO $db): void {
    $admin = requireArenaAdmin($db);
    $slug  = $params['slug'] ?? '';
    $game  = arenaFindGameBySlug($db, $slug);
    if (!$game) {
        jsonResponse(['success' => false, 'message' => 'ゲームが見つかりません'], 404);
    }

    $body = arenaReadJsonBody();
    $allowed = ['slug', 'name', 'icon', 'sort_order', 'enabled'];
    if ($err = arenaCheckAllowedFields($body, $allowed)) {
        jsonResponse(['success' => false, 'message' => $err], 400);
    }
    if (empty($body)) {
        jsonResponse(['success' => false, 'message' => '更新するフィールドを指定してください'], 400);
    }

    $newSlug = $game['slug'];
    if (array_key_exists('slug', $body)) {
        $newSlug = (string)$body['slug'];
        if ($err = arenaValidateSlug($newSlug)) {
            jsonResponse(['success' => false, 'message' => $err], 400);
        }
    }

    $name = array_key_exists('name', $body) ? trim((string)$body['name']) : $game['name'];
    if ($name === '') {
        jsonResponse(['success' => false, 'message' => 'ゲーム名を空にはできません'], 400);
    }

    $sortOrder = array_key_exists('sort_order', $body) ? (int)$body['sort_order'] : (int)$game['sort_order'];
    $enabled   = array_key_exists('enabled', $body) ? arenaBoolToInt($body['enabled']) : (int)$game['enabled'];

    $stmt = $db->prepare('
        UPDATE arena_games
        SET slug = ?, name = ?, icon = ?, sort_order = ?, enabled = ?, source = \'user\', updated_by = ?, updated_at = ?
        WHERE id = ?
    ');
    try {
        $stmt->execute([
            $newSlug,
            $name,
            (string)($body['icon'] ?? $game['icon']),
            $sortOrder,
            $enabled,
            $admin['id'],
            time(),
            (int)$game['id'],
        ]);
    } catch (PDOException $e) {
        jsonResponse(['success' => false, 'message' => 'そのスラッグのゲームは既に存在します'], 409);
    }

    jsonResponse(['success' => true, 'game' => arenaFindGameBySlug($db, $newSlug)]);
}

// DELETE /v1/admin/games/{slug} — 論理削除のみ（enabled=0）。物理削除はしない。
function arenaHandleAdminGameDelete(array $params, PDO $db): void {
    $admin = requireArenaAdmin($db);
    $slug  = $params['slug'] ?? '';
    $game  = arenaFindGameBySlug($db, $slug);
    if (!$game) {
        jsonResponse(['success' => false, 'message' => 'ゲームが見つかりません'], 404);
    }

    $stmt = $db->prepare("UPDATE arena_games SET enabled = 0, source = 'user', updated_by = ?, updated_at = ? WHERE id = ?");
    $stmt->execute([$admin['id'], time(), (int)$game['id']]);

    jsonResponse(['success' => true]);
}

// ── タイトルドラフト書式（arena_formats） ────────────────────────

// GET /v1/admin/formats
function arenaHandleAdminFormatsList(array $params, PDO $db): void {
    requireArenaAdmin($db);
    $stmt = $db->query('SELECT * FROM arena_formats ORDER BY is_default DESC, name');
    $formats = array_map('arenaSerializeFormatRow', $stmt->fetchAll());
    jsonResponse(['success' => true, 'formats' => $formats]);
}

// POST /v1/admin/formats
function arenaHandleAdminFormatCreate(array $params, PDO $db): void {
    $admin = requireArenaAdmin($db);
    $body  = arenaReadJsonBody();

    $allowed = ['slug', 'name', 'sequence', 'pool_size', 'wins_needed', 'turn_seconds', 'is_default'];
    if ($err = arenaCheckAllowedFields($body, $allowed)) {
        jsonResponse(['success' => false, 'message' => $err], 400);
    }

    $name = trim((string)($body['name'] ?? ''));
    if ($name === '') {
        jsonResponse(['success' => false, 'message' => 'フォーマット名を入力してください'], 400);
    }

    $poolSize   = isset($body['pool_size']) ? (int)$body['pool_size'] : 0;
    $winsNeeded = isset($body['wins_needed']) ? (int)$body['wins_needed'] : 0;
    $sequence   = isset($body['sequence']) && is_array($body['sequence']) ? $body['sequence'] : [];
    if ($err = arenaValidateFormatSequence($sequence, $poolSize, $winsNeeded)) {
        jsonResponse(['success' => false, 'message' => $err], 400);
    }

    $turnSeconds = arenaValidateTurnSeconds($body['turn_seconds'] ?? 0);
    if ($turnSeconds === null) {
        jsonResponse(['success' => false, 'message' => 'turn_seconds は 0〜600 の整数で指定してください'], 400);
    }

    $slug = isset($body['slug']) && $body['slug'] !== '' ? (string)$body['slug'] : arenaSlugify($name);
    if ($err = arenaValidateSlug($slug)) {
        jsonResponse(['success' => false, 'message' => $err], 400);
    }

    $isDefault = arenaBoolToInt($body['is_default'] ?? false);
    $now = time();

    $db->beginTransaction();
    try {
        if ($isDefault) {
            $db->exec('UPDATE arena_formats SET is_default = 0');
        }
        $stmt = $db->prepare('
            INSERT INTO arena_formats
                (slug, name, sequence, pool_size, wins_needed, turn_seconds, is_default, source, enabled, created_by, updated_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, \'user\', 1, ?, ?, ?, ?)
        ');
        $stmt->execute([
            $slug,
            $name,
            json_encode($sequence, JSON_UNESCAPED_UNICODE),
            $poolSize,
            $winsNeeded,
            $turnSeconds,
            $isDefault,
            $admin['id'],
            $admin['id'],
            $now,
            $now,
        ]);
        $db->commit();
    } catch (PDOException $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        jsonResponse(['success' => false, 'message' => 'そのスラッグのフォーマットは既に存在します'], 409);
    }

    jsonResponse(['success' => true, 'format' => arenaSerializeFormatRow(arenaFindFormatBySlugForAdmin($db, $slug))]);
}

// arenaFindFormatById と違い、直後の INSERT/UPDATE の結果をそのまま返すためだけの内部ヘルパー
function arenaFindFormatBySlugForAdmin(PDO $db, string $slug): array {
    $stmt = $db->prepare('SELECT * FROM arena_formats WHERE slug = ?');
    $stmt->execute([$slug]);
    return $stmt->fetch();
}

// PATCH /v1/admin/formats/{id}
function arenaHandleAdminFormatUpdate(array $params, PDO $db): void {
    $admin  = requireArenaAdmin($db);
    $id     = (int)($params['id'] ?? 0);
    $format = arenaFindFormatById($db, $id);
    if (!$format) {
        jsonResponse(['success' => false, 'message' => 'フォーマットが見つかりません'], 404);
    }

    $body = arenaReadJsonBody();
    $allowed = ['slug', 'name', 'sequence', 'pool_size', 'wins_needed', 'turn_seconds', 'is_default', 'enabled'];
    if ($err = arenaCheckAllowedFields($body, $allowed)) {
        jsonResponse(['success' => false, 'message' => $err], 400);
    }
    if (empty($body)) {
        jsonResponse(['success' => false, 'message' => '更新するフィールドを指定してください'], 400);
    }

    $newSlug = $format['slug'];
    if (array_key_exists('slug', $body)) {
        $newSlug = (string)$body['slug'];
        if ($err = arenaValidateSlug($newSlug)) {
            jsonResponse(['success' => false, 'message' => $err], 400);
        }
    }

    $name = array_key_exists('name', $body) ? trim((string)$body['name']) : $format['name'];
    if ($name === '') {
        jsonResponse(['success' => false, 'message' => 'フォーマット名を空にはできません'], 400);
    }

    $poolSize   = array_key_exists('pool_size', $body) ? (int)$body['pool_size'] : (int)$format['pool_size'];
    $winsNeeded = array_key_exists('wins_needed', $body) ? (int)$body['wins_needed'] : (int)$format['wins_needed'];
    $sequence   = array_key_exists('sequence', $body) && is_array($body['sequence'])
        ? $body['sequence']
        : (json_decode($format['sequence'], true) ?: []);

    if ($err = arenaValidateFormatSequence($sequence, $poolSize, $winsNeeded)) {
        jsonResponse(['success' => false, 'message' => $err], 400);
    }

    $turnSeconds = (int)$format['turn_seconds'];
    if (array_key_exists('turn_seconds', $body)) {
        $turnSeconds = arenaValidateTurnSeconds($body['turn_seconds']);
        if ($turnSeconds === null) {
            jsonResponse(['success' => false, 'message' => 'turn_seconds は 0〜600 の整数で指定してください'], 400);
        }
    }

    $isDefault = array_key_exists('is_default', $body) ? arenaBoolToInt($body['is_default']) : (int)$format['is_default'];
    $enabled   = array_key_exists('enabled', $body) ? arenaBoolToInt($body['enabled']) : (int)$format['enabled'];

    $db->beginTransaction();
    try {
        if ($isDefault) {
            $db->prepare('UPDATE arena_formats SET is_default = 0 WHERE id != ?')->execute([$id]);
        }
        $stmt = $db->prepare('
            UPDATE arena_formats
            SET slug = ?, name = ?, sequence = ?, pool_size = ?, wins_needed = ?, turn_seconds = ?,
                is_default = ?, enabled = ?, source = \'user\', updated_by = ?, updated_at = ?
            WHERE id = ?
        ');
        $stmt->execute([
            $newSlug, $name, json_encode($sequence, JSON_UNESCAPED_UNICODE), $poolSize, $winsNeeded, $turnSeconds,
            $isDefault, $enabled, $admin['id'], time(), $id,
        ]);
        $db->commit();
    } catch (PDOException $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        jsonResponse(['success' => false, 'message' => 'そのスラッグのフォーマットは既に存在します'], 409);
    }

    jsonResponse(['success' => true, 'format' => arenaSerializeFormatRow(arenaFindFormatById($db, $id))]);
}

// DELETE /v1/admin/formats/{id} — 論理削除のみ
function arenaHandleAdminFormatDelete(array $params, PDO $db): void {
    $admin  = requireArenaAdmin($db);
    $id     = (int)($params['id'] ?? 0);
    $format = arenaFindFormatById($db, $id);
    if (!$format) {
        jsonResponse(['success' => false, 'message' => 'フォーマットが見つかりません'], 404);
    }

    $stmt = $db->prepare("UPDATE arena_formats SET enabled = 0, source = 'user', updated_by = ?, updated_at = ? WHERE id = ?");
    $stmt->execute([$admin['id'], time(), $id]);

    jsonResponse(['success' => true]);
}

// ── API キー（Discordボット用） ──────────────────────────────────

// GET /v1/admin/keys — 一覧（生鍵は返さない）
function arenaHandleAdminKeysList(array $params, PDO $db): void {
    requireArenaAdmin($db);
    $stmt = $db->query('
        SELECT id, name, scopes, created_by, created_at, last_used_at, revoked_at
        FROM arena_api_keys ORDER BY created_at DESC
    ');
    jsonResponse(['success' => true, 'keys' => $stmt->fetchAll()]);
}

// POST /v1/admin/keys — 発行。生鍵はこのレスポンスでのみ返す
function arenaHandleAdminKeyCreate(array $params, PDO $db): void {
    $admin = requireArenaAdmin($db);
    $body  = arenaReadJsonBody();
    if ($err = arenaCheckAllowedFields($body, ['name', 'scopes'])) {
        jsonResponse(['success' => false, 'message' => $err], 400);
    }

    $name = trim((string)($body['name'] ?? ''));
    if ($name === '') {
        jsonResponse(['success' => false, 'message' => 'キーの名前を入力してください'], 400);
    }
    $scopes = (string)($body['scopes'] ?? 'read');

    $rawKey  = bin2hex(random_bytes(24));
    $keyHash = hash('sha256', $rawKey);
    $now     = time();

    $stmt = $db->prepare('
        INSERT INTO arena_api_keys (name, key_hash, scopes, created_by, created_at)
        VALUES (?, ?, ?, ?, ?)
    ');
    $stmt->execute([$name, $keyHash, $scopes, $admin['id'], $now]);

    jsonResponse([
        'success' => true,
        'id'      => (int)$db->lastInsertId(),
        'key'     => $rawKey, // 一度きり。DBには保存されない
        'message' => 'このキーは今だけ表示されます。必ず控えてください。',
    ]);
}

// DELETE /v1/admin/keys/{id} — 失効
function arenaHandleAdminKeyDelete(array $params, PDO $db): void {
    requireArenaAdmin($db);
    $id = (int)($params['id'] ?? 0);

    $stmt = $db->prepare('SELECT id FROM arena_api_keys WHERE id = ?');
    $stmt->execute([$id]);
    if (!$stmt->fetch()) {
        jsonResponse(['success' => false, 'message' => 'キーが見つかりません'], 404);
    }

    $db->prepare('UPDATE arena_api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
       ->execute([time(), $id]);

    jsonResponse(['success' => true]);
}

// ── 管理者 ───────────────────────────────────────────────────────

// GET /v1/admin/admins
function arenaHandleAdminAdminsList(array $params, PDO $db): void {
    requireArenaAdmin($db);
    $stmt = $db->query('SELECT user_id, username, granted_by, created_at FROM arena_admins ORDER BY created_at');
    jsonResponse(['success' => true, 'admins' => $stmt->fetchAll()]);
}

// POST /v1/admin/admins — 追加
function arenaHandleAdminAdminCreate(array $params, PDO $db): void {
    $admin = requireArenaAdmin($db);
    $body  = arenaReadJsonBody();
    if ($err = arenaCheckAllowedFields($body, ['user_id', 'username'])) {
        jsonResponse(['success' => false, 'message' => $err], 400);
    }

    $userId = (int)($body['user_id'] ?? 0);
    if ($userId <= 0) {
        jsonResponse(['success' => false, 'message' => 'user_id を指定してください'], 400);
    }

    $username = (string)($body['username'] ?? '');
    if ($username === '') {
        // ユーザー名が渡されなければ auth.db から補完を試みる（失敗しても空文字のまま続行）
        try {
            $authDb = getDB();
            $stmt = $authDb->prepare('SELECT username FROM users WHERE id = ?');
            $stmt->execute([$userId]);
            $row = $stmt->fetch();
            if ($row) {
                $username = (string)$row['username'];
            }
        } catch (PDOException $e) {
            error_log('[arena] admin create username lookup failed: ' . $e->getMessage());
        }
    }

    if (isArenaAdmin($db, $userId)) {
        jsonResponse(['success' => false, 'message' => 'そのユーザーは既に管理者です'], 409);
    }

    $stmt = $db->prepare('INSERT INTO arena_admins (user_id, username, granted_by, created_at) VALUES (?, ?, ?, ?)');
    $stmt->execute([$userId, $username, $admin['id'], time()]);

    jsonResponse(['success' => true]);
}

// DELETE /v1/admin/admins/{id} — 削除。最後の1人は削除不可
function arenaHandleAdminAdminDelete(array $params, PDO $db): void {
    requireArenaAdmin($db);
    $userId = (int)($params['id'] ?? 0);

    if (!isArenaAdmin($db, $userId)) {
        jsonResponse(['success' => false, 'message' => 'そのユーザーは管理者ではありません'], 404);
    }

    $count = (int)$db->query('SELECT COUNT(*) FROM arena_admins')->fetchColumn();
    if ($count <= 1) {
        jsonResponse(['success' => false, 'message' => '最後の管理者は削除できません'], 400);
    }

    $db->prepare('DELETE FROM arena_admins WHERE user_id = ?')->execute([$userId]);
    jsonResponse(['success' => true]);
}
