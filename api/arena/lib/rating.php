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
// 戻り値: この更新で配置期間を終えたなら true（UI の演出用）
function arenaUpdateRatingRow(PDO $db, int $gameId, int $userId, string $username, float $newRating, bool $won, int $now, array $season): bool {
    $stmt = $db->prepare('
        SELECT wins, losses, streak, peak_rating, season_games, placement_done
        FROM arena_ratings WHERE game_id = ? AND user_id = ?
    ');
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

    // シーズン内試合数を1増やし、Nに達した時点で配置期間終了フラグを立てる。
    // 一度立ったフラグはシーズン終了までそのまま（減衰式は二度と適用されない）。
    $seasonGames   = (int)$row['season_games'] + 1;
    $placementDone = !empty($row['placement_done']);
    $justCompleted = false;
    $n = (int)$season['placement_games'];
    if (!$placementDone && $n > 0 && $seasonGames >= $n) {
        $placementDone = true;
        $justCompleted = true;
    } elseif (!$placementDone && $n <= 0) {
        // 配置期間なし設定のときは最初から確定扱いにする
        $placementDone = true;
    }

    $upd = $db->prepare('
        UPDATE arena_ratings
        SET username = ?, rating = ?, wins = ?, losses = ?, streak = ?, peak_rating = ?,
            season_games = ?, placement_done = ?, placement_done_at = ?, updated_at = ?
        WHERE game_id = ? AND user_id = ?
    ');
    $upd->execute([
        $username, $newRating, $wins, $losses, $streak, $peak,
        $seasonGames, $placementDone ? 1 : 0,
        $justCompleted ? $now : ($row['placement_done_at'] ?? null),
        $now, $gameId, $userId,
    ]);

    return $justCompleted;
}

// 1つのスコープ（'game'|'series'）・1つの ref_id・1つの game_id について Elo を計算・反映する。
// 先に arena_rating_history へ INSERT してから arena_ratings を UPDATE する
// （UNIQUE(scope, ref_id, game_id, user_id) が二重反映の最終防壁）。
// 呼び出し元が BEGIN IMMEDIATE トランザクションで囲むこと（R2で実装予定）。
// 戻り値: この反映で配置期間を終えたプレイヤーの一覧（UIの演出用）
function arenaApplyEloForScope(
    PDO $db,
    string $scope,
    int $refId,
    int $gameId,
    int $winnerId,
    string $winnerName,
    int $loserId,
    string $loserName
): array {
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

    $season = arenaCurrentSeason($db);
    $completed = [];
    if (arenaUpdateRatingRow($db, $gameId, $winnerId, $winnerName, $winnerAfter, true, $now, $season)) {
        $completed[] = ['user_id' => $winnerId, 'username' => $winnerName, 'game_id' => $gameId, 'display_rating' => round($winnerAfter, 1)];
    }
    if (arenaUpdateRatingRow($db, $gameId, $loserId, $loserName, $loserAfter, false, $now, $season)) {
        $completed[] = ['user_id' => $loserId, 'username' => $loserName, 'game_id' => $gameId, 'display_rating' => round($loserAfter, 1)];
    }
    return $completed;
}

// ─────────────────────────────────────────────────────────────────────────────
// 表示ランク（配置期間）
//
// 内部レート（arena_ratings.rating）は従来のEloそのままで、更新式もK値も変えない。
// 表示ランクは、シーズン開始直後の「配置期間」だけ内部レートより低く抑える。
//
//   表示ランク = 内部レート - max(0, (N - シーズン内試合数) × 減衰係数)
//   減衰係数   = OFFSET_MAX / N     （既定 N=5, OFFSET_MAX=100 → 20）
//
// シーズン内試合数が N に達した時点で placement_done を立て、
// 以降シーズン終了まで「表示ランク = 内部レート」に固定する（減衰式は二度と適用しない）。
// ─────────────────────────────────────────────────────────────────────────────

// 現行シーズンを返す。1つも無ければ既定値で作る。
function arenaCurrentSeason(PDO $db): array {
    $stmt = $db->query('SELECT * FROM arena_seasons WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1');
    $row = $stmt->fetch();
    if ($row) {
        return $row;
    }

    $now = time();
    $ins = $db->prepare('
        INSERT INTO arena_seasons (name, placement_games, offset_max, compress_ratio, started_at)
        VALUES (?, 5, 100, 0.7, ?)
    ');
    $ins->execute(['シーズン1', $now]);

    $stmt = $db->query('SELECT * FROM arena_seasons WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1');
    return $stmt->fetch();
}

// 配置期間の減衰係数（OFFSET_MAX / N）。N が 0 以下なら配置期間なし扱いで 0。
function arenaPlacementDecay(array $season): float {
    $n = (int)$season['placement_games'];
    if ($n <= 0) {
        return 0.0;
    }
    return (float)$season['offset_max'] / $n;
}

// 表示ランクを求める。placement_done が立っていれば内部レートそのまま。
function arenaDisplayRating(float $rating, int $seasonGames, bool $placementDone, array $season): float {
    if ($placementDone) {
        return $rating;
    }
    $n = (int)$season['placement_games'];
    if ($n <= 0) {
        return $rating;
    }
    $offset = max(0.0, ($n - $seasonGames) * arenaPlacementDecay($season));
    return $rating - $offset;
}

// arena_ratings の1行に、表示ランク関連のフィールドを足して返す（API用の共通整形）。
function arenaDecorateRatingRow(array $row, array $season): array {
    $n            = (int)$season['placement_games'];
    $seasonGames  = (int)($row['season_games'] ?? 0);
    $placement    = !empty($row['placement_done']);
    $rating       = (float)$row['rating'];
    $display      = arenaDisplayRating($rating, $seasonGames, $placement, $season);

    return [
        'rating'              => round($rating, 1),          // 内部レート
        'display_rating'      => round($display, 1),         // 表示ランク
        'season_games'        => $seasonGames,
        'placement_done'      => $placement,
        'in_placement'        => !$placement && $n > 0,
        'placement_remaining' => $placement ? 0 : max(0, $n - $seasonGames),
        'placement_games'     => $n,
    ];
}

// シーズンをクライアント向けに整形する
function arenaSerializeSeason(array $season): array {
    return [
        'id'              => (int)$season['id'],
        'name'            => $season['name'],
        'placement_games' => (int)$season['placement_games'],
        'offset_max'      => (float)$season['offset_max'],
        'decay'           => round(arenaPlacementDecay($season), 3),
        'compress_ratio'  => (float)$season['compress_ratio'],
        'started_at'      => (int)$season['started_at'],
    ];
}

// シーズンを切り替える。
//  1. 内部レートを各スコープ（game_id）の平均値方向へ圧縮して引き継ぐ
//       新内部レート = 平均値 + (旧内部レート - 平均値) × compress_ratio
//  2. 全プレイヤーの season_games / placement_done をリセットする
//  3. 旧シーズンを閉じ、新シーズンを開始する
// 圧縮率は「旧シーズン」の設定値を使う（そのシーズンの結末をどう持ち越すか、という設定のため）。
function arenaStartNewSeason(PDO $db, string $name, array $overrides = []): array {
    $old   = arenaCurrentSeason($db);
    $ratio = (float)$old['compress_ratio'];
    $now   = time();

    $db->exec('BEGIN IMMEDIATE');
    try {
        // スコープごとの平均値へ圧縮
        $scopes = $db->query('SELECT DISTINCT game_id FROM arena_ratings')->fetchAll();
        $upd = $db->prepare('UPDATE arena_ratings SET rating = ?, updated_at = ? WHERE game_id = ? AND user_id = ?');
        foreach ($scopes as $scope) {
            $gid = (int)$scope['game_id'];
            $avgStmt = $db->prepare('SELECT AVG(rating) FROM arena_ratings WHERE game_id = ?');
            $avgStmt->execute([$gid]);
            $mean = (float)$avgStmt->fetchColumn();

            $rowsStmt = $db->prepare('SELECT user_id, rating FROM arena_ratings WHERE game_id = ?');
            $rowsStmt->execute([$gid]);
            foreach ($rowsStmt->fetchAll() as $r) {
                $next = $mean + ((float)$r['rating'] - $mean) * $ratio;
                $upd->execute([$next, $now, $gid, (int)$r['user_id']]);
            }
        }

        // 配置期間のリセット
        $db->exec('UPDATE arena_ratings SET season_games = 0, placement_done = 0, placement_done_at = NULL');

        // シーズンの切り替え
        $db->prepare('UPDATE arena_seasons SET ended_at = ? WHERE id = ?')->execute([$now, (int)$old['id']]);
        $ins = $db->prepare('
            INSERT INTO arena_seasons (name, placement_games, offset_max, compress_ratio, started_at)
            VALUES (?, ?, ?, ?, ?)
        ');
        $ins->execute([
            $name,
            isset($overrides['placement_games']) ? (int)$overrides['placement_games'] : (int)$old['placement_games'],
            isset($overrides['offset_max'])      ? (float)$overrides['offset_max']    : (float)$old['offset_max'],
            isset($overrides['compress_ratio'])  ? (float)$overrides['compress_ratio'] : $ratio,
            $now,
        ]);

        $db->exec('COMMIT');
    } catch (Throwable $e) {
        if ($db->inTransaction()) {
            $db->exec('ROLLBACK');
        }
        throw $e;
    }

    return arenaCurrentSeason($db);
}
