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

// ── Phase 6: フィアレス／BO3 シリーズ ────────────────────────────
// series_id も public_id と同じ「8文字の16進数」方式で発行する（衝突時は再試行）。
// series_id はどのテーブルにも UNIQUE 制約が無い（1シリーズに複数 match 行がぶら下がる
// ため当然UNIQUEには出来ない）ので、既存の arena_matches.series_id と衝突しないことだけ
// 確認する。

function arenaGenerateSeriesId(PDO $db): string {
    for ($i = 0; $i < 10; $i++) {
        $candidate = bin2hex(random_bytes(4));
        $stmt = $db->prepare('SELECT 1 FROM arena_matches WHERE series_id = ?');
        $stmt->execute([$candidate]);
        if (!$stmt->fetchColumn()) {
            return $candidate;
        }
    }
    throw new RuntimeException('series_id の生成に失敗しました');
}

// スキーマは変更しないため、シリーズの「BO3/BO5」設定は arena_meta の汎用KVに
// `arena_series_bestof:<series_id>` キーで持たせる（arena_meta は Phase 1 から
// この用途向けに用意されている KVストア）。未設定（=単発試合）なら 1 を返す。
function arenaSeriesBestOf(PDO $db, string $seriesId): int {
    $v = arenaMetaGet($db, 'arena_series_bestof:' . $seriesId);
    if ($v === null) {
        return 1;
    }
    $n = (int)$v;
    return in_array($n, [1, 3, 5], true) ? $n : 1;
}

function arenaSeriesSetBestOf(PDO $db, string $seriesId, int $bestOf): void {
    arenaMetaSet($db, 'arena_series_bestof:' . $seriesId, (string)$bestOf);
}

// シリーズの決着に必要な勝利数（BO3なら2、BO5なら3）
function arenaSeriesWinsNeeded(int $bestOf): int {
    return intdiv($bestOf, 2) + 1;
}

