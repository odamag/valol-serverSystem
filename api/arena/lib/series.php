<?php
// タイトルドラフト（5番勝負の対戦カード決め）の状態機械。判定はすべてサーバー側で行う。
// クライアントは表示するだけ。旧 lib/draft.php（キャラクターBAN/PICK）の置き換え。
//
// 流れ: 作成 → （オンラインのみ）join → ルーレット(A/B決定) → タイトルドラフト
//       （BAN4+PICK4、残り1つが自動でDecider） → 対戦（結果申告はR2）。

// ドラフト/ルーレット操作の失敗を表す例外。$status をそのまま HTTP ステータスとして使う。
class ArenaDraftError extends RuntimeException {
    public $status;

    public function __construct(string $message, int $status = 400) {
        parent::__construct($message);
        $this->status = $status;
    }
}

// public_id でシリーズを取得する。無ければ null。
function arenaLoadSeries(PDO $db, string $publicId): ?array {
    $stmt = $db->prepare('SELECT * FROM arena_series WHERE public_id = ?');
    $stmt->execute([$publicId]);
    $row = $stmt->fetch();
    return $row ?: null;
}

// public_id を生成する。8文字の16進数（bin2hex(random_bytes(4))）。衝突時は再試行する。
function arenaGenerateSeriesPublicId(PDO $db): string {
    for ($i = 0; $i < 10; $i++) {
        $candidate = bin2hex(random_bytes(4));
        $stmt = $db->prepare('SELECT 1 FROM arena_series WHERE public_id = ?');
        $stmt->execute([$candidate]);
        if (!$stmt->fetchColumn()) {
            return $candidate;
        }
    }
    throw new RuntimeException('public_id の生成に失敗しました');
}

// 指定の側（A/B）をこのユーザーが操作できるか。
// local: 作成者（player1 = created_by）が両側を操作できる（1画面で交互に打つため）。
// online: ルーレットで確定した side_a_user_id / side_b_user_id と一致する本人のみ。
function arenaCanActSeries(array $series, int $actorId, string $side): bool {
    if ($series['mode'] === 'local') {
        return $actorId === (int)$series['created_by'];
    }
    if ($series['side_a_user_id'] === null || $series['side_b_user_id'] === null) {
        return false; // ルーレット未実施
    }
    if ($side === 'A') {
        return $actorId === (int)$series['side_a_user_id'];
    }
    if ($side === 'B') {
        return $actorId === (int)$series['side_b_user_id'];
    }
    return false;
}

