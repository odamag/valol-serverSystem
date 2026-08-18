<?php
// Phase 3: /v1/matches 系ハンドラ（試合作成・一覧・詳細・ドラフト・結果申告/承認・中止）。
// リクエストボディの読み取り・許可フィールドチェックは routes/admin.php の
// arenaReadJsonBody() / arenaCheckAllowedFields() を再利用する。

// public_id を生成する。8文字の16進数（bin2hex(random_bytes(4))）。衝突時は再試行する。
// common.php の generateDeviceToken() と同じ「暗号論的に安全な乱数」方針。
function arenaGenerateMatchPublicId(PDO $db): string {
    for ($i = 0; $i < 10; $i++) {
        $candidate = bin2hex(random_bytes(4));
        $stmt = $db->prepare('SELECT 1 FROM arena_matches WHERE public_id = ?');
        $stmt->execute([$candidate]);
        if (!$stmt->fetchColumn()) {
            return $candidate;
        }
    }
    throw new RuntimeException('public_id の生成に失敗しました');
}

// public_id から試合を取得し、参加者本人（player_a/player_b のどちらか）であることを
// サーバー側で確認する。それ以外は 404/403 を返して終了する。
// クライアントが送ってくる user id は一切信用しない（常にセッションの $user を使う）。
function arenaRequireMatchAccess(PDO $db, string $publicId, array $user): array {
    $match = arenaLoadMatch($db, $publicId);
    if (!$match) {
        jsonResponse(['success' => false, 'message' => '試合が見つかりません'], 404);
    }
    $uid = (int)$user['id'];
    if ($uid !== (int)$match['player_a_id'] && $uid !== (int)$match['player_b_id']) {
        jsonResponse(['success' => false, 'message' => 'この試合を閲覧・操作する権限がありません'], 403);
    }
    return $match;
}

// 読み取り時の遅延評価（48時間経過reportedの自動承認・タイムアウト自動選択）を通してから返す。
function arenaRefreshMatchForRead(PDO $db, array $match): array {
    $match = arenaMaybeAutoConfirm($db, $match);
    if ($match['status'] === 'drafting') {
        $ruleset = arenaLoadRuleset($db, (int)$match['ruleset_id']);
        if ($ruleset) {
            $match = arenaApplyTimeouts($db, $match, $ruleset);
        }
    }
    return $match;
}

