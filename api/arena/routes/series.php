<?php
// /v1/series 系ハンドラ（シリーズ作成・一覧・詳細・join・ルーレット・タイトルドラフト・中止）。
// リクエストボディの読み取り・許可フィールドチェックは routes/admin.php の
// arenaReadJsonBody() / arenaCheckAllowedFields() を再利用する。
// 旧 routes/match.php（キャラクターBAN/PICK単体試合）の置き換え。

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

// public_id からシリーズを取得し、参加者本人（player1/player2 のどちらか）であることを
// サーバー側で確認する。それ以外は 404/403 を返して終了する。
// クライアントが送ってくる user id は一切信用しない（常にセッションの $user を使う）。
function arenaRequireSeriesAccess(PDO $db, string $publicId, array $user): array {
    $series = arenaLoadSeries($db, $publicId);
    if (!$series) {
        jsonResponse(['success' => false, 'message' => 'シリーズが見つかりません'], 404);
    }
    $uid = (int)$user['id'];
    $p2  = $series['player2_id'] !== null ? (int)$series['player2_id'] : null;
    if ($uid !== (int)$series['player1_id'] && $uid !== $p2) {
        jsonResponse(['success' => false, 'message' => 'このシリーズを閲覧・操作する権限がありません'], 403);
    }
    return $series;
}

// クライアント向けにシリーズ1件をシリアライズする（対戦カード等の詳細は arenaSeriesState() 側）。
function arenaSerializeSeries(PDO $db, array $series): array {
    $format = arenaLoadFormat($db, (int)$series['format_id']);

    return [
        'public_id'      => $series['public_id'],
        'mode'           => $series['mode'],
        'status'         => $series['status'],
        'format'         => $format ? [
            'slug'         => $format['slug'],
            'name'         => $format['name'],
            'pool_size'    => (int)$format['pool_size'],
            'wins_needed'  => (int)$format['wins_needed'],
            'turn_seconds' => (int)$format['turn_seconds'],
            'sequence'     => $format['sequence_decoded'],
        ] : null,
        'player1_id'     => (int)$series['player1_id'],
        'player1_name'   => $series['player1_name'],
        'player2_id'     => $series['player2_id'] !== null ? (int)$series['player2_id'] : null,
        'player2_name'   => $series['player2_name'],
        'side_a_user_id' => $series['side_a_user_id'] !== null ? (int)$series['side_a_user_id'] : null,
        'side_b_user_id' => $series['side_b_user_id'] !== null ? (int)$series['side_b_user_id'] : null,
        'roulette_at'    => $series['roulette_at'] !== null ? (int)$series['roulette_at'] : null,
        // 先手後手の決め方（シリーズEloの差で ルーレット / 低いほうが選択 に分岐）
        'side_decision'  => arenaSeriesSideDecision($db, $series),
        'turn_index'     => (int)$series['turn_index'],
        'turn_deadline'  => $series['turn_deadline'] !== null ? (int)$series['turn_deadline'] : null,
        'version'        => (int)$series['version'],
        'wins_a'         => (int)$series['wins_a'],
        'wins_b'         => (int)$series['wins_b'],
        'winner_side'    => $series['winner_side'],
        'created_by'     => (int)$series['created_by'],
        'created_at'     => (int)$series['created_at'],
        'updated_at'     => (int)$series['updated_at'],
        'finished_at'    => $series['finished_at'] !== null ? (int)$series['finished_at'] : null,
    ];
}