// シリーズの軽量サマリ（勝敗数・決着済みか）。arenaSerializeMatch に埋め込む用と
// /v1/matches 作成時の検証用の両方から使う。試合本体の一覧は含めない
// （一覧が必要な場合は arenaHandleSeriesGet 側で別途組み立てる）。
function arenaSeriesSummary(PDO $db, string $seriesId): ?array {
    $stmt = $db->prepare('
        SELECT id, status, winner_side, player_a_id, player_a_name, player_b_id, player_b_name
        FROM arena_matches WHERE series_id = ? ORDER BY created_at ASC, id ASC
    ');
    $stmt->execute([$seriesId]);
    $rows = $stmt->fetchAll();
    if (empty($rows)) {
        return null;
    }
    $first = $rows[0];

    $winsA = 0;
    $winsB = 0;
    $gamesFinished = 0;
    foreach ($rows as $r) {
        if ($r['status'] === 'finished') {
            $gamesFinished++;
            if ($r['winner_side'] === 'A') {
                $winsA++;
            } elseif ($r['winner_side'] === 'B') {
                $winsB++;
            }
        }
    }

    $bestOf = arenaSeriesBestOf($db, $seriesId);
    $winsNeeded = arenaSeriesWinsNeeded($bestOf);

    return [
        'series_id'      => $seriesId,
        'best_of'        => $bestOf,
        'wins_needed'    => $winsNeeded,
        'player_a_id'    => (int)$first['player_a_id'],
        'player_a_name'  => $first['player_a_name'],
        'player_b_id'    => $first['player_b_id'] !== null ? (int)$first['player_b_id'] : null,
        'player_b_name'  => $first['player_b_name'],
        'wins_a'         => $winsA,
        'wins_b'         => $winsB,
        'games_played'   => count($rows),
        'games_finished' => $gamesFinished,
        'is_over'        => $winsA >= $winsNeeded || $winsB >= $winsNeeded,
    ];
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

// クライアント向けに試合1件をシリアライズする（ゲーム/ルールセット情報・確定時はレート増減を含む）。
// $includeSeries: series_id がある試合について arenaSeriesSummary() を埋め込むか。
// 一覧系エンドポイント（/v1/matches, /v1/players/{id} の recent_matches）は
// 1リクエストで多数の match 行を返すため false にして N+1 気味の追加クエリを避け、
// 単体取得系（GET/POST /v1/matches/{id}, /draft, /confirm 等）は true のままにする。
function arenaSerializeMatch(PDO $db, array $match, bool $includeSeries = true): array {
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
        'series_id'     => $match['series_id'] ?? null,
    ];

    // フィアレス／BO3 シリーズ（Phase 6）。series_id が無い通常試合では null のまま。
    if ($includeSeries && !empty($match['series_id'])) {
        $result['series'] = arenaSeriesSummary($db, (string)$match['series_id']);
    } else {
        $result['series'] = null;
    }

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
//
// Phase 6: best_of（1/3/5、省略時1）と series_id を追加で受け付ける。
// - series_id を省略して best_of>1 を指定 → 新しいシリーズを発行して1試合目を作る。
// - series_id を指定 → 既存シリーズへの続き（2試合目以降）を作る。この場合
//   game/ruleset/mode/opponent_user_id/best_of は無視し、シリーズ1試合目の内容を
//   そのまま引き継ぐ（対戦カードやフィアレス判定を一貫させるため）。
function arenaHandleMatchCreate(array $params, PDO $db): void {
    $user = arenaActor($db, 'write');
    $body = arenaReadJsonBody();
    if ($err = arenaCheckAllowedFields($body, ['game', 'ruleset', 'mode', 'opponent_user_id', 'best_of', 'series_id'])) {
        jsonResponse(['success' => false, 'message' => $err], 400);
    }

    $seriesIdRaw = isset($body['series_id']) ? trim((string)$body['series_id']) : '';

    if ($seriesIdRaw !== '') {
        arenaHandleMatchCreateSeriesContinuation($db, $user, $seriesIdRaw);
        return;
    }

    $mode = (string)($body['mode'] ?? 'local');
    if (!in_array($mode, ['local', 'online'], true)) {
        jsonResponse(['success' => false, 'message' => 'mode は "local" か "online" にしてください'], 400);
    }

    $bestOf = isset($body['best_of']) && $body['best_of'] !== '' ? (int)$body['best_of'] : 1;
    if (!in_array($bestOf, [1, 3, 5], true)) {
        jsonResponse(['success' => false, 'message' => 'best_of は 1・3・5 のいずれかにしてください'], 400);
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

    // best_of > 1 のときだけシリーズを発行する（単発試合は従来どおり series_id = NULL）
    $seriesId = null;
    if ($bestOf > 1) {
        $seriesId = arenaGenerateSeriesId($db);
        arenaSeriesSetBestOf($db, $seriesId, $bestOf);
    }

    $stmt = $db->prepare("
        INSERT INTO arena_matches
            (public_id, game_id, ruleset_id, mode, status, player_a_id, player_a_name, player_b_id, player_b_name,
             turn_index, turn_deadline, version, series_id, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 0, ?, ?, ?, ?)
    ");
    $stmt->execute([
        $publicId, (int)$game['id'], (int)$ruleset['id'], $mode, $status,
        (int)$user['id'], $user['username'], $opponentId, $opponentName,
        $seriesId, (int)$user['id'], $now, $now,
    ]);

    $match = arenaLoadMatch($db, $publicId);
    jsonResponse(['success' => true, 'match' => arenaSerializeMatch($db, $match)]);
}

// 既存シリーズへの続き（2試合目以降）を作成する。1試合目の game/ruleset/mode/対戦カードを
// そのまま引き継ぐ。呼び出し元の actor はシリーズの参加者（player_a または player_b）で
// なければならない。オンラインモードでも既に両者が判明しているため waiting/join を
// 経由せず即 drafting にする。
function arenaHandleMatchCreateSeriesContinuation(PDO $db, array $user, string $seriesId): void {
    if (!preg_match('/^[a-f0-9]{8}$/', $seriesId)) {
        jsonResponse(['success' => false, 'message' => 'series_id の形式が正しくありません'], 400);
    }

    $summary = arenaSeriesSummary($db, $seriesId);
    if ($summary === null) {
        jsonResponse(['success' => false, 'message' => 'シリーズが見つかりません'], 404);
    }

    $uid = (int)$user['id'];
    if ($uid !== $summary['player_a_id'] && $uid !== $summary['player_b_id']) {
        jsonResponse(['success' => false, 'message' => 'このシリーズに参加する権限がありません'], 403);
    }
    if ($summary['player_b_id'] === null) {
        jsonResponse(['success' => false, 'message' => 'まだ対戦相手が確定していません'], 400);
    }
    if ($summary['is_over']) {
        jsonResponse(['success' => false, 'message' => 'このシリーズは既に決着しています'], 400);
    }

    // 同シリーズ内に進行中（waiting/drafting/playing/reported）の試合が残っていないか確認する。
    // これが無いと、前の試合の決着を待たずに次の試合を作れてしまい、同じシリーズに
    // 複数の試合が同時並行してしまう（フィアレスの除外集合や勝敗カウントが壊れる）。
    $activeStmt = $db->prepare("
        SELECT 1 FROM arena_matches
        WHERE series_id = ? AND status IN ('waiting', 'drafting', 'playing', 'reported')
        LIMIT 1
    ");
    $activeStmt->execute([$seriesId]);
    if ($activeStmt->fetchColumn()) {
        jsonResponse(['success' => false, 'message' => 'このシリーズの前の試合がまだ進行中です'], 400);
    }

    // 1試合目（アンカー）から game_id / ruleset_id / mode を引き継ぐ
    $anchorStmt = $db->prepare('
        SELECT game_id, ruleset_id, mode FROM arena_matches
        WHERE series_id = ? ORDER BY created_at ASC, id ASC LIMIT 1
    ');
    $anchorStmt->execute([$seriesId]);
    $anchor = $anchorStmt->fetch();
    if (!$anchor) {
        jsonResponse(['success' => false, 'message' => 'シリーズが見つかりません'], 404);
    }

    $ruleset = arenaLoadRuleset($db, (int)$anchor['ruleset_id']);
    if (!$ruleset) {
        jsonResponse(['success' => false, 'message' => 'ルールセットが見つかりません'], 404);
    }

    $publicId = arenaGenerateMatchPublicId($db);
    $now = time();
    $mode = (string)$anchor['mode'];
    // 続き試合は対戦相手が既に判明しているので online でも waiting/join を経由しない
    $deadline = ($mode !== 'local' && (int)$ruleset['turn_seconds'] > 0) ? $now + (int)$ruleset['turn_seconds'] : null;

    $stmt = $db->prepare("
        INSERT INTO arena_matches
            (public_id, game_id, ruleset_id, mode, status, player_a_id, player_a_name, player_b_id, player_b_name,
             turn_index, turn_deadline, version, series_id, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'drafting', ?, ?, ?, ?, 0, ?, 0, ?, ?, ?, ?)
    ");
    $stmt->execute([
        $publicId, (int)$anchor['game_id'], (int)$anchor['ruleset_id'], $mode,
        $summary['player_a_id'], $summary['player_a_name'], $summary['player_b_id'], $summary['player_b_name'],
        $deadline, $seriesId, $uid, $now, $now,
    ]);

    $match = arenaLoadMatch($db, $publicId);
    jsonResponse(['success' => true, 'match' => arenaSerializeMatch($db, $match)]);
}

// POST /v1/matches/{public_id}/join — オンライン戦に相手として参加する。
// public_id（room code）さえ知っていれば、招待制でない限り誰でも参加できる。
// 参加していない第三者に試合詳細を見せないよう、事前の arenaRequireMatchAccess は使わない。
function arenaHandleMatchJoin(array $params, PDO $db): void {
    $user = arenaActor($db, 'write');
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
    $user = arenaActor($db, 'read');
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
        // 一覧は最大100件返るため series サマリの埋め込みは省略する（series_id は含む）
        $matches[] = arenaSerializeMatch($db, $row, false);
    }

    jsonResponse(['success' => true, 'matches' => $matches]);
}

// GET /v1/matches/{public_id} — 試合詳細
function arenaHandleMatchGet(array $params, PDO $db): void {
    $user = arenaActor($db, 'read');
    $match = arenaRequireMatchAccess($db, $params['public_id'] ?? '', $user);
    $match = arenaRefreshMatchForRead($db, $match);

    jsonResponse(['success' => true, 'match' => arenaSerializeMatch($db, $match)]);
}

// GET /v1/matches/{public_id}/draft?since=N — ドラフト状態。
// 遅延タイムアウト処理を version 比較の前に必ず通す（そうしないと期限切れの手番が
// ポーラーから見えないまま放置される）。version <= since ならボディ無しの 304 を返し、
// その場合は arenaDraftState()/arenaSerializeMatch() を一切呼ばない（ポーリングを軽く保つ）。
function arenaHandleMatchDraftGet(array $params, PDO $db): void {
    $user = arenaActor($db, 'read');
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
    $user = arenaActor($db, 'write');
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
    $user = arenaActor($db, 'write');
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
    $user = arenaActor($db, 'write');
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
    $user = arenaActor($db, 'write');
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

// GET /v1/series/{series_id} — シリーズの試合一覧・サイド別勝敗・
// （フィアレスの場合）累積の使用済みエントリープール。
// 閲覧権限はシリーズを構成するいずれかの試合の参加者本人のみ。
function arenaHandleSeriesGet(array $params, PDO $db): void {
    $user = arenaActor($db, 'read');
    $seriesId = $params['series_id'] ?? '';

    $summary = arenaSeriesSummary($db, $seriesId);
    if ($summary === null) {
        jsonResponse(['success' => false, 'message' => 'シリーズが見つかりません'], 404);
    }

    $uid = (int)$user['id'];
    if ($uid !== $summary['player_a_id'] && $uid !== $summary['player_b_id']) {
        jsonResponse(['success' => false, 'message' => 'この試合を閲覧する権限がありません'], 403);
    }

    $stmt = $db->prepare('SELECT * FROM arena_matches WHERE series_id = ? ORDER BY created_at ASC, id ASC');
    $stmt->execute([$seriesId]);
    $rows = $stmt->fetchAll();

    $matches = [];
    $rulesetId = null;
    foreach ($rows as $row) {
        // 一覧取得のたびに遅延評価（48h自動承認・タイムアウト自動選択）も流しておく
        $row = arenaRefreshMatchForRead($db, $row);
        $rulesetId = (int)$row['ruleset_id'];
        // シリーズ一覧の中では自分自身への series サマリの再埋め込みは不要
        $matches[] = arenaSerializeMatch($db, $row, false);
    }

    // 遅延評価（自動承認等）で状態が変わっている可能性があるため、サマリはここで取り直す
    $summary = arenaSeriesSummary($db, $seriesId) ?? $summary;

    // フィアレスの場合のみ、累積の使用済み（PICK済み）エントリープールを返す。
    // arenaFearlessExcludedIds() と同じ「playing/reported/finished のPICKのみ」条件を使う。
    $usedPool = [];
    if ($rulesetId !== null) {
        $ruleset = arenaLoadRuleset($db, $rulesetId);
        if ($ruleset && !empty($ruleset['fearless'])) {
            $poolStmt = $db->prepare("
                SELECT DISTINCT e.id, e.slug, e.name, e.image_url
                FROM arena_actions a
                JOIN arena_matches m ON m.id = a.match_id
                JOIN arena_entries e ON e.id = a.entry_id
                WHERE m.series_id = ? AND a.action = 'pick' AND a.entry_id IS NOT NULL
                  AND m.status IN ('playing', 'reported', 'finished')
                ORDER BY e.name
            ");
            $poolStmt->execute([$seriesId]);
            $usedPool = array_map(function ($e) {
                return [
                    'id'        => (int)$e['id'],
                    'slug'      => $e['slug'],
                    'name'      => $e['name'],
                    'image_url' => $e['image_url'],
                ];
            }, $poolStmt->fetchAll());
        }
    }

    jsonResponse([
        'success'         => true,
        'series'          => $summary,
        'matches'         => $matches,
        'fearless_used_entries' => $usedPool,
    ]);
}