// ルーレット（A/B＝先手後手の決定）。サーバー側で random_bytes によりシードを生成し、
// 決定的にA/Bを割り当てる。再抽選は不可（status が 'roulette' のときのみ実行できる）。
function arenaSeriesRoulette(PDO $db, array $series, array $actor): array {
    if ($series['status'] !== 'roulette') {
        throw new ArenaDraftError('ルーレットは現在実行できません（対象外、または既に実施済みです）', 400);
    }

    $uid = (int)$actor['id'];
    $p2  = $series['player2_id'] !== null ? (int)$series['player2_id'] : null;
    if ($uid !== (int)$series['player1_id'] && $uid !== $p2) {
        throw new ArenaDraftError('このシリーズを操作する権限がありません', 403);
    }

    $seed = bin2hex(random_bytes(16));
    $hash = sha1($seed);
    // シードの先頭バイトの偶奇で player1 が A になるか B になるかを決める。
    // サーバー権威・シードから一意に再現可能・後から改ざんできない。
    $player1IsA = (hexdec(substr($hash, 0, 2)) % 2) === 0;

    $player1Id = (int)$series['player1_id'];
    $player2Id = (int)$series['player2_id'];
    $sideAId = $player1IsA ? $player1Id : $player2Id;
    $sideBId = $player1IsA ? $player2Id : $player1Id;

    $format = arenaLoadFormat($db, (int)$series['format_id']);
    $now = time();
    $deadline = ($series['mode'] !== 'local' && $format && (int)$format['turn_seconds'] > 0)
        ? $now + (int)$format['turn_seconds']
        : null;

    $conflict = false;
    $db->exec('BEGIN IMMEDIATE');
    try {
        // ロック取得後に再確認（同時押しのTOCTOU対策・再抽選の最終防壁）
        $checkStmt = $db->prepare('SELECT status FROM arena_series WHERE id = ?');
        $checkStmt->execute([(int)$series['id']]);
        $freshStatus = $checkStmt->fetchColumn();
        if ($freshStatus !== 'roulette') {
            $conflict = true;
        } else {
            $upd = $db->prepare("
                UPDATE arena_series
                SET side_a_user_id = ?, side_b_user_id = ?, roulette_seed = ?, roulette_at = ?,
                    status = 'drafting', turn_index = 0, turn_deadline = ?, version = version + 1, updated_at = ?
                WHERE id = ?
            ");
            $upd->execute([$sideAId, $sideBId, $seed, $now, $deadline, $now, (int)$series['id']]);
        }
        $db->exec('COMMIT');
    } catch (Throwable $e) {
        if ($db->inTransaction()) {
            $db->exec('ROLLBACK');
        }
        throw $e;
    }

    if ($conflict) {
        throw new ArenaDraftError('ルーレットは既に実施済みです（再抽選はできません）', 400);
    }

    return arenaLoadSeries($db, $series['public_id']) ?? $series;
}

// クライアント向けのドラフト状態を組み立てる（プールの各タイトルの状態・実行済みアクション・
// 現在の手番・確定した対戦カード）。
function arenaSeriesState(PDO $db, array $series, array $format): array {
    $sequence = $format['sequence_decoded'];
    $seriesId = (int)$series['id'];

    $poolStmt = $db->prepare('
        SELECT g.id, g.slug, g.name, g.icon
        FROM arena_series_pool p
        JOIN arena_games g ON g.id = p.game_id
        WHERE p.series_id = ?
        ORDER BY g.sort_order, g.name
    ');
    $poolStmt->execute([$seriesId]);
    $poolRows = $poolStmt->fetchAll();

    $actionsStmt = $db->prepare('
        SELECT a.seq, a.action, a.side, a.game_id, a.actor_id, a.is_timeout, a.created_at,
               g.slug AS game_slug, g.name AS game_name, g.icon AS game_icon
        FROM arena_series_actions a
        JOIN arena_games g ON g.id = a.game_id
        WHERE a.series_id = ?
        ORDER BY a.seq
    ');
    $actionsStmt->execute([$seriesId]);
    $actionRows = $actionsStmt->fetchAll();

    $statusByGame = []; // game_id => ['status'=>'banned'|'picked'|'decider', 'side'=>?]
    foreach ($actionRows as $r) {
        $gid = (int)$r['game_id'];
        if ($r['action'] === 'ban') {
            $statusByGame[$gid] = ['status' => 'banned', 'side' => $r['side']];
        } elseif ($r['action'] === 'pick') {
            $statusByGame[$gid] = ['status' => 'picked', 'side' => $r['side']];
        } else {
            $statusByGame[$gid] = ['status' => 'decider', 'side' => null];
        }
    }

    $pool = array_map(function ($g) use ($statusByGame) {
        $gid = (int)$g['id'];
        $st  = $statusByGame[$gid] ?? ['status' => 'available', 'side' => null];
        return [
            'id'     => $gid,
            'slug'   => $g['slug'],
            'name'   => $g['name'],
            'icon'   => $g['icon'],
            'status' => $st['status'],
            'side'   => $st['side'],
        ];
    }, $poolRows);

    $actions = array_map(function ($r) {
        return [
            'seq'        => (int)$r['seq'],
            'action'     => $r['action'],
            'side'       => $r['side'],
            'game_id'    => (int)$r['game_id'],
            'game_slug'  => $r['game_slug'],
            'game_name'  => $r['game_name'],
            'game_icon'  => $r['game_icon'],
            'actor_id'   => $r['actor_id'] !== null ? (int)$r['actor_id'] : null,
            'is_timeout' => (bool)$r['is_timeout'],
        ];
    }, $actionRows);

    $gamesStmt = $db->prepare('
        SELECT sg.game_no, sg.game_id, sg.is_decider, sg.picked_by, sg.winner_side,
               sg.reported_by, sg.confirmed_by, sg.played_at,
               g.slug AS game_slug, g.name AS game_name, g.icon AS game_icon
        FROM arena_series_games sg
        JOIN arena_games g ON g.id = sg.game_id
        WHERE sg.series_id = ?
        ORDER BY sg.game_no
    ');
    $gamesStmt->execute([$seriesId]);
    $lineup = array_map(function ($r) {
        return [
            'game_no'      => (int)$r['game_no'],
            'game_id'      => (int)$r['game_id'],
            'game_slug'    => $r['game_slug'],
            'game_name'    => $r['game_name'],
            'game_icon'    => $r['game_icon'],
            'is_decider'   => (bool)$r['is_decider'],
            'picked_by'    => $r['picked_by'],
            'winner_side'  => $r['winner_side'],
            'reported_by'  => $r['reported_by'] !== null ? (int)$r['reported_by'] : null,
            'confirmed_by' => $r['confirmed_by'] !== null ? (int)$r['confirmed_by'] : null,
            'played_at'    => $r['played_at'] !== null ? (int)$r['played_at'] : null,
        ];
    }, $gamesStmt->fetchAll());

    $turnIndex = (int)$series['turn_index'];

    return [
        'status'        => $series['status'],
        'turn_index'    => $turnIndex,
        'turn_deadline' => $series['turn_deadline'] !== null ? (int)$series['turn_deadline'] : null,
        'version'       => (int)$series['version'],
        'sequence'      => $sequence,
        'current_side'  => isset($sequence[$turnIndex]) ? $sequence[$turnIndex]['s'] : null,
        'current_type'  => isset($sequence[$turnIndex]) ? $sequence[$turnIndex]['t'] : null,
        'pool'          => $pool,
        'actions'       => $actions,
        'lineup'        => $lineup,
    ];
}

// 最後のPICKが終わった直後に呼ぶ。プールのうちBAN/PICKされずに残った唯一のタイトルを
// Deciderとして arena_series_actions に確定させ、PICK順=game_no 1..4、Deciderをgame_no 5
// として arena_series_games に5行を書く。呼び出し元の BEGIN IMMEDIATE トランザクション内で
// 実行すること（ドラフト完了と対戦カード確定を同一トランザクションにするため）。
function arenaMaterializeSeriesGames(PDO $db, int $seriesId): void {
    $remStmt = $db->prepare('
        SELECT game_id FROM arena_series_pool
        WHERE series_id = ? AND game_id NOT IN (
            SELECT game_id FROM arena_series_actions WHERE series_id = ?
        )
    ');
    $remStmt->execute([$seriesId, $seriesId]);
    $remaining = array_map('intval', array_column($remStmt->fetchAll(), 'game_id'));
    if (count($remaining) !== 1) {
        // pool_size が sequence+1 と一致している限り発生しない（防御的チェック）
        throw new RuntimeException('Deciderの確定に失敗しました（プールの残数が不正です）');
    }
    $deciderGameId = $remaining[0];

    $nextSeqStmt = $db->prepare('SELECT COALESCE(MAX(seq), -1) + 1 FROM arena_series_actions WHERE series_id = ?');
    $nextSeqStmt->execute([$seriesId]);
    $deciderSeq = (int)$nextSeqStmt->fetchColumn();

    $now = time();
    $db->prepare("
        INSERT INTO arena_series_actions (series_id, seq, action, side, game_id, actor_id, is_timeout, created_at)
        VALUES (?, ?, 'decider', NULL, ?, NULL, 0, ?)
    ")->execute([$seriesId, $deciderSeq, $deciderGameId, $now]);

    // PICK順（seq昇順）= game_no 1..4
    $pickStmt = $db->prepare("
        SELECT side, game_id FROM arena_series_actions
        WHERE series_id = ? AND action = 'pick' ORDER BY seq
    ");
    $pickStmt->execute([$seriesId]);
    $picks = $pickStmt->fetchAll();

    $insGame = $db->prepare('
        INSERT INTO arena_series_games (series_id, game_no, game_id, is_decider, picked_by)
        VALUES (?, ?, ?, 0, ?)
    ');
    $gameNo = 1;
    foreach ($picks as $p) {
        $insGame->execute([$seriesId, $gameNo, (int)$p['game_id'], $p['side']]);
        $gameNo++;
    }

    $db->prepare('
        INSERT INTO arena_series_games (series_id, game_no, game_id, is_decider, picked_by)
        VALUES (?, ?, ?, 1, NULL)
    ')->execute([$seriesId, $gameNo, $deciderGameId]);
}

// 1手（BAN/PICKまたはタイムアウトによる自動選択）を確定する。
// 楽観ロックの最終防壁は arena_series_actions の UNIQUE(series_id, seq)。
// turn_index/turn_deadline/version の更新、drafting→playing の遷移、
// 最終手であればDecider確定 + 対戦カード確定（arenaMaterializeSeriesGames）を
// すべて同一トランザクションで行う（「ドラフト済みなのに対戦カード無し」を絶対に作らない）。
function arenaSeriesCommitAction(
    PDO $db,
    array $series,
    array $format,
    int $seq,
    string $action,
    ?string $side,
    int $gameId,
    ?int $actorId,
    bool $isTimeout
): array {
    $sequence = $format['sequence_decoded'];
    $now = time();

    $db->exec('BEGIN IMMEDIATE');
    try {
        $ins = $db->prepare('
            INSERT INTO arena_series_actions (series_id, seq, action, side, game_id, actor_id, is_timeout, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ');
        try {
            $ins->execute([(int)$series['id'], $seq, $action, $side, $gameId, $actorId, $isTimeout ? 1 : 0, $now]);
        } catch (PDOException $e) {
            // UNIQUE(series_id, seq) 違反 = 二重送信・同時押し。楽観ロックの最終防壁。
            throw new ArenaDraftError('他の操作と競合しました。最新の状態を再取得してください', 409);
        }

        $newTurnIndex = $seq + 1;
        $draftDone = $newTurnIndex >= count($sequence);
        $newStatus = $draftDone ? 'playing' : 'drafting';

        // ローカルモードは常に無制限（turn_deadline=NULL）。
        $newDeadline = null;
        if (!$draftDone && $series['mode'] !== 'local' && (int)$format['turn_seconds'] > 0) {
            $newDeadline = $now + (int)$format['turn_seconds'];
        }

        $upd = $db->prepare('
            UPDATE arena_series
            SET turn_index = ?, turn_deadline = ?, version = version + 1, status = ?, updated_at = ?
            WHERE id = ?
        ');
        $upd->execute([$newTurnIndex, $newDeadline, $newStatus, $now, (int)$series['id']]);

        if ($draftDone) {
            arenaMaterializeSeriesGames($db, (int)$series['id']);
        }

        $db->exec('COMMIT');
    } catch (Throwable $e) {
        if ($db->inTransaction()) {
            $db->exec('ROLLBACK');
        }
        throw $e;
    }

    $fresh = arenaLoadSeries($db, $series['public_id']);
    return $fresh ?? $series;
}

// 遅延タイムアウト処理。turn_deadline が過去なら自動 BAN/PICK を while ループで追いつくまで適用する。
// turn_deadline が NULL（ローカルモードは常にこれ）の間は何もしない。
// 自動選択は sha1(series_id . ':' . seq) をシードにした決定的乱択にし、誰がいつ処理しても同じ結果になる。
function arenaApplySeriesTimeouts(PDO $db, array $series, array $format): array {
    while (
        $series['status'] === 'drafting'
        && $series['turn_deadline'] !== null
        && (int)$series['turn_deadline'] < time()
    ) {
        $sequence = $format['sequence_decoded'];
        $turnIndex = (int)$series['turn_index'];
        if (!isset($sequence[$turnIndex])) {
            break;
        }
        $step = $sequence[$turnIndex];
        $seriesId = (int)$series['id'];

        $usedStmt = $db->prepare('SELECT game_id FROM arena_series_actions WHERE series_id = ?');
        $usedStmt->execute([$seriesId]);
        $usedIds = array_map('intval', array_column($usedStmt->fetchAll(), 'game_id'));

        $poolStmt = $db->prepare('SELECT game_id FROM arena_series_pool WHERE series_id = ? ORDER BY game_id');
        $poolStmt->execute([$seriesId]);
        $poolIds = array_map('intval', array_column($poolStmt->fetchAll(), 'game_id'));

        $available = array_values(array_diff($poolIds, $usedIds));
        if (empty($available)) {
            // pool_size が sequence+1 と一致している限り発生しない（防御的に手番を進めず終了）
            break;
        }

        $seedIndex = hexdec(substr(sha1($seriesId . ':' . $turnIndex), 0, 8)) % count($available);
        $gameId = $available[$seedIndex];

        $series = arenaSeriesCommitAction($db, $series, $format, $turnIndex, $step['t'], $step['s'], $gameId, null, true);
    }
    return $series;
}

// BAN/PICK を1手実行する。楽観ロック・選択可否・手番の検証をすべて行い、
// 問題なければ arenaSeriesCommitAction() で確定する。失敗時は ArenaDraftError を投げる。
function arenaApplySeriesAction(PDO $db, array $series, array $format, array $actor, int $seq, string $action, int $gameId): array {
    // 先に遅延タイムアウトを流して最新状態に追いつかせる（ローカルモードは常にno-op）
    $series = arenaApplySeriesTimeouts($db, $series, $format);

    if ($series['status'] !== 'drafting') {
        throw new ArenaDraftError('このシリーズは現在タイトルドラフト中ではありません', 400);
    }

    $turnIndex = (int)$series['turn_index'];

    // 楽観ロック: リクエストの seq が turn_index と一致しなければ 409
    if ($seq !== $turnIndex) {
        throw new ArenaDraftError('他の操作と競合しました。最新の状態を再取得してください', 409);
    }

    $sequence = $format['sequence_decoded'];
    if (!isset($sequence[$turnIndex])) {
        throw new ArenaDraftError('ドラフト手順の範囲外です', 400);
    }
    $step = $sequence[$turnIndex];

    if (!in_array($action, ['ban', 'pick'], true) || $action !== $step['t']) {
        throw new ArenaDraftError('この手番では ' . ($step['t'] === 'ban' ? 'BAN' : 'PICK') . ' のみ実行できます', 400);
    }

    $side = $step['s'];
    if (!arenaCanActSeries($series, (int)$actor['id'], $side)) {
        throw new ArenaDraftError('あなたの手番ではありません', 403);
    }

    $seriesId = (int)$series['id'];

    $poolStmt = $db->prepare('SELECT 1 FROM arena_series_pool WHERE series_id = ? AND game_id = ?');
    $poolStmt->execute([$seriesId, $gameId]);
    if (!$poolStmt->fetchColumn()) {
        throw new ArenaDraftError('選択したタイトルはこのシリーズのプールにありません', 400);
    }

    $usedStmt = $db->prepare('SELECT 1 FROM arena_series_actions WHERE series_id = ? AND game_id = ?');
    $usedStmt->execute([$seriesId, $gameId]);
    if ($usedStmt->fetchColumn()) {
        throw new ArenaDraftError('そのタイトルは既にBAN/PICK済みです', 400);
    }

    return arenaSeriesCommitAction($db, $series, $format, $turnIndex, $action, $side, $gameId, (int)$actor['id'], false);
}