// POST /v1/series — シリーズ作成 {format, mode, opponent_user_id?, game_slugs?}
//
// プールの既定値:
//   - game_slugs を明示指定した場合はそれをそのまま使う（enabled なタイトルのみ）
//   - opponent_user_id が判明している場合は「自分と相手の両方が所持しているタイトル」
//   - まだ相手が判明していない online（招待なし）は「自分が所持しているタイトル」
// いずれの場合も、確定したプールのタイトル数が format.pool_size とちょうど一致しなければ 400。
function arenaHandleSeriesCreate(array $params, PDO $db): void {
    $user = arenaActor($db, 'write');
    $body = arenaReadJsonBody();
    if ($err = arenaCheckAllowedFields($body, ['format', 'mode', 'opponent_user_id', 'game_slugs'])) {
        jsonResponse(['success' => false, 'message' => $err], 400);
    }

    $mode = (string)($body['mode'] ?? 'local');
    if (!in_array($mode, ['local', 'online'], true)) {
        jsonResponse(['success' => false, 'message' => 'mode は "local" か "online" にしてください'], 400);
    }

    $formatSlug = trim((string)($body['format'] ?? ''));
    if ($formatSlug === '') {
        jsonResponse(['success' => false, 'message' => 'フォーマットを選択してください'], 400);
    }
    $fmtStmt = $db->prepare('SELECT * FROM arena_formats WHERE slug = ? AND enabled = 1');
    $fmtStmt->execute([$formatSlug]);
    $format = $fmtStmt->fetch();
    if (!$format) {
        jsonResponse(['success' => false, 'message' => 'フォーマットが見つかりません'], 404);
    }
    $poolSize = (int)$format['pool_size'];

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

    // ── プールの決定 ──
    if (isset($body['game_slugs'])) {
        if (!is_array($body['game_slugs'])) {
            jsonResponse(['success' => false, 'message' => 'game_slugs は配列で指定してください'], 400);
        }
        $slugs = array_values(array_unique(array_map('strval', $body['game_slugs'])));
        if (empty($slugs)) {
            $poolGameIds = [];
        } else {
            $placeholders = implode(',', array_fill(0, count($slugs), '?'));
            $idStmt = $db->prepare("SELECT id FROM arena_games WHERE enabled = 1 AND slug IN ($placeholders)");
            $idStmt->execute($slugs);
            $poolGameIds = array_map('intval', array_column($idStmt->fetchAll(), 'id'));
        }
    } elseif ($opponentId !== null) {
        $stmt = $db->prepare('
            SELECT id FROM arena_games WHERE enabled = 1
              AND id IN (SELECT game_id FROM arena_user_games WHERE user_id = ?)
              AND id IN (SELECT game_id FROM arena_user_games WHERE user_id = ?)
        ');
        $stmt->execute([(int)$user['id'], $opponentId]);
        $poolGameIds = array_map('intval', array_column($stmt->fetchAll(), 'id'));
    } else {
        $stmt = $db->prepare('
            SELECT id FROM arena_games WHERE enabled = 1
              AND id IN (SELECT game_id FROM arena_user_games WHERE user_id = ?)
        ');
        $stmt->execute([(int)$user['id']]);
        $poolGameIds = array_map('intval', array_column($stmt->fetchAll(), 'id'));
    }

    if (count($poolGameIds) !== $poolSize) {
        jsonResponse([
            'success' => false,
            'message' => "対戦タイトルのプールはちょうど {$poolSize} 個である必要があります（現在 " . count($poolGameIds) . ' 個）',
        ], 400);
    }

    $publicId = arenaGenerateSeriesPublicId($db);
    $now = time();
    // local: 相手が既に確定しているのでルーレット待ちへ即遷移。
    // online: join を待つ（招待制かどうかに関わらず、参加者が実際に参加するまでは waiting）。
    $status = $mode === 'local' ? 'roulette' : 'waiting';

    $db->beginTransaction();
    try {
        $stmt = $db->prepare('
            INSERT INTO arena_series
                (public_id, format_id, mode, status, player1_id, player1_name, player2_id, player2_name,
                 turn_index, turn_deadline, version, wins_a, wins_b, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 0, 0, 0, ?, ?, ?)
        ');
        $stmt->execute([
            $publicId, (int)$format['id'], $mode, $status,
            (int)$user['id'], $user['username'], $opponentId, $opponentName,
            (int)$user['id'], $now, $now,
        ]);
        $seriesId = (int)$db->lastInsertId();

        $poolStmt = $db->prepare('INSERT INTO arena_series_pool (series_id, game_id) VALUES (?, ?)');
        foreach ($poolGameIds as $gid) {
            $poolStmt->execute([$seriesId, $gid]);
        }

        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        throw $e;
    }

    $series = arenaLoadSeries($db, $publicId);
    jsonResponse(['success' => true, 'series' => arenaSerializeSeries($db, $series)]);
}

// GET /v1/series — 自分が参加しているシリーズの一覧
function arenaHandleSeriesList(array $params, PDO $db): void {
    $user = arenaActor($db, 'read');
    $uid = (int)$user['id'];

    $status = isset($_GET['status']) && $_GET['status'] !== '' ? (string)$_GET['status'] : null;
    $limit  = isset($_GET['limit']) ? max(1, min(100, (int)$_GET['limit'])) : 20;
    $offset = isset($_GET['offset']) ? max(0, (int)$_GET['offset']) : 0;

    $sql = 'SELECT * FROM arena_series WHERE (player1_id = ? OR player2_id = ?)';
    $args = [$uid, $uid];
    if ($status !== null) {
        $sql .= ' AND status = ?';
        $args[] = $status;
    }
    $sql .= ' ORDER BY updated_at DESC LIMIT ? OFFSET ?';
    $args[] = $limit;
    $args[] = $offset;

    $stmt = $db->prepare($sql);
    $stmt->execute($args);

    $series = array_map(function ($row) use ($db) {
        return arenaSerializeSeries($db, $row);
    }, $stmt->fetchAll());

    jsonResponse(['success' => true, 'series' => $series]);
}

// GET /v1/series/{public_id} — シリーズ詳細（ドラフト状態込み）
function arenaHandleSeriesGet(array $params, PDO $db): void {
    $user = arenaActor($db, 'read');
    $series = arenaRequireSeriesAccess($db, $params['public_id'] ?? '', $user);

    $format = arenaLoadFormat($db, (int)$series['format_id']);
    if ($format && $series['status'] === 'drafting') {
        $series = arenaApplySeriesTimeouts($db, $series, $format);
    }
    // 48時間承認されなかった申告をここで自動確定させる（cron不要の遅延評価）
    if ($series['status'] === 'playing' && arenaMaybeAutoConfirmSeriesGames($db, $series)) {
        $series = arenaLoadSeries($db, $series['public_id']);
    }

    jsonResponse([
        'success' => true,
        'series'  => arenaSerializeSeries($db, $series),
        'draft'   => $format ? arenaSeriesState($db, $series, $format) : null,
    ]);
}

// POST /v1/series/{public_id}/join — オンライン戦に相手として参加する。
// public_id（room code）さえ知っていれば、招待制でない限り誰でも参加できる。
// 参加していない第三者に詳細を見せないよう、事前の arenaRequireSeriesAccess は使わない。
function arenaHandleSeriesJoin(array $params, PDO $db): void {
    $user = arenaActor($db, 'write');
    $publicId = $params['public_id'] ?? '';

    $series = arenaLoadSeries($db, $publicId);
    if (!$series) {
        jsonResponse(['success' => false, 'message' => 'シリーズが見つかりません'], 404);
    }
    if ($series['mode'] !== 'online') {
        jsonResponse(['success' => false, 'message' => 'このシリーズはオンライン対戦ではありません'], 400);
    }

    $uid = (int)$user['id'];
    if ($uid === (int)$series['player1_id']) {
        jsonResponse(['success' => false, 'message' => '自分が作成したシリーズには参加者として参加できません'], 400);
    }
    if ($series['status'] !== 'waiting') {
        jsonResponse(['success' => false, 'message' => 'このシリーズはすでに開始しているか、参加者を募集していません'], 400);
    }
    if ($series['player2_id'] !== null && (int)$series['player2_id'] !== $uid) {
        jsonResponse(['success' => false, 'message' => 'このシリーズは招待制のため参加できません'], 403);
    }

    $now = time();
    $conflict = false;

    $db->exec('BEGIN IMMEDIATE');
    try {
        // ロック取得後に再確認（同時参加のTOCTOU対策）
        $checkStmt = $db->prepare('SELECT status, player1_id, player2_id FROM arena_series WHERE id = ?');
        $checkStmt->execute([(int)$series['id']]);
        $fresh = $checkStmt->fetch();
        $freshP2 = $fresh['player2_id'] !== null ? (int)$fresh['player2_id'] : null;
        if (!$fresh || $fresh['status'] !== 'waiting' || (int)$fresh['player1_id'] === $uid || ($freshP2 !== null && $freshP2 !== $uid)) {
            $conflict = true;
        } else {
            $upd = $db->prepare("
                UPDATE arena_series
                SET player2_id = ?, player2_name = ?, status = 'roulette', version = version + 1, updated_at = ?
                WHERE id = ?
            ");
            $upd->execute([$uid, $user['username'], $now, (int)$series['id']]);
        }
        $db->exec('COMMIT');
    } catch (Throwable $e) {
        if ($db->inTransaction()) {
            $db->exec('ROLLBACK');
        }
        throw $e;
    }

    if ($conflict) {
        jsonResponse(['success' => false, 'message' => 'このシリーズには参加できません'], 409);
    }

    $series = arenaLoadSeries($db, $publicId);
    jsonResponse(['success' => true, 'series' => arenaSerializeSeries($db, $series)]);
}

// POST /v1/series/{public_id}/roulette — A/B（先手後手）決定。再抽選は不可。
function arenaHandleSeriesRoulette(array $params, PDO $db): void {
    $user = arenaActor($db, 'write');
    $series = arenaRequireSeriesAccess($db, $params['public_id'] ?? '', $user);

    try {
        $series = arenaSeriesRoulette($db, $series, $user);
    } catch (ArenaDraftError $e) {
        jsonResponse(['success' => false, 'message' => $e->getMessage()], $e->status);
    }

    jsonResponse(['success' => true, 'series' => arenaSerializeSeries($db, $series)]);
}

// POST /v1/series/{public_id}/choose-side — レートが低いほうが先行/後行を選ぶ {side:'A'|'B'}
function arenaHandleSeriesChooseSide(array $params, PDO $db): void {
    $user   = arenaActor($db, 'write');
    $series = arenaRequireSeriesAccess($db, $params['public_id'] ?? '', $user);

    $body = arenaReadJsonBody();
    if ($err = arenaCheckAllowedFields($body, ['side'])) {
        jsonResponse(['success' => false, 'message' => $err], 400);
    }

    try {
        $series = arenaSeriesChooseSide($db, $series, $user, (string)($body['side'] ?? ''));
    } catch (ArenaDraftError $e) {
        jsonResponse(['success' => false, 'message' => $e->getMessage()], $e->status);
    }

    $format = arenaLoadFormat($db, (int)$series['format_id']);
    jsonResponse([
        'success' => true,
        'series'  => arenaSerializeSeries($db, $series),
        'draft'   => $format ? arenaSeriesState($db, $series, $format) : null,
    ]);
}

// GET /v1/series/{public_id}/draft?since=N — タイトルドラフト状態。
// 遅延タイムアウト処理を version 比較の前に必ず通す（そうしないと期限切れの手番が
// ポーラーから見えないまま放置される）。version <= since ならボディ無しの 304 を返し、
// その場合は arenaSeriesState() を一切呼ばない（ポーリングを軽く保つ）。
function arenaHandleSeriesDraftGet(array $params, PDO $db): void {
    $user = arenaActor($db, 'read');
    $series = arenaRequireSeriesAccess($db, $params['public_id'] ?? '', $user);

    $format = arenaLoadFormat($db, (int)$series['format_id']);
    if (!$format) {
        jsonResponse(['success' => false, 'message' => 'フォーマットが見つかりません'], 404);
    }
    $series = arenaApplySeriesTimeouts($db, $series, $format);

    $since = isset($_GET['since']) && is_numeric($_GET['since']) ? (int)$_GET['since'] : -1;
    if ((int)$series['version'] <= $since) {
        http_response_code(304);
        exit;
    }

    jsonResponse([
        'success' => true,
        'series'  => arenaSerializeSeries($db, $series),
        'draft'   => arenaSeriesState($db, $series, $format),
    ]);
}

// POST /v1/series/{public_id}/draft — BAN/PICK実行 {seq, action, game_id}
function arenaHandleSeriesDraftPost(array $params, PDO $db): void {
    $user = arenaActor($db, 'write');
    $series = arenaRequireSeriesAccess($db, $params['public_id'] ?? '', $user);

    $body = arenaReadJsonBody();
    if ($err = arenaCheckAllowedFields($body, ['seq', 'action', 'game_id'])) {
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

    if (!isset($body['game_id']) || !is_numeric($body['game_id'])) {
        jsonResponse(['success' => false, 'message' => 'game_id を指定してください'], 400);
    }
    $gameId = (int)$body['game_id'];

    $format = arenaLoadFormat($db, (int)$series['format_id']);
    if (!$format) {
        jsonResponse(['success' => false, 'message' => 'フォーマットが見つかりません'], 404);
    }

    try {
        $series = arenaApplySeriesAction($db, $series, $format, $user, $seq, $action, $gameId);
    } catch (ArenaDraftError $e) {
        jsonResponse(['success' => false, 'message' => $e->getMessage()], $e->status);
    }

    jsonResponse([
        'success' => true,
        'series'  => arenaSerializeSeries($db, $series),
        'draft'   => arenaSeriesState($db, $series, $format),
    ]);
}

// POST /v1/series/{public_id}/cancel — 中止
function arenaHandleSeriesCancel(array $params, PDO $db): void {
    $user = arenaActor($db, 'write');
    $series = arenaRequireSeriesAccess($db, $params['public_id'] ?? '', $user);

    if (!in_array($series['status'], ['waiting', 'roulette', 'drafting', 'playing'], true)) {
        jsonResponse(['success' => false, 'message' => 'このシリーズは中止できません'], 400);
    }

    $now = time();
    $db->prepare("UPDATE arena_series SET status = 'cancelled', updated_at = ? WHERE id = ?")
       ->execute([$now, (int)$series['id']]);

    $series = arenaLoadSeries($db, $series['public_id']);
    jsonResponse(['success' => true, 'series' => arenaSerializeSeries($db, $series)]);
}
