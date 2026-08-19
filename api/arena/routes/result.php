<?php
// 5番勝負の勝敗記録ハンドラ（/v1/series/{public_id}/games/{game_no}/result, /confirm）。
//
// 設計上の要点:
//  - 試合は必ず「まだ勝敗がついていない最小の game_no」から順に申告する（飛ばし申告は400）
//  - 申告者本人は承認できない。必ず相手アカウントの承認でレートが動く
//    （ローカルモードでは作成者が両側のドラフトを操作できるため、これが唯一の歯止めになる）
//  - 48時間承認されない申告は、次にそのシリーズが読まれたときに自動承認する（cron不要の遅延評価）
//  - 承認時に「そのタイトルのElo」と「総合Elo」を、シリーズ確定時に「シリーズElo」を反映する
//    game_id の意味：正の値=タイトル別 / 0=総合 / -1=シリーズ別

// 未承認の申告を自動承認するまでの猶予（秒）
define('ARENA_AUTO_CONFIRM_SECONDS', 48 * 3600);

// A側/B側のユーザーID・表示名を解決する。ルーレット未実施なら null を含む。
function arenaSeriesSideUsers(array $series): array {
    $p1 = (int)$series['player1_id'];
    $p1name = (string)$series['player1_name'];
    $p2 = $series['player2_id'] !== null ? (int)$series['player2_id'] : null;
    $p2name = (string)($series['player2_name'] ?? '');

    $resolve = function ($uid) use ($p1, $p1name, $p2, $p2name) {
        if ($uid === null) {
            return null;
        }
        if ($uid === $p1) {
            return ['id' => $p1, 'name' => $p1name];
        }
        if ($uid === $p2) {
            return ['id' => $p2, 'name' => $p2name];
        }
        return ['id' => $uid, 'name' => ''];
    };

    return [
        'A' => $resolve($series['side_a_user_id'] !== null ? (int)$series['side_a_user_id'] : null),
        'B' => $resolve($series['side_b_user_id'] !== null ? (int)$series['side_b_user_id'] : null),
    ];
}

// シリーズの試合行を game_no 順に取得する
function arenaSeriesGameRows(PDO $db, int $seriesId): array {
    $stmt = $db->prepare('SELECT * FROM arena_series_games WHERE series_id = ? ORDER BY game_no');
    $stmt->execute([$seriesId]);
    return $stmt->fetchAll();
}

// まだ勝敗がついていない最小の game_no を返す。すべて決着済みなら null。
function arenaNextUnplayedGameNo(array $rows): ?int {
    foreach ($rows as $r) {
        if ($r['winner_side'] === null) {
            return (int)$r['game_no'];
        }
    }
    return null;
}

