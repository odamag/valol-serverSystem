<?php
// Eloレーティングの計算ヘルパー（R1時点）。
//
// ★セクション12での再設計に伴い、結果申告・確定・自動承認まわり（旧
// arenaApplyMatchResult() / arenaMaybeAutoConfirm()）は arena_matches 前提で
// 書かれていたため、このR1（タイトルドラフトのコア実装）ではいったん削除した。
// R2（結果申告 + Elo反映 + ランキング）で、arena_series_games（試合単位=scope='game'）
// と arena_series（シリーズ単位=scope='series'）の2スコープに対応する形で実装し直す。
// ここに残す計算関数・レート行ヘルパーはそのままR2から呼び出せる形にしてある。

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
// game_id の意味は db.php のコメントの通り：正の値=タイトル別 / 0=総合 / -1=シリーズ別。
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

// 1つのスコープ（'game'|'series'）・1つの ref_id・1つの game_id について Elo を計算・反映する。
// 先に arena_rating_history へ INSERT してから arena_ratings を UPDATE する
// （UNIQUE(scope, ref_id, game_id, user_id) が二重反映の最終防壁）。
// 呼び出し元が BEGIN IMMEDIATE トランザクションで囲むこと（R2で実装予定）。
function arenaApplyEloForScope(
    PDO $db,
    string $scope,
    int $refId,
    int $gameId,
    int $winnerId,
    string $winnerName,
    int $loserId,
    string $loserName
): void {
    $winner = arenaGetOrCreateRating($db, $gameId, $winnerId, $winnerName);
    $loser  = arenaGetOrCreateRating($db, $gameId, $loserId, $loserName);

    $winnerPlayed = (int)$winner['wins'] + (int)$winner['losses'];
    $loserPlayed  = (int)$loser['wins'] + (int)$loser['losses'];

    $winnerExpected = eloExpected((float)$winner['rating'], (float)$loser['rating']);
    $loserExpected  = eloExpected((float)$loser['rating'], (float)$winner['rating']);

    $winnerK = eloK($winnerPlayed);
    $loserK  = eloK($loserPlayed);

    $winnerAfter = (float)$winner['rating'] + $winnerK * (1 - $winnerExpected);
    $loserAfter  = (float)$loser['rating']  + $loserK  * (0 - $loserExpected);

    $now = time();

    $histStmt = $db->prepare('
        INSERT INTO arena_rating_history (scope, ref_id, game_id, user_id, opponent_id, rating_before, rating_after, result, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ');
    $histStmt->execute([$scope, $refId, $gameId, $winnerId, $loserId, (float)$winner['rating'], $winnerAfter, 'win', $now]);
    $histStmt->execute([$scope, $refId, $gameId, $loserId, $winnerId, (float)$loser['rating'], $loserAfter, 'loss', $now]);

    arenaUpdateRatingRow($db, $gameId, $winnerId, $winnerName, $winnerAfter, true, $now);
    arenaUpdateRatingRow($db, $gameId, $loserId, $loserName, $loserAfter, false, $now);
}
