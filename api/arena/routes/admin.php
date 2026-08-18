<?php
// Phase 2: 管理者専用ハンドラ（ゲームマスタ管理・所持ゲームとは別枠）。
// すべてのハンドラは冒頭で requireArenaAdmin($db) を呼ぶ。
// ここから作成・更新される行はすべて source='user' とし、created_by/updated_by/updated_at を残す。

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

// ルールセットの sequence を検証する。空でない JSON 配列で、各要素が
// {"t":"ban"|"pick","s":"A"|"B"} の形であることを要求する。
function arenaValidateSequence($seq): ?string {
    if (!is_array($seq) || empty($seq) || array_keys($seq) !== range(0, count($seq) - 1)) {
        return 'sequence は空でない配列（BAN/PICKの手順リスト）で指定してください';
    }
    foreach ($seq as $step) {
        if (!is_array($step)) {
            return 'sequence の各要素はオブジェクト {"t":"ban|pick","s":"A|B"} にしてください';
        }
        $extra = array_diff(array_keys($step), ['t', 's']);
        if (!empty($extra)) {
            return 'sequence の要素に不明なキーがあります: ' . implode(', ', $extra);
        }
        $t = $step['t'] ?? null;
        $s = $step['s'] ?? null;
        if (!in_array($t, ['ban', 'pick'], true)) {
            return 'sequence の "t" は "ban" か "pick" にしてください';
        }
        if (!in_array($s, ['A', 'B'], true)) {
            return 'sequence の "s" は "A" か "B" にしてください';
        }
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

// slug からゲームを引く（管理系は enabled=0 のゲームも編集できるよう絞り込まない）
function arenaFindGameBySlug(PDO $db, string $slug): ?array {
    $stmt = $db->prepare('SELECT * FROM arena_games WHERE slug = ?');
    $stmt->execute([$slug]);
    $row = $stmt->fetch();
    return $row ?: null;
}

function arenaFindEntryById(PDO $db, int $id): ?array {
    $stmt = $db->prepare('SELECT * FROM arena_entries WHERE id = ?');
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    return $row ?: null;
}

function arenaFindRulesetById(PDO $db, int $id): ?array {
    $stmt = $db->prepare('SELECT * FROM arena_rulesets WHERE id = ?');
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    return $row ?: null;
}

// ── ゲーム ───────────────────────────────────────────────────────

// POST /v1/admin/games
function arenaHandleAdminGameCreate(array $params, PDO $db): void {
    $admin = requireArenaAdmin($db);
    $body  = arenaReadJsonBody();

    $allowed = ['slug', 'name', 'entry_label', 'icon', 'sort_order', 'entry_source'];
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

    $entrySource = (string)($body['entry_source'] ?? 'manual');
    if (!in_array($entrySource, ['manual', 'ddragon'], true)) {
        jsonResponse(['success' => false, 'message' => 'entry_source は "manual" か "ddragon" にしてください'], 400);
    }

    if (arenaFindGameBySlug($db, $slug)) {
        jsonResponse(['success' => false, 'message' => 'そのスラッグのゲームは既に存在します'], 409);
    }

    $now = time();
    $stmt = $db->prepare('
        INSERT INTO arena_games
            (slug, name, entry_label, icon, sort_order, entry_source, source, enabled, created_by, updated_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, \'user\', 1, ?, ?, ?, ?)
    ');
    try {
        $stmt->execute([
            $slug,
            $name,
            (string)($body['entry_label'] ?? 'キャラクター'),
            (string)($body['icon'] ?? ''),
            (int)($body['sort_order'] ?? 0),
            $entrySource,
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
    $allowed = ['slug', 'name', 'entry_label', 'icon', 'sort_order', 'entry_source', 'enabled'];
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

    $entrySource = array_key_exists('entry_source', $body) ? (string)$body['entry_source'] : $game['entry_source'];
    if (!in_array($entrySource, ['manual', 'ddragon'], true)) {
        jsonResponse(['success' => false, 'message' => 'entry_source は "manual" か "ddragon" にしてください'], 400);
    }

    $sortOrder = array_key_exists('sort_order', $body) ? (int)$body['sort_order'] : (int)$game['sort_order'];
    $enabled   = array_key_exists('enabled', $body) ? arenaBoolToInt($body['enabled']) : (int)$game['enabled'];

    $stmt = $db->prepare('
        UPDATE arena_games
        SET slug = ?, name = ?, entry_label = ?, icon = ?, sort_order = ?, entry_source = ?,
            enabled = ?, source = \'user\', updated_by = ?, updated_at = ?
        WHERE id = ?
    ');
    try {
        $stmt->execute([
            $newSlug,
            $name,
            (string)($body['entry_label'] ?? $game['entry_label']),
            (string)($body['icon'] ?? $game['icon']),
            $sortOrder,
            $entrySource,
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

// ── エントリー ───────────────────────────────────────────────────

// POST /v1/admin/games/{slug}/entries — 1件追加（UPSERT）
function arenaHandleAdminEntryCreate(array $params, PDO $db): void {
    $admin = requireArenaAdmin($db);
    $slug  = $params['slug'] ?? '';
    $game  = arenaFindGameBySlug($db, $slug);
    if (!$game) {
        jsonResponse(['success' => false, 'message' => 'ゲームが見つかりません'], 404);
    }

    $body = arenaReadJsonBody();
    $allowed = ['slug', 'name', 'image_url', 'tags'];
    if ($err = arenaCheckAllowedFields($body, $allowed)) {
        jsonResponse(['success' => false, 'message' => $err], 400);
    }

    $name = trim((string)($body['name'] ?? ''));
    if ($name === '') {
        jsonResponse(['success' => false, 'message' => '名前を入力してください'], 400);
    }

    $entrySlug = isset($body['slug']) && $body['slug'] !== '' ? (string)$body['slug'] : arenaSlugify($name);
    if ($err = arenaValidateSlug($entrySlug)) {
        jsonResponse(['success' => false, 'message' => $err], 400);
    }

    $now = time();
    $stmt = $db->prepare('
        INSERT INTO arena_entries
            (game_id, slug, name, image_url, tags, source, enabled, created_by, updated_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, \'user\', 1, ?, ?, ?, ?)
        ON CONFLICT(game_id, slug) DO UPDATE SET
            name = excluded.name, image_url = excluded.image_url, tags = excluded.tags,
            source = \'user\', enabled = 1, updated_by = excluded.updated_by, updated_at = excluded.updated_at
    ');
    $stmt->execute([
        (int)$game['id'],
        $entrySlug,
        $name,
        (string)($body['image_url'] ?? ''),
        (string)($body['tags'] ?? ''),
        $admin['id'],
        $admin['id'],
        $now,
        $now,
    ]);

    $entryStmt = $db->prepare('SELECT * FROM arena_entries WHERE game_id = ? AND slug = ?');
    $entryStmt->execute([(int)$game['id'], $entrySlug]);
    jsonResponse(['success' => true, 'entry' => $entryStmt->fetch()]);
}

// POST /v1/admin/games/{slug}/entries/import — 一括投入
// 改行区切りの名前リスト、または JSON 配列（文字列 or {name,slug?,image_url?,tags?} オブジェクト）を受け付ける
function arenaHandleAdminEntryImport(array $params, PDO $db): void {
    $admin = requireArenaAdmin($db);
    $slug  = $params['slug'] ?? '';
    $game  = arenaFindGameBySlug($db, $slug);
    if (!$game) {
        jsonResponse(['success' => false, 'message' => 'ゲームが見つかりません'], 404);
    }

    $raw     = file_get_contents('php://input');
    $decoded = json_decode($raw, true);

    // 受け付ける形式:
    //   1. 改行区切りのプレーンテキスト（管理画面の一括インポートはこれを送る）
    //   2. JSON配列  ["リュウ", ...] / [{"name":"リュウ", ...}, ...]
    //   3. JSONオブジェクト {"text":"改行区切り"} / {"names":[...]}（ボット等から扱いやすい形）
    // JSONオブジェクトを配列としてそのまま舐めると、値が丸ごと1件の名前になって
    // 改行入りの壊れたエントリーが黙って作られるため、明示的に分岐する。
    $items = [];
    if (is_array($decoded)) {
        $isList = ($decoded === []) || (array_keys($decoded) === range(0, count($decoded) - 1));
        if ($isList) {
            $source = $decoded;
        } elseif (isset($decoded['text']) && is_string($decoded['text'])) {
            $source = preg_split('/\r\n|\r|\n/', $decoded['text']);
        } elseif (isset($decoded['names']) && is_array($decoded['names'])) {
            $source = $decoded['names'];
        } else {
            jsonResponse([
                'success' => false,
                'message' => 'インポート形式が不正です（配列、{"text":"改行区切り"}、{"names":[...]} のいずれか）',
            ], 400);
            return;
        }
        foreach ($source as $entry) {
            if (is_string($entry)) {
                $items[] = ['name' => $entry];
            } elseif (is_array($entry) && isset($entry['name']) && is_string($entry['name'])) {
                $items[] = $entry;
            }
        }
    } else {
        foreach (preg_split('/\r\n|\r|\n/', (string)$raw) as $line) {
            $items[] = ['name' => $line];
        }
    }

    // どの経路で来ても、改行を含む名前は行ごとに分割し、空行は捨てる。
    $normalized = [];
    foreach ($items as $item) {
        foreach (preg_split('/\r\n|\r|\n/', (string)$item['name']) as $line) {
            $line = trim($line);
            if ($line === '') {
                continue;
            }
            if (mb_strlen($line) > 100) {
                jsonResponse([
                    'success' => false,
                    'message' => '名前が長すぎます（100文字以内）: ' . mb_substr($line, 0, 20) . '…',
                ], 400);
                return;
            }
            $row = $item;
            $row['name'] = $line;
            $normalized[] = $row;
        }
    }
    $items = $normalized;

    if (empty($items)) {
        jsonResponse(['success' => false, 'message' => 'インポートするデータがありません'], 400);
    }

    $now = time();
    $gameId = (int)$game['id'];
    $stmt = $db->prepare('
        INSERT INTO arena_entries
            (game_id, slug, name, image_url, tags, source, enabled, created_by, updated_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, \'user\', 1, ?, ?, ?, ?)
        ON CONFLICT(game_id, slug) DO UPDATE SET
            name = excluded.name, image_url = excluded.image_url, tags = excluded.tags,
            source = \'user\', enabled = 1, updated_by = excluded.updated_by, updated_at = excluded.updated_at
    ');

    $imported = 0;
    $db->beginTransaction();
    try {
        $usedSlugs = [];
        foreach ($items as $item) {
            $name = trim((string)($item['name'] ?? ''));
            if ($name === '') {
                continue;
            }
            $entrySlug = !empty($item['slug']) && arenaValidateSlug((string)$item['slug']) === null
                ? (string)$item['slug']
                : arenaSlugify($name);
            // 同一バッチ内でスラッグが衝突した場合はハッシュにフォールバックして取りこぼしを防ぐ
            if (isset($usedSlugs[$entrySlug])) {
                $entrySlug = 'e' . substr(hash('sha1', $name . '#' . $imported), 0, 10);
            }
            $usedSlugs[$entrySlug] = true;

            $stmt->execute([
                $gameId,
                $entrySlug,
                $name,
                (string)($item['image_url'] ?? ''),
                (string)($item['tags'] ?? ''),
                $admin['id'],
                $admin['id'],
                $now,
                $now,
            ]);
            $imported++;
        }
        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        throw $e;
    }

    jsonResponse(['success' => true, 'imported' => $imported]);
}

// PATCH /v1/admin/entries/{id}
function arenaHandleAdminEntryUpdate(array $params, PDO $db): void {
    $admin = requireArenaAdmin($db);
    $id    = (int)($params['id'] ?? 0);
    $entry = arenaFindEntryById($db, $id);
    if (!$entry) {
        jsonResponse(['success' => false, 'message' => 'エントリーが見つかりません'], 404);
    }

    $body = arenaReadJsonBody();
    $allowed = ['slug', 'name', 'image_url', 'tags', 'enabled'];
    if ($err = arenaCheckAllowedFields($body, $allowed)) {
        jsonResponse(['success' => false, 'message' => $err], 400);
    }
    if (empty($body)) {
        jsonResponse(['success' => false, 'message' => '更新するフィールドを指定してください'], 400);
    }

    $newSlug = $entry['slug'];
    if (array_key_exists('slug', $body)) {
        $newSlug = (string)$body['slug'];
        if ($err = arenaValidateSlug($newSlug)) {
            jsonResponse(['success' => false, 'message' => $err], 400);
        }
    }

    $name = array_key_exists('name', $body) ? trim((string)$body['name']) : $entry['name'];
    if ($name === '') {
        jsonResponse(['success' => false, 'message' => '名前を空にはできません'], 400);
    }

    $enabled = array_key_exists('enabled', $body) ? arenaBoolToInt($body['enabled']) : (int)$entry['enabled'];

    $stmt = $db->prepare('
        UPDATE arena_entries
        SET slug = ?, name = ?, image_url = ?, tags = ?, enabled = ?, source = \'user\', updated_by = ?, updated_at = ?
        WHERE id = ?
    ');
    try {
        $stmt->execute([
            $newSlug,
            $name,
            (string)($body['image_url'] ?? $entry['image_url']),
            (string)($body['tags'] ?? $entry['tags']),
            $enabled,
            $admin['id'],
            time(),
            $id,
        ]);
    } catch (PDOException $e) {
        jsonResponse(['success' => false, 'message' => 'そのスラッグのエントリーは既に存在します'], 409);
    }

    jsonResponse(['success' => true, 'entry' => arenaFindEntryById($db, $id)]);
}

// DELETE /v1/admin/entries/{id} — 論理削除のみ。過去のドラフト記録（arena_actions）が参照しているため物理削除はしない。
function arenaHandleAdminEntryDelete(array $params, PDO $db): void {
    $admin = requireArenaAdmin($db);
    $id    = (int)($params['id'] ?? 0);
    $entry = arenaFindEntryById($db, $id);
    if (!$entry) {
        jsonResponse(['success' => false, 'message' => 'エントリーが見つかりません'], 404);
    }

    $stmt = $db->prepare("UPDATE arena_entries SET enabled = 0, source = 'user', updated_by = ?, updated_at = ? WHERE id = ?");
    $stmt->execute([$admin['id'], time(), $id]);

    jsonResponse(['success' => true]);
}

// ── ルールセット ─────────────────────────────────────────────────

// POST /v1/admin/games/{slug}/rulesets
function arenaHandleAdminRulesetCreate(array $params, PDO $db): void {
    $admin = requireArenaAdmin($db);
    $slug  = $params['slug'] ?? '';
    $game  = arenaFindGameBySlug($db, $slug);
    if (!$game) {
        jsonResponse(['success' => false, 'message' => 'ゲームが見つかりません'], 404);
    }

    $body = arenaReadJsonBody();
    $allowed = ['slug', 'name', 'sequence', 'turn_seconds', 'mirror_allowed', 'fearless', 'is_default'];
    if ($err = arenaCheckAllowedFields($body, $allowed)) {
        jsonResponse(['success' => false, 'message' => $err], 400);
    }

    $name = trim((string)($body['name'] ?? ''));
    if ($name === '') {
        jsonResponse(['success' => false, 'message' => 'ルールセット名を入力してください'], 400);
    }

    if ($err = arenaValidateSequence($body['sequence'] ?? null)) {
        jsonResponse(['success' => false, 'message' => $err], 400);
    }

    $turnSeconds = arenaValidateTurnSeconds($body['turn_seconds'] ?? 30);
    if ($turnSeconds === null) {
        jsonResponse(['success' => false, 'message' => 'turn_seconds は 0〜600 の整数で指定してください'], 400);
    }

    $rulesetSlug = isset($body['slug']) && $body['slug'] !== '' ? (string)$body['slug'] : arenaSlugify($name);
    if ($err = arenaValidateSlug($rulesetSlug)) {
        jsonResponse(['success' => false, 'message' => $err], 400);
    }

    $isDefault = arenaBoolToInt($body['is_default'] ?? false);
    $now = time();
    $gameId = (int)$game['id'];

    $db->beginTransaction();
    try {
        if ($isDefault) {
            $db->prepare('UPDATE arena_rulesets SET is_default = 0 WHERE game_id = ?')->execute([$gameId]);
        }
        $stmt = $db->prepare('
            INSERT INTO arena_rulesets
                (game_id, slug, name, sequence, turn_seconds, mirror_allowed, fearless, is_default, source, enabled, created_by, updated_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, \'user\', 1, ?, ?, ?, ?)
            ON CONFLICT(game_id, slug) DO UPDATE SET
                name = excluded.name, sequence = excluded.sequence, turn_seconds = excluded.turn_seconds,
                mirror_allowed = excluded.mirror_allowed, fearless = excluded.fearless, is_default = excluded.is_default,
                source = \'user\', enabled = 1, updated_by = excluded.updated_by, updated_at = excluded.updated_at
        ');
        $stmt->execute([
            $gameId,
            $rulesetSlug,
            $name,
            json_encode($body['sequence'], JSON_UNESCAPED_UNICODE),
            $turnSeconds,
            arenaBoolToInt($body['mirror_allowed'] ?? false),
            arenaBoolToInt($body['fearless'] ?? false),
            $isDefault,
            $admin['id'],
            $admin['id'],
            $now,
            $now,
        ]);
        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        throw $e;
    }

    $rsStmt = $db->prepare('SELECT * FROM arena_rulesets WHERE game_id = ? AND slug = ?');
    $rsStmt->execute([$gameId, $rulesetSlug]);
    jsonResponse(['success' => true, 'ruleset' => $rsStmt->fetch()]);
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

// PATCH /v1/admin/rulesets/{id}
function arenaHandleAdminRulesetUpdate(array $params, PDO $db): void {
    $admin   = requireArenaAdmin($db);
    $id      = (int)($params['id'] ?? 0);
    $ruleset = arenaFindRulesetById($db, $id);
    if (!$ruleset) {
        jsonResponse(['success' => false, 'message' => 'ルールセットが見つかりません'], 404);
    }

    $body = arenaReadJsonBody();
    $allowed = ['slug', 'name', 'sequence', 'turn_seconds', 'mirror_allowed', 'fearless', 'is_default', 'enabled'];
    if ($err = arenaCheckAllowedFields($body, $allowed)) {
        jsonResponse(['success' => false, 'message' => $err], 400);
    }
    if (empty($body)) {
        jsonResponse(['success' => false, 'message' => '更新するフィールドを指定してください'], 400);
    }

    $newSlug = $ruleset['slug'];
    if (array_key_exists('slug', $body)) {
        $newSlug = (string)$body['slug'];
        if ($err = arenaValidateSlug($newSlug)) {
            jsonResponse(['success' => false, 'message' => $err], 400);
        }
    }

    $name = array_key_exists('name', $body) ? trim((string)$body['name']) : $ruleset['name'];
    if ($name === '') {
        jsonResponse(['success' => false, 'message' => 'ルールセット名を空にはできません'], 400);
    }

    $sequenceJson = $ruleset['sequence'];
    if (array_key_exists('sequence', $body)) {
        if ($err = arenaValidateSequence($body['sequence'])) {
            jsonResponse(['success' => false, 'message' => $err], 400);
        }
        $sequenceJson = json_encode($body['sequence'], JSON_UNESCAPED_UNICODE);
    }

    $turnSeconds = (int)$ruleset['turn_seconds'];
    if (array_key_exists('turn_seconds', $body)) {
        $turnSeconds = arenaValidateTurnSeconds($body['turn_seconds']);
        if ($turnSeconds === null) {
            jsonResponse(['success' => false, 'message' => 'turn_seconds は 0〜600 の整数で指定してください'], 400);
        }
    }

    $mirrorAllowed = array_key_exists('mirror_allowed', $body) ? arenaBoolToInt($body['mirror_allowed']) : (int)$ruleset['mirror_allowed'];
    $fearless      = array_key_exists('fearless', $body) ? arenaBoolToInt($body['fearless']) : (int)$ruleset['fearless'];
    $isDefault     = array_key_exists('is_default', $body) ? arenaBoolToInt($body['is_default']) : (int)$ruleset['is_default'];
    $enabled       = array_key_exists('enabled', $body) ? arenaBoolToInt($body['enabled']) : (int)$ruleset['enabled'];

    $db->beginTransaction();
    try {
        if ($isDefault) {
            $db->prepare('UPDATE arena_rulesets SET is_default = 0 WHERE game_id = ? AND id != ?')
               ->execute([(int)$ruleset['game_id'], $id]);
        }
        $stmt = $db->prepare('
            UPDATE arena_rulesets
            SET slug = ?, name = ?, sequence = ?, turn_seconds = ?, mirror_allowed = ?, fearless = ?,
                is_default = ?, enabled = ?, source = \'user\', updated_by = ?, updated_at = ?
            WHERE id = ?
        ');
        $stmt->execute([
            $newSlug, $name, $sequenceJson, $turnSeconds, $mirrorAllowed, $fearless,
            $isDefault, $enabled, $admin['id'], time(), $id,
        ]);
        $db->commit();
    } catch (PDOException $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        jsonResponse(['success' => false, 'message' => 'そのスラッグのルールセットは既に存在します'], 409);
    }

    jsonResponse(['success' => true, 'ruleset' => arenaFindRulesetById($db, $id)]);
}

// DELETE /v1/admin/rulesets/{id} — 論理削除のみ
function arenaHandleAdminRulesetDelete(array $params, PDO $db): void {
    $admin   = requireArenaAdmin($db);
    $id      = (int)($params['id'] ?? 0);
    $ruleset = arenaFindRulesetById($db, $id);
    if (!$ruleset) {
        jsonResponse(['success' => false, 'message' => 'ルールセットが見つかりません'], 404);
    }

    $stmt = $db->prepare("UPDATE arena_rulesets SET enabled = 0, source = 'user', updated_by = ?, updated_at = ? WHERE id = ?");
    $stmt->execute([$admin['id'], time(), $id]);

    jsonResponse(['success' => true]);
}

// ── Data Dragon 同期（LoLのみ） ─────────────────────────────────

// POST /v1/admin/games/{slug}/sync
function arenaHandleAdminGameSync(array $params, PDO $db): void {
    $admin = requireArenaAdmin($db);
    $slug  = $params['slug'] ?? '';
    $game  = arenaFindGameBySlug($db, $slug);
    if (!$game) {
        jsonResponse(['success' => false, 'message' => 'ゲームが見つかりません'], 404);
    }
    if ($game['entry_source'] !== 'ddragon') {
        jsonResponse(['success' => false, 'message' => 'このゲームは Data Dragon 同期の対象ではありません'], 400);
    }

    require_once __DIR__ . '/../lib/ddragon.php';
    $result = arenaSyncDdragon($db, $game, $admin['id']);
    if (!$result['success']) {
        jsonResponse(['success' => false, 'message' => $result['message']], 502);
    }

    jsonResponse(['success' => true, 'version' => $result['version'], 'count' => $result['count']]);
}

// ── 再シード（JSON を明示的に再適用。source='seed' の行のみ上書き） ─

// POST /v1/admin/games/{slug}/reseed
function arenaHandleAdminGameReseed(array $params, PDO $db): void {
    $admin = requireArenaAdmin($db);
    $slug  = $params['slug'] ?? '';
    $game  = arenaFindGameBySlug($db, $slug);
    if (!$game) {
        jsonResponse(['success' => false, 'message' => 'ゲームが見つかりません'], 404);
    }

    $file = __DIR__ . '/../data/' . $slug . '.json';
    if (!is_file($file)) {
        jsonResponse(['success' => false, 'message' => '対応する JSON ファイルが見つかりません（data/' . $slug . '.json）'], 404);
    }
    $json = json_decode(file_get_contents($file), true);
    if (!is_array($json)) {
        jsonResponse(['success' => false, 'message' => 'JSON の解析に失敗しました'], 400);
    }

    $now    = time();
    $gameId = (int)$game['id'];

    $db->beginTransaction();
    try {
        // ゲーム自体も source='seed' のときだけ上書き（'user' に変えたゲームは保護）
        $stmt = $db->prepare("
            UPDATE arena_games SET name = ?, entry_label = ?, icon = ?, sort_order = ?, entry_source = ?, updated_by = ?, updated_at = ?
            WHERE id = ? AND source = 'seed'
        ");
        $stmt->execute([
            (string)($json['name'] ?? $game['name']),
            (string)($json['entry_label'] ?? $game['entry_label']),
            (string)($json['icon'] ?? $game['icon']),
            (int)($json['sort_order'] ?? $game['sort_order']),
            (string)($json['entry_source'] ?? $game['entry_source']),
            $admin['id'], $now, $gameId,
        ]);

        $entryStmt = $db->prepare("
            INSERT INTO arena_entries (game_id, slug, name, image_url, tags, source, enabled, created_by, updated_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'seed', 1, ?, ?, ?, ?)
            ON CONFLICT(game_id, slug) DO UPDATE SET
                name = excluded.name, image_url = excluded.image_url, tags = excluded.tags,
                enabled = 1, updated_by = excluded.updated_by, updated_at = excluded.updated_at
            WHERE arena_entries.source = 'seed'
        ");
        $entryCount = 0;
        foreach (($json['entries'] ?? []) as $entry) {
            if (empty($entry['slug']) || empty($entry['name'])) {
                continue;
            }
            $entryStmt->execute([
                $gameId, (string)$entry['slug'], (string)$entry['name'],
                (string)($entry['image_url'] ?? ''), (string)($entry['tags'] ?? ''),
                $admin['id'], $admin['id'], $now, $now,
            ]);
            $entryCount++;
        }

        $rulesetStmt = $db->prepare("
            INSERT INTO arena_rulesets
                (game_id, slug, name, sequence, turn_seconds, mirror_allowed, fearless, is_default, source, enabled, created_by, updated_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'seed', 1, ?, ?, ?, ?)
            ON CONFLICT(game_id, slug) DO UPDATE SET
                name = excluded.name, sequence = excluded.sequence, turn_seconds = excluded.turn_seconds,
                mirror_allowed = excluded.mirror_allowed, fearless = excluded.fearless, is_default = excluded.is_default,
                enabled = 1, updated_by = excluded.updated_by, updated_at = excluded.updated_at
            WHERE arena_rulesets.source = 'seed'
        ");
        $rulesetCount = 0;
        foreach (($json['rulesets'] ?? []) as $ruleset) {
            if (empty($ruleset['slug']) || empty($ruleset['sequence'])) {
                continue;
            }
            $rulesetStmt->execute([
                $gameId, (string)$ruleset['slug'], (string)($ruleset['name'] ?? $ruleset['slug']),
                json_encode($ruleset['sequence'], JSON_UNESCAPED_UNICODE),
                (int)($ruleset['turn_seconds'] ?? 30),
                !empty($ruleset['mirror_allowed']) ? 1 : 0,
                !empty($ruleset['fearless']) ? 1 : 0,
                !empty($ruleset['is_default']) ? 1 : 0,
                $admin['id'], $admin['id'], $now, $now,
            ]);
            $rulesetCount++;
        }

        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        throw $e;
    }

    jsonResponse(['success' => true, 'entries' => $entryCount, 'rulesets' => $rulesetCount]);
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
