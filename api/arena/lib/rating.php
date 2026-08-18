<?php
// 結果申告の確定処理とEloレーティング。
// 反映は必ず「arena_rating_history へINSERT → arena_ratings をUPDATE」の順で
// 1トランザクション内に収める。history の UNIQUE(match_id, game_id, user_id) が
// 二重反映を防ぐ最終防壁になる。

// 48時間経過した reported を自動承認するまでの秒数（cronは使わず、次に読まれた時に判定する）
const ARENA_RESULT_AUTO_CONFIRM_SECONDS = 48 * 3600;

// 勝者の期待勝率（0〜1）
function eloExpected(float $ra, float $rb): float {
    return 1 / (1 + pow(10, ($rb - $ra) / 400));
}

// 対戦数に応じたK値（仮レート期間ほど大きく動く）
function eloK(int $played): int {
    if ($played < 15) {
        return 40;
    }
    if ($played < 40) {
        return 28;
    }
    return 20;
}

// game_id/user_id の arena_ratings 行を取得する。無ければ 1200 で新規作成してから返す。
function arenaGetOrCreateRating(PDO $db, int $gameId, int $userId, string $username): array {
    $stmt = $db->prepare('SELECT * FROM arena_ratings WHERE game_id = ? AND user_id = ?');
    $stmt->execute([$gameId, $userId]);
    $row = $stmt->fetch();
    if ($row) {
        return $row;
    }

    $now = time();
    $ins = $db->prepare('
        INSERT INTO arena_ratings (game_id, user_id, username, rating, wins, losses, streak, peak_rating, updated_at)
        VALUES (?, ?, ?, 1200, 0, 0, 0, 1200, ?)
    ');
    $ins->execute([$gameId, $userId, $username, $now]);

    $stmt->execute([$gameId, $userId]);
    return $stmt->fetch();
}

// arena_ratings の1行を新しいレートで更新する（勝敗数・連勝連敗・ピークレートも更新）
function arenaUpdateRatingRow(PDO $db, int $gameId, int $userId, string $username, float $newRating, bool $won, int $now): void {
    $stmt = $db->prepare('SELECT wins, losses, streak, peak_rating FROM arena_ratings WHERE game_id = ? AND user_id = ?');
    $stmt->execute([$gameId, $userId]);
    $row = $stmt->fetch();

    $wins   = (int)$row['wins'];
    $losses = (int)$row['losses'];
    $streak = (int)$row['streak'];
    $peak   = (float)$row['peak_rating'];

    if ($won) {
        $wins++;
        $streak = $streak >= 0 ? $streak + 1 : 1;
    } else {
        $losses++;
        $streak = $streak <= 0 ? $streak - 1 : -1;
    }
    $peak = max($peak, $newRating);

    $upd = $db->prepare('
        UPDATE arena_ratings
        SET username = ?, rating = ?, wins = ?, losses = ?, streak = ?, peak_rating = ?, updated_at = ?
        WHERE game_id = ? AND user_id = ?
    ');
    $upd->execute([$username, $newRating, $wins, $losses, $streak, $peak, $now, $gameId, $userId]);
}

// 1つのスコープ（$scopeGameId: ゲーム別のIDまたは0=総合）について Elo を計算・反映する。
// 先に arena_rating_history へ INSERT してから arena_ratings を UPDATE する。
function arenaApplyEloForScope(
    PDO $db,
    int $matchId,
    int $scopeGameId,
    int $winnerId,
    string $winnerName,
    int $loserId,
    string $loserName
): void {
    $winner = arenaGetOrCreateRating($db, $scopeGameId, $winnerId, $winnerName);
    $loser  = arenaGetOrCreateRating($db, $scopeGameId, $loserId, $loserName);

    $winnerPlayed = (int)$winner['wins'] + (int)$winner['losses'];
    $loserPlayed  = (int)$loser['wins'] + (int)$loser['losses'];

    $winnerExpected = eloExpected((float)$winner['rating'], (float)$loser['rating']);
    $loserExpected  = eloExpected((float)$loser['rating'], (float)$winner['rating']);

    $winnerK = eloK($winnerPlayed);
    $loserK  = eloK($loserPlayed);

    $winnerAfter = (float)$winner['rating'] + $winnerK * (1 - $winnerExpected);
    $loserAfter  = (float)$loser['rating']  + $loserK  * (0 - $loserExpected);

    $now = time();

    // history へ先に INSERT（UNIQUE(match_id, game_id, user_id) が二重反映の最終防壁）
    $histStmt = $db->prepare('
        INSERT INTO arena_rating_history (match_id, game_id, user_id, opponent_id, rating_before, rating_after, result, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ');
    $histStmt->execute([$matchId, $scopeGameId, $winnerId, $loserId, (float)$winner['rating'], $winnerAfter, 'win', $now]);
    $histStmt->execute([$matchId, $scopeGameId, $loserId, $winnerId, (float)$loser['rating'], $loserAfter, 'loss', $now]);

    arenaUpdateRatingRow($db, $scopeGameId, $winnerId, $winnerName, $winnerAfter, true, $now);
    arenaUpdateRatingRow($db, $scopeGameId, $loserId, $loserName, $loserAfter, false, $now);
}

// 結果を確定する（Elo反映 + status='finished'）。$confirmerId は承認者
// （自動承認の場合はもう一方のプレイヤーのID）。
// status が 'reported' でなければ何もせず現状の match をそのまま返す（二重反映防止）。
function arenaApplyMatchResult(PDO $db, array $match, int $confirmerId): array {
    if ($match['status'] !== 'reported') {
        return $match;
    }

    $winnerSide = $match['winner_side'];
    $playerAId  = (int)$match['player_a_id'];
    $playerBId  = $match['player_b_id'] !== null ? (int)$match['player_b_id'] : null;
    if (!in_array($winnerSide, ['A', 'B'], true) || $playerBId === null) {
        // データ不整合。確定させずそのまま返す（通常は発生しない防御的分岐）
        return $match;
    }

    $gameId     = (int)$match['game_id'];
    $winnerId   = $winnerSide === 'A' ? $playerAId : $playerBId;
    $loserId    = $winnerSide === 'A' ? $playerBId : $playerAId;
    $winnerName = $winnerSide === 'A' ? (string)$match['player_a_name'] : (string)$match['player_b_name'];
    $loserName  = $winnerSide === 'A' ? (string)$match['player_b_name'] : (string)$match['player_a_name'];

    $db->exec('BEGIN IMMEDIATE');
    try {
        // ロック取得後に再確認（他リクエストが直前に確定させていないか。TOCTOU対策）
        $checkStmt = $db->prepare('SELECT status FROM arena_matches WHERE id = ?');
        $checkStmt->execute([(int)$match['id']]);
        $freshStatus = $checkStmt->fetchColumn();
        if ($freshStatus !== 'reported') {
            $db->exec('ROLLBACK');
            return arenaLoadMatch($db, $match['public_id']) ?? $match;
        }

        arenaApplyEloForScope($db, (int)$match['id'], $gameId, $winnerId, $winnerName, $loserId, $loserName);
        arenaApplyEloForScope($db, (int)$match['id'], 0, $winnerId, $winnerName, $loserId, $loserName);

        $now = time();
        $db->prepare("UPDATE arena_matches SET status = 'finished', confirmed_by = ?, finished_at = ?, updated_at = ? WHERE id = ?")
           ->execute([$confirmerId, $now, $now, (int)$match['id']]);

        $db->exec('COMMIT');
    } catch (Throwable $e) {
        $db->exec('ROLLBACK');
        throw $e;
    }

    return arenaLoadMatch($db, $match['public_id']) ?? $match;
}

// 48時間経過した reported を自動承認する（遅延評価。cronは使わず、次にこの試合が
// 読まれたリクエストの中で判定する）。まだ48時間経っていなければ何もしない。
function arenaMaybeAutoConfirm(PDO $db, array $match): array {
    if ($match['status'] !== 'reported') {
        return $match;
    }
    if ((time() - (int)$match['updated_at']) < ARENA_RESULT_AUTO_CONFIRM_SECONDS) {
        return $match;
    }

    $reportedBy = (int)$match['reported_by'];
    $playerAId  = (int)$match['player_a_id'];
    $playerBId  = $match['player_b_id'] !== null ? (int)$match['player_b_id'] : null;
    $opponentId = $reportedBy === $playerAId ? $playerBId : $playerAId;
    if ($opponentId === null) {
        return $match;
    }

    return arenaApplyMatchResult($db, $match, $opponentId);
}