// クライアント向けに試合1件をシリアライズする（ゲーム/ルールセット情報・確定時はレート増減を含む）
function arenaSerializeMatch(PDO $db, array $match): array {
    $gameStmt = $db->prepare('SELECT slug, name, entry_label, icon FROM arena_games WHERE id = ?');
    $gameStmt->execute([(int)$match['game_id']]);
    $game = $gameStmt->fetch();

    $rulesetStmt = $db->prepare('SELECT slug, name, sequence, turn_seconds, mirror_allowed, fearless FROM arena_rulesets WHERE id = ?');
    $rulesetStmt->execute([(int)$match['ruleset_id']]);
    $ruleset = $rulesetStmt->fetch();

    $result = [
        'public_id'     => $match['public_id'],
        'mode'          => $match['mode'],
        'status'        => $match['status'],
        'game'          => $game ? [
            'slug'        => $game['slug'],
            'name'        => $game['name'],
            'entry_label' => $game['entry_label'],
            'icon'        => $game['icon'],
        ] : null,
        'ruleset'       => $ruleset ? [
            'slug'           => $ruleset['slug'],
            'name'           => $ruleset['name'],
            'sequence'       => json_decode($ruleset['sequence'], true) ?: [],
            'turn_seconds'   => (int)$ruleset['turn_seconds'],
            'mirror_allowed' => (bool)$ruleset['mirror_allowed'],
            'fearless'       => (bool)$ruleset['fearless'],
        ] : null,
        'player_a_id'   => (int)$match['player_a_id'],
        'player_a_name' => $match['player_a_name'],
        'player_b_id'   => $match['player_b_id'] !== null ? (int)$match['player_b_id'] : null,
        'player_b_name' => $match['player_b_name'],
        'turn_index'    => (int)$match['turn_index'],
        'turn_deadline' => $match['turn_deadline'] !== null ? (int)$match['turn_deadline'] : null,
        'version'       => (int)$match['version'],
        'winner_side'   => $match['winner_side'],
        'score_a'       => (int)$match['score_a'],
        'score_b'       => (int)$match['score_b'],
        'reported_by'   => $match['reported_by'] !== null ? (int)$match['reported_by'] : null,
        'confirmed_by'  => $match['confirmed_by'] !== null ? (int)$match['confirmed_by'] : null,
        'created_by'    => (int)$match['created_by'],
        'created_at'    => (int)$match['created_at'],
        'updated_at'    => (int)$match['updated_at'],
        'finished_at'   => $match['finished_at'] !== null ? (int)$match['finished_at'] : null,
    ];

    if ($match['status'] === 'finished') {
        $histStmt = $db->prepare('
            SELECT user_id, rating_before, rating_after, result
            FROM arena_rating_history WHERE match_id = ? AND game_id = ?
        ');
        $histStmt->execute([(int)$match['id'], (int)$match['game_id']]);
        $deltas = [];
        foreach ($histStmt->fetchAll() as $h) {
            $deltas[(int)$h['user_id']] = [
                'rating_before' => (float)$h['rating_before'],
                'rating_after'  => (float)$h['rating_after'],
                'result'        => $h['result'],
            ];
        }
        $result['rating_deltas'] = $deltas;
    }

    return $result;
}

// auth.db から user_id に対応するユーザー名を引く。見つからなければ null。
// users テーブルが未作成の環境でも 500 にせず null を返す（PDOExceptionを握りつぶす）。
function arenaLookupUsername(int $userId): ?string {
    try {
        $authDb = getDB();
        $stmt = $authDb->prepare('SELECT username FROM users WHERE id = ?');
        $stmt->execute([$userId]);
        $row = $stmt->fetch();
        return $row ? (string)$row['username'] : null;
    } catch (PDOException $e) {
        error_log('[arena] user lookup failed: ' . $e->getMessage());
        return null;
    }
}

// POST /v1/matches — 試合作成。
// mode='local' は相手を必須指定して即 drafting へ。
// mode='online' は相手指定を必須としない（room code で誰でも参加できる）。
// opponent_user_id を指定した場合のみ、その相手だけが参加できる招待制になる。
function arenaHandleMatchCreate(array $params, PDO $db): void {
    $user = requireArenaUser();
    $body = arenaReadJsonBody();
    if ($err = arenaCheckAllowedFields($body, ['game', 'ruleset', 'mode', 'opponent_user_id'])) {
        jsonResponse(['success' => false, 'message' => $err], 400);
    }

    $mode = (string)($body['mode'] ?? 'local');
    if (!in_array($mode, ['local', 'online'], true)) {
        jsonResponse(['success' => false, 'message' => 'mode は "local" か "online" にしてください'], 400);
    }

    $gameSlug = trim((string)($body['game'] ?? ''));
    if ($gameSlug === '') {
        jsonResponse(['success' => false, 'message' => 'ゲームを選択してください'], 400);
    }
    $gameStmt = $db->prepare('SELECT * FROM arena_games WHERE slug = ? AND enabled = 1');
    $gameStmt->execute([$gameSlug]);
    $game = $gameStmt->fetch();
    if (!$game) {
        jsonResponse(['success' => false, 'message' => 'ゲームが見つかりません'], 404);
    }

    $rulesetSlug = trim((string)($body['ruleset'] ?? ''));
    if ($rulesetSlug === '') {
        jsonResponse(['success' => false, 'message' => 'ルールセットを選択してください'], 400);
    }
    $rulesetStmt = $db->prepare('SELECT * FROM arena_rulesets WHERE game_id = ? AND slug = ? AND enabled = 1');
    $rulesetStmt->execute([(int)$game['id'], $rulesetSlug]);
    $ruleset = $rulesetStmt->fetch();
    if (!$ruleset) {
        jsonResponse(['success' => false, 'message' => 'ルールセットが見つかりません'], 404);
    }

    $opponentIdRaw = isset($body['opponent_user_id']) && $body['opponent_user_id'] !== ''
        ? (int)$body['opponent_user_id'] : 0;

    if ($mode === 'local') {
        // ローカルモードは同じ画面で交互に打つため相手指定が必須
        if ($opponentIdRaw <= 0) {
            jsonResponse(['success' => false, 'message' => '対戦相手を選択してください'], 400);
        }
        if ($opponentIdRaw === (int)$user['id']) {
            jsonResponse(['success' => false, 'message' => '自分自身を対戦相手にはできません'], 400);
        }
        $opponentName = arenaLookupUsername($opponentIdRaw);
        if ($opponentName === null) {
            jsonResponse(['success' => false, 'message' => '対戦相手が見つかりません'], 404);
        }
        $opponentId = $opponentIdRaw;
    } else {
        // オンラインモード：opponent_user_id は任意。指定時のみ招待制（その相手しか参加できない）
        if ($opponentIdRaw > 0) {
            if ($opponentIdRaw === (int)$user['id']) {
                jsonResponse(['success' => false, 'message' => '自分自身を対戦相手にはできません'], 400);
            }
            $opponentName = arenaLookupUsername($opponentIdRaw);
            if ($opponentName === null) {
                jsonResponse(['success' => false, 'message' => '対戦相手が見つかりません'], 404);
            }
            $opponentId = $opponentIdRaw;
        } else {
            $opponentId = null;
            $opponentName = null;
        }
    }

    $publicId = arenaGenerateMatchPublicId($db);
    $now = time();

    // ローカルモードは相手が既に確定しているので即 drafting へ（turn_deadline は常にNULL）。
    // オンラインモードは waiting のまま public_id（room code）を発行し、
    // 相手の /join を待つ（turn_deadline は join 時に設定する）。
    $status = $mode === 'local' ? 'drafting' : 'waiting';

    $stmt = $db->prepare("
        INSERT INTO arena_matches
            (public_id, game_id, ruleset_id, mode, status, player_a_id, player_a_name, player_b_id, player_b_name,
             turn_index, turn_deadline, version, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 0, ?, ?, ?)
    ");
    $stmt->execute([
        $publicId, (int)$game['id'], (int)$ruleset['id'], $mode, $status,
        (int)$user['id'], $user['username'], $opponentId, $opponentName,
        (int)$user['id'], $now, $now,
    ]);

    $match = arenaLoadMatch($db, $publicId);
    jsonResponse(['success' => true, 'match' => arenaSerializeMatch($db, $match)]);
}

// POST /v1/matches/{public_id}/join — オンライン戦に相手として参加する。
// public_id（room code）さえ知っていれば、招待制でない限り誰でも参加できる。
// 参加していない第三者に試合詳細を見せないよう、事前の arenaRequireMatchAccess は使わない。
function arenaHandleMatchJoin(array $params, PDO $db): void {
    $user = requireArenaUser();
    $publicId = $params['public_id'] ?? '';

    $match = arenaLoadMatch($db, $publicId);
    if (!$match) {
        jsonResponse(['success' => false, 'message' => '試合が見つかりません'], 404);
    }
    if ($match['mode'] !== 'online') {
        jsonResponse(['success' => false, 'message' => 'この試合はオンライン対戦ではありません'], 400);
    }

    $uid = (int)$user['id'];
    if ($uid === (int)$match['player_a_id']) {
        jsonResponse(['success' => false, 'message' => '自分が作成した試合には参加者として参加できません'], 400);
    }
    if ($match['status'] !== 'waiting') {
        jsonResponse(['success' => false, 'message' => 'この試合はすでに開始しているか、参加者を募集していません'], 400);
    }
    if ($match['player_b_id'] !== null && (int)$match['player_b_id'] !== $uid) {
        jsonResponse(['success' => false, 'message' => 'この試合は招待制のため参加できません'], 403);
    }

    $ruleset = arenaLoadRuleset($db, (int)$match['ruleset_id']);
    if (!$ruleset) {
        jsonResponse(['success' => false, 'message' => 'ルールセットが見つかりません'], 404);
    }

    $now = time();
    $deadline = (int)$ruleset['turn_seconds'] > 0 ? $now + (int)$ruleset['turn_seconds'] : null;

    $db->exec('BEGIN IMMEDIATE');
    try {
        // ロック取得後に再確認（同時参加のTOCTOU対策）
        $checkStmt = $db->prepare('SELECT status, player_a_id, player_b_id FROM arena_matches WHERE id = ?');
        $checkStmt->execute([(int)$match['id']]);
        $fresh = $checkStmt->fetch();
        $freshBId = $fresh['player_b_id'] !== null ? (int)$fresh['player_b_id'] : null;
        if (
            !$fresh
            || $fresh['status'] !== 'waiting'
            || (int)$fresh['player_a_id'] === $uid
            || ($freshBId !== null && $freshBId !== $uid)
        ) {
            $db->exec('ROLLBACK');
            jsonResponse(['success' => false, 'message' => 'この試合には参加できません'], 409);
        }

        $upd = $db->prepare("
            UPDATE arena_matches
            SET player_b_id = ?, player_b_name = ?, status = 'drafting',
                turn_index = 0, turn_deadline = ?, version = version + 1, updated_at = ?
            WHERE id = ?
        ");
        $upd->execute([$uid, $user['username'], $deadline, $now, (int)$match['id']]);

        $db->exec('COMMIT');
    } catch (Throwable $e) {
        $db->exec('ROLLBACK');
        throw $e;
    }

    $match = arenaLoadMatch($db, $publicId);
    jsonResponse(['success' => true, 'match' => arenaSerializeMatch($db, $match)]);
}

// GET /v1/matches — 自分が参加している試合の一覧
function arenaHandleMatchList(array $params, PDO $db): void {
    $user = requireArenaUser();
    $uid = (int)$user['id'];

    $status   = isset($_GET['status']) && $_GET['status'] !== '' ? (string)$_GET['status'] : null;
    $gameSlug = isset($_GET['game']) && $_GET['game'] !== '' ? (string)$_GET['game'] : null;
    $limit    = isset($_GET['limit']) ? max(1, min(100, (int)$_GET['limit'])) : 20;
    $offset   = isset($_GET['offset']) ? max(0, (int)$_GET['offset']) : 0;

    $sql = 'SELECT m.* FROM arena_matches m WHERE (m.player_a_id = ? OR m.player_b_id = ?)';
    $args = [$uid, $uid];
    if ($status !== null) {
        $sql .= ' AND m.status = ?';
        $args[] = $status;
    }
    if ($gameSlug !== null) {
        $sql .= ' AND m.game_id = (SELECT id FROM arena_games WHERE slug = ?)';
        $args[] = $gameSlug;
    }
    $sql .= ' ORDER BY m.updated_at DESC LIMIT ? OFFSET ?';
    $args[] = $limit;
    $args[] = $offset;

    $stmt = $db->prepare($sql);
    $stmt->execute($args);
    $rows = $stmt->fetchAll();

    $matches = [];
    foreach ($rows as $row) {
        // 48h自動承認のみ適用（タイムアウト自動選択は一覧ではなく詳細取得時に処理する）
        $row = arenaMaybeAutoConfirm($db, $row);
        $matches[] = arenaSerializeMatch($db, $row);
    }

    jsonResponse(['success' => true, 'matches' => $matches]);
}

// GET /v1/matches/{public_id} — 試合詳細
function arenaHandleMatchGet(array $params, PDO $db): void {
    $user = requireArenaUser();
    $match = arenaRequireMatchAccess($db, $params['public_id'] ?? '', $user);
    $match = arenaRefreshMatchForRead($db, $match);

    jsonResponse(['success' => true, 'match' => arenaSerializeMatch($db, $match)]);
}

// GET /v1/matches/{public_id}/draft?since=N — ドラフト状態。
// 遅延タイムアウト処理を version 比較の前に必ず通す（そうしないと期限切れの手番が
// ポーラーから見えないまま放置される）。version <= since ならボディ無しの 304 を返し、
// その場合は arenaDraftState()/arenaSerializeMatch() を一切呼ばない（ポーリングを軽く保つ）。
function arenaHandleMatchDraftGet(array $params, PDO $db): void {
    $user = requireArenaUser();
    $match = arenaRequireMatchAccess($db, $params['public_id'] ?? '', $user);
    $match = arenaRefreshMatchForRead($db, $match);

    $since = isset($_GET['since']) && is_numeric($_GET['since']) ? (int)$_GET['since'] : -1;
    if ((int)$match['version'] <= $since) {
        http_response_code(304);
        exit;
    }

    $ruleset = arenaLoadRuleset($db, (int)$match['ruleset_id']);
    if (!$ruleset) {
        jsonResponse(['success' => false, 'message' => 'ルールセットが見つかりません'], 404);
    }

    jsonResponse([
        'success' => true,
        'match'   => arenaSerializeMatch($db, $match),
        'draft'   => arenaDraftState($db, $match, $ruleset),
    ]);
}

// POST /v1/matches/{public_id}/draft — BAN/PICK実行 {seq, action, entry_id}
function arenaHandleMatchDraftPost(array $params, PDO $db): void {
    $user = requireArenaUser();
    $match = arenaRequireMatchAccess($db, $params['public_id'] ?? '', $user);

    $body = arenaReadJsonBody();
    if ($err = arenaCheckAllowedFields($body, ['seq', 'action', 'entry_id'])) {
        jsonResponse(['success' => false, 'message' => $err], 400);
    }
    if (!isset($body['seq']) || !is_numeric($body['seq'])) {
        jsonResponse(['success' => false, 'message' => 'seq を指定してください'], 400);
    }
    $seq = (int)$body['seq'];

    $action = (string)($body['action'] ?? '');
    if (!in_array($action, ['ban', 'pick'], true)) {
        jsonResponse(['success' => false, 'message' => 'action は "ban" か "pick" にしてください'], 400);
    }

    if (!isset($body['entry_id']) || !is_numeric($body['entry_id'])) {
        jsonResponse(['success' => false, 'message' => 'entry_id を指定してください'], 400);
    }
    $entryId = (int)$body['entry_id'];

    $ruleset = arenaLoadRuleset($db, (int)$match['ruleset_id']);
    if (!$ruleset) {
        jsonResponse(['success' => false, 'message' => 'ルールセットが見つかりません'], 404);
    }

    try {
        $match = arenaApplyAction($db, $match, $ruleset, $user, $seq, $action, $entryId);
    } catch (ArenaDraftError $e) {
        jsonResponse(['success' => false, 'message' => $e->getMessage()], $e->status);
    }

    jsonResponse([
        'success' => true,
        'match'   => arenaSerializeMatch($db, $match),
        'draft'   => arenaDraftState($db, $match, $ruleset),
    ]);
}

// POST /v1/matches/{public_id}/result — 結果申告 {winner:'A'|'B', score_a, score_b}
function arenaHandleMatchResult(array $params, PDO $db): void {
    $user = requireArenaUser();
    $match = arenaRequireMatchAccess($db, $params['public_id'] ?? '', $user);
    $match = arenaMaybeAutoConfirm($db, $match);

    if (!in_array($match['status'], ['playing', 'reported'], true)) {
        $msg = $match['status'] === 'finished'
            ? 'この試合は既に確定しています'
            : 'この試合はまだ結果を申告できる状態ではありません';
        jsonResponse(['success' => false, 'message' => $msg], 400);
    }

    $body = arenaReadJsonBody();
    if ($err = arenaCheckAllowedFields($body, ['winner', 'score_a', 'score_b'])) {
        jsonResponse(['success' => false, 'message' => $err], 400);
    }
    $winner = (string)($body['winner'] ?? '');
    if (!in_array($winner, ['A', 'B'], true)) {
        jsonResponse(['success' => false, 'message' => 'winner は "A" か "B" にしてください'], 400);
    }
    $scoreA = isset($body['score_a']) && is_numeric($body['score_a']) ? max(0, (int)$body['score_a']) : 0;
    $scoreB = isset($body['score_b']) && is_numeric($body['score_b']) ? max(0, (int)$body['score_b']) : 0;

    $now = time();
    $stmt = $db->prepare("
        UPDATE arena_matches
        SET status = 'reported', winner_side = ?, score_a = ?, score_b = ?, reported_by = ?, confirmed_by = NULL, updated_at = ?
        WHERE id = ?
    ");
    $stmt->execute([$winner, $scoreA, $scoreB, (int)$user['id'], $now, (int)$match['id']]);

    $match = arenaLoadMatch($db, $match['public_id']);
    jsonResponse(['success' => true, 'match' => arenaSerializeMatch($db, $match)]);
}

// POST /v1/matches/{public_id}/confirm — 相手が結果を承認 → Elo確定
function arenaHandleMatchConfirm(array $params, PDO $db): void {
    $user = requireArenaUser();
    $match = arenaRequireMatchAccess($db, $params['public_id'] ?? '', $user);
    // 既に48h経過していれば、相手がここに来る前に自動承認されている場合がある
    $match = arenaMaybeAutoConfirm($db, $match);

    if ($match['status'] === 'finished') {
        jsonResponse(['success' => false, 'message' => 'この試合は既に確定しています'], 400);
    }
    if ($match['status'] !== 'reported') {
        jsonResponse(['success' => false, 'message' => 'まだ結果が申告されていません'], 400);
    }
    if ((int)$match['reported_by'] === (int)$user['id']) {
        jsonResponse(['success' => false, 'message' => '自分の申告は自分では承認できません。相手のアカウントで承認してください'], 403);
    }

    $match = arenaApplyMatchResult($db, $match, (int)$user['id']);
    jsonResponse(['success' => true, 'match' => arenaSerializeMatch($db, $match)]);
}

// POST /v1/matches/{public_id}/cancel — 中止
function arenaHandleMatchCancel(array $params, PDO $db): void {
    $user = requireArenaUser();
    $match = arenaRequireMatchAccess($db, $params['public_id'] ?? '', $user);

    if (!in_array($match['status'], ['waiting', 'drafting', 'playing'], true)) {
        jsonResponse(['success' => false, 'message' => 'この試合は中止できません'], 400);
    }

    $now = time();
    $db->prepare("UPDATE arena_matches SET status = 'cancelled', updated_at = ? WHERE id = ?")
       ->execute([$now, (int)$match['id']]);

    $match = arenaLoadMatch($db, $match['public_id']);
    jsonResponse(['success' => true, 'match' => arenaSerializeMatch($db, $match)]);
}