// 1試合の勝敗を確定させ、Eloを反映する。
// 呼び出し元が BEGIN IMMEDIATE トランザクション内で呼ぶこと。
// $confirmedBy が null の場合は自動承認（48時間経過）を意味する。
// 戻り値: ['series_finished' => bool]
function arenaFinalizeSeriesGame(PDO $db, array $series, array $gameRow, string $winnerSide, ?int $confirmedBy, int $now): array {
    $seriesId = (int)$series['id'];
    $sides    = arenaSeriesSideUsers($series);
    $winner   = $sides[$winnerSide];
    $loser    = $sides[$winnerSide === 'A' ? 'B' : 'A'];

    if (!$winner || !$loser) {
        throw new RuntimeException('side users unresolved for series ' . $seriesId);
    }

    $upd = $db->prepare('
        UPDATE arena_series_games
        SET winner_side = ?, confirmed_by = ?, played_at = ?
        WHERE id = ? AND winner_side IS NULL
    ');
    $upd->execute([$winnerSide, $confirmedBy, $now, (int)$gameRow['id']]);
    if ($upd->rowCount() === 0) {
        // 既に確定済み（同時実行）。Eloは触らずに抜ける。
        return ['series_finished' => false];
    }

    // 勝敗数を加算
    $col = $winnerSide === 'A' ? 'wins_a' : 'wins_b';
    $db->prepare("UPDATE arena_series SET {$col} = {$col} + 1, updated_at = ?, version = version + 1 WHERE id = ?")
       ->execute([$now, $seriesId]);

    // その試合のタイトル別Elo + 総合Elo
    arenaApplyEloForScope($db, 'game', (int)$gameRow['id'], (int)$gameRow['game_id'],
        $winner['id'], $winner['name'], $loser['id'], $loser['name']);
    arenaApplyEloForScope($db, 'game', (int)$gameRow['id'], 0,
        $winner['id'], $winner['name'], $loser['id'], $loser['name']);

    // シリーズ決着判定
    $format = arenaLoadFormat($db, (int)$series['format_id']);
    $winsNeeded = $format ? (int)$format['wins_needed'] : 3;

    $cur = $db->prepare('SELECT wins_a, wins_b FROM arena_series WHERE id = ?');
    $cur->execute([$seriesId]);
    $tally = $cur->fetch();
    $winsA = (int)$tally['wins_a'];
    $winsB = (int)$tally['wins_b'];

    $seriesWinner = null;
    if ($winsA >= $winsNeeded) {
        $seriesWinner = 'A';
    } elseif ($winsB >= $winsNeeded) {
        $seriesWinner = 'B';
    }
    if ($seriesWinner === null) {
        return ['series_finished' => false];
    }

    $db->prepare("
        UPDATE arena_series
        SET status = 'finished', winner_side = ?, finished_at = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND status = 'playing'
    ")->execute([$seriesWinner, $now, $now, $seriesId]);

    // シリーズEloは game_id = -1
    $sWinner = $sides[$seriesWinner];
    $sLoser  = $sides[$seriesWinner === 'A' ? 'B' : 'A'];
    arenaApplyEloForScope($db, 'series', $seriesId, -1,
        $sWinner['id'], $sWinner['name'], $sLoser['id'], $sLoser['name']);

    return ['series_finished' => true];
}

// 48時間承認されていない申告を自動承認する（遅延評価。cronを使わない）。
// シリーズを読むあらゆる経路から呼んでよい。何か確定したら true を返す。
function arenaMaybeAutoConfirmSeriesGames(PDO $db, array $series): bool {
    if ($series['status'] !== 'playing') {
        return false;
    }

    $now      = time();
    $deadline = $now - ARENA_AUTO_CONFIRM_SECONDS;
    $changed  = false;

    // 申告済み・未確定・期限超過のものを、game_no順に1件ずつ確定させる
    while (true) {
        $stmt = $db->prepare('
            SELECT * FROM arena_series_games
            WHERE series_id = ? AND winner_side IS NULL
              AND reported_by IS NOT NULL AND reported_at IS NOT NULL AND reported_at <= ?
            ORDER BY game_no LIMIT 1
        ');
        $stmt->execute([(int)$series['id'], $deadline]);
        $row = $stmt->fetch();
        if (!$row) {
            break;
        }

        $pending = arenaMetaGet($db, 'series_pending:' . (int)$row['id']);
        if ($pending !== 'A' && $pending !== 'B') {
            // 申告内容が失われている異常系。無限ループを避けるため申告を取り消す。
            $db->prepare('UPDATE arena_series_games SET reported_by = NULL, reported_at = NULL WHERE id = ?')
               ->execute([(int)$row['id']]);
            continue;
        }

        $db->beginTransaction();
        try {
            $fresh = arenaLoadSeries($db, $series['public_id']);
            arenaFinalizeSeriesGame($db, $fresh, $row, $pending, null, $now);
            $db->commit();
        } catch (Throwable $e) {
            $db->rollBack();
            error_log('[arena] auto-confirm failed: ' . $e->getMessage());
            break;
        }
        $changed = true;
        $series  = arenaLoadSeries($db, $series['public_id']);
        if ($series['status'] !== 'playing') {
            break;
        }
    }

    return $changed;
}

// 申告・承認の共通前処理。シリーズと対象試合行を返す。
function arenaRequireReportableGame(PDO $db, array $params, array $user): array {
    $publicId = $params['public_id'] ?? '';
    $series   = arenaRequireSeriesAccess($db, $publicId, $user);

    arenaMaybeAutoConfirmSeriesGames($db, $series);
    $series = arenaLoadSeries($db, $publicId);

    if ($series['status'] === 'finished') {
        jsonResponse(['success' => false, 'message' => 'このシリーズは既に決着しています'], 400);
    }
    if ($series['status'] !== 'playing') {
        jsonResponse(['success' => false, 'message' => 'このシリーズはまだ対戦段階ではありません'], 400);
    }

    $gameNo = (int)($params['game_no'] ?? 0);
    $rows   = arenaSeriesGameRows($db, (int)$series['id']);

    $target = null;
    foreach ($rows as $r) {
        if ((int)$r['game_no'] === $gameNo) {
            $target = $r;
            break;
        }
    }
    if (!$target) {
        jsonResponse(['success' => false, 'message' => '指定された試合が見つかりません'], 404);
    }
    if ($target['winner_side'] !== null) {
        jsonResponse(['success' => false, 'message' => 'この試合は既に確定しています'], 400);
    }

    $next = arenaNextUnplayedGameNo($rows);
    if ($next !== null && $gameNo !== $next) {
        jsonResponse([
            'success' => false,
            'message' => "試合は順番に記録してください（次は第{$next}試合です）",
        ], 400);
    }

    return [$series, $target];
}

// POST /v1/series/{public_id}/games/{game_no}/result — 勝敗を申告する {winner:'A'|'B'}
function arenaHandleSeriesGameResult(array $params, PDO $db): void {
    $user = arenaActor($db, 'write');
    list($series, $target) = arenaRequireReportableGame($db, $params, $user);

    $body = arenaReadJsonBody();
    if ($err = arenaCheckAllowedFields($body, ['winner'])) {
        jsonResponse(['success' => false, 'message' => $err], 400);
    }
    $winner = (string)($body['winner'] ?? '');
    if ($winner !== 'A' && $winner !== 'B') {
        jsonResponse(['success' => false, 'message' => 'winner は "A" か "B" を指定してください'], 400);
    }

    $now = time();
    $db->beginTransaction();
    try {
        // 申告内容（どちらの勝ちか）は arena_meta に保持する。
        // arena_series_games に専用カラムを増やさずに済ませるため。
        arenaMetaSet($db, 'series_pending:' . (int)$target['id'], $winner);
        $db->prepare('
            UPDATE arena_series_games
            SET reported_by = ?, reported_at = ?
            WHERE id = ? AND winner_side IS NULL
        ')->execute([(int)$user['id'], $now, (int)$target['id']]);
        $db->prepare('UPDATE arena_series SET updated_at = ?, version = version + 1 WHERE id = ?')
           ->execute([$now, (int)$series['id']]);
        $db->commit();
    } catch (Throwable $e) {
        $db->rollBack();
        error_log('[arena] result report failed: ' . $e->getMessage());
        jsonResponse(['success' => false, 'message' => '結果の申告に失敗しました'], 500);
    }

    $fresh  = arenaLoadSeries($db, $series['public_id']);
    $format = arenaLoadFormat($db, (int)$fresh['format_id']);
    jsonResponse([
        'success'          => true,
        'pending_winner'   => $winner,
        'awaiting_confirm' => true,
        'series'           => arenaSerializeSeries($db, $fresh),
        'state'            => arenaSeriesState($db, $fresh, $format),
    ]);
}

// POST /v1/series/{public_id}/games/{game_no}/confirm — 相手が申告を承認する
function arenaHandleSeriesGameConfirm(array $params, PDO $db): void {
    $user = arenaActor($db, 'write');
    list($series, $target) = arenaRequireReportableGame($db, $params, $user);

    if ($target['reported_by'] === null) {
        jsonResponse(['success' => false, 'message' => 'まだ結果が申告されていません'], 400);
    }
    if ((int)$target['reported_by'] === (int)$user['id']) {
        jsonResponse(['success' => false, 'message' => '自分が申告した結果は承認できません。相手のアカウントで承認してください'], 400);
    }

    $pending = arenaMetaGet($db, 'series_pending:' . (int)$target['id']);
    if ($pending !== 'A' && $pending !== 'B') {
        jsonResponse(['success' => false, 'message' => '申告内容が見つかりません。もう一度申告してください'], 400);
    }

    $now = time();
    $db->beginTransaction();
    try {
        $result = arenaFinalizeSeriesGame($db, $series, $target, $pending, (int)$user['id'], $now);
        $db->commit();
    } catch (Throwable $e) {
        $db->rollBack();
        error_log('[arena] confirm failed: ' . $e->getMessage());
        jsonResponse(['success' => false, 'message' => '結果の確定に失敗しました'], 500);
    }

    $fresh  = arenaLoadSeries($db, $series['public_id']);
    $format = arenaLoadFormat($db, (int)$fresh['format_id']);
    jsonResponse([
        'success'         => true,
        'series_finished' => $result['series_finished'],
        'series'          => arenaSerializeSeries($db, $fresh),
        'state'           => arenaSeriesState($db, $fresh, $format),
    ]);
}
