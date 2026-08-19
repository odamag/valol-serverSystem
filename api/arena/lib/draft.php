<?php
// ドラフト状態機械。判定はすべてサーバー側で行う。クライアントは表示するだけ。
// mode='local' のみ対応（Phase 3）。mode='online' は Phase 4 でポーリング・
// turn_deadline 判定を追加するが、arenaCanAct() / arenaApplyTimeouts() は
// 今のうちに online にも対応できる形で書いておく（呼び出し側は変えずに済む）。

// ドラフト操作の失敗を表す例外。$status をそのまま HTTP ステータスとして使う。
class ArenaDraftError extends RuntimeException {
    public $status;

    public function __construct(string $message, int $status = 400) {
        parent::__construct($message);
        $this->status = $status;
    }
}

// public_id で試合を取得する。無ければ null。
function arenaLoadMatch(PDO $db, string $publicId): ?array {
    $stmt = $db->prepare('SELECT * FROM arena_matches WHERE public_id = ?');
    $stmt->execute([$publicId]);
    $row = $stmt->fetch();
    return $row ?: null;
}

// ルールセットを取得し、sequence を配列にデコードして 'sequence_decoded' に入れて返す。
function arenaLoadRuleset(PDO $db, int $rulesetId): ?array {
    $stmt = $db->prepare('SELECT * FROM arena_rulesets WHERE id = ?');
    $stmt->execute([$rulesetId]);
    $row = $stmt->fetch();
    if (!$row) {
        return null;
    }
    $row['sequence_decoded'] = json_decode($row['sequence'], true) ?: [];
    return $row;
}

// 指定の側（A/B）をこのユーザーが操作できるか。
// local: 作成者が両側を操作できる（1画面で交互に打つため）。
// online（Phase 4）: sequence[turn_index].s と同じ側の本人のみ。
function arenaCanAct(array $match, int $actorId, string $side): bool {
    if ($match['mode'] === 'local') {
        return $actorId === (int)$match['created_by'];
    }
    if ($side === 'A') {
        return $actorId === (int)$match['player_a_id'];
    }
    if ($side === 'B') {
        return $match['player_b_id'] !== null && $actorId === (int)$match['player_b_id'];
    }
    return false;
}

// arena_actions の行から「BANされたID」「Aがpickした ID」「Bがpickした ID」の3集合を作る。
// $actions は ['action'=>'ban'|'pick', 'side'=>'A'|'B', 'entry_id'=>int|null] の配列。
function arenaCollectUsedEntryIds(array $actions): array {
    $banned = [];
    $pickedA = [];
    $pickedB = [];
    foreach ($actions as $a) {
        if ($a['entry_id'] === null) {
            continue;
        }
        if ($a['action'] === 'ban') {
            $banned[$a['entry_id']] = true;
        } elseif ($a['side'] === 'A') {
            $pickedA[$a['entry_id']] = true;
        } else {
            $pickedB[$a['entry_id']] = true;
        }
    }
    return [array_keys($banned), array_keys($pickedA), array_keys($pickedB)];
}

// フィアレス（同一シリーズ内で使用済みのエントリーを再選択不可）で除外すべき entry_id 一覧。
// Phase 6: series_id が発行されるようになったため実際に効く。対象は「同一シリーズの
// 別試合で PICK された（かつ実際にその試合が playing 以降まで進んだ = ドラフトが
// 成立した）エントリー」のみ。BAN は持ち越さない。waiting/drafting/cancelled の試合は
// 対象外（drafting 中の別試合は通常発生しないが、cancelled はやり直しなので除外しない
// と正しい）。
function arenaFearlessExcludedIds(PDO $db, array $match, array $ruleset): array {
    if (empty($ruleset['fearless']) || empty($match['series_id'])) {
        return [];
    }
    $stmt = $db->prepare("
        SELECT DISTINCT a.entry_id
        FROM arena_actions a
        JOIN arena_matches m ON m.id = a.match_id
        WHERE m.series_id = ? AND m.id != ? AND a.action = 'pick' AND a.entry_id IS NOT NULL
          AND m.status IN ('playing', 'reported', 'finished')
    ");
    $stmt->execute([$match['series_id'], (int)$match['id']]);
    return array_map('intval', array_column($stmt->fetchAll(), 'entry_id'));
}

// あるエントリーが、この手番（side）で選択可能かどうか。
// - BANされたものは常に両者不可
// - フィアレス除外対象は不可
// - 自分の側が既にpick済みのものは不可
// - mirror_allowed=0 のとき、相手が既にpick済みのものは不可
function arenaIsEntryAvailable(
    int $entryId,
    string $side,
    bool $mirrorAllowed,
    array $bannedIds,
    array $pickedA,
    array $pickedB,
    array $fearlessExcluded
): bool {
    if (in_array($entryId, $bannedIds, true)) {
        return false;
    }
    if (in_array($entryId, $fearlessExcluded, true)) {
        return false;
    }
    $ownPicks = $side === 'A' ? $pickedA : $pickedB;
    $oppPicks = $side === 'A' ? $pickedB : $pickedA;
    if (in_array($entryId, $ownPicks, true)) {
        return false;
    }
    if (!$mirrorAllowed && in_array($entryId, $oppPicks, true)) {
        return false;
    }
    return true;
}

// クライアント向けのドラフト状態を組み立てる（実行済みアクション・現在の手番・選択可否の集合）。
function arenaDraftState(PDO $db, array $match, array $ruleset): array {
    $sequence = $ruleset['sequence_decoded'];

    $actionsStmt = $db->prepare('
        SELECT a.seq, a.action, a.side, a.entry_id, a.actor_id, a.is_timeout, a.created_at,
               e.slug AS entry_slug, e.name AS entry_name, e.image_url AS entry_image_url
        FROM arena_actions a
        LEFT JOIN arena_entries e ON e.id = a.entry_id
        WHERE a.match_id = ?
        ORDER BY a.seq
    ');
    $actionsStmt->execute([(int)$match['id']]);
    $actionRows = $actionsStmt->fetchAll();

    $actions = array_map(function ($r) {
        return [
            'seq'             => (int)$r['seq'],
            'action'          => $r['action'],
            'side'            => $r['side'],
            'entry_id'        => $r['entry_id'] !== null ? (int)$r['entry_id'] : null,
            'entry_slug'      => $r['entry_slug'],
            'entry_name'      => $r['entry_name'],
            'entry_image_url' => $r['entry_image_url'],
            'actor_id'        => $r['actor_id'] !== null ? (int)$r['actor_id'] : null,
            'is_timeout'      => (bool)$r['is_timeout'],
        ];
    }, $actionRows);

    $rawActions = array_map(function ($r) {
        return [
            'action'   => $r['action'],
            'side'     => $r['side'],
            'entry_id' => $r['entry_id'] !== null ? (int)$r['entry_id'] : null,
        ];
    }, $actionRows);
    [$bannedIds, $pickedA, $pickedB] = arenaCollectUsedEntryIds($rawActions);
    $fearlessExcluded = arenaFearlessExcludedIds($db, $match, $ruleset);

    $turnIndex = (int)$match['turn_index'];

    return [
        'status'                => $match['status'],
        'turn_index'            => $turnIndex,
        'turn_deadline'         => $match['turn_deadline'] !== null ? (int)$match['turn_deadline'] : null,
        'version'               => (int)$match['version'],
        'sequence'               => $sequence,
        'actions'                => $actions,
        'current_side'           => isset($sequence[$turnIndex]) ? $sequence[$turnIndex]['s'] : null,
        'current_type'           => isset($sequence[$turnIndex]) ? $sequence[$turnIndex]['t'] : null,
        'banned_entry_ids'       => array_values($bannedIds),
        'picked_entry_ids_a'     => array_values($pickedA),
        'picked_entry_ids_b'     => array_values($pickedB),
        'fearless_excluded_ids'  => array_values($fearlessExcluded),
    ];
}

// 1手（BAN/PICKまたはタイムアウトによる自動選択）を確定する。
// 楽観ロックの最終防壁は arena_actions の UNIQUE(match_id, seq)。
// turn_index/turn_deadline/version の更新と drafting→playing の遷移を同一トランザクションで行う。
function arenaCommitAction(
    PDO $db,
    array $match,
    array $ruleset,
    int $seq,
    string $action,
    string $side,
    ?int $entryId,
    ?int $actorId,
    bool $isTimeout
): array {
    $sequence = $ruleset['sequence_decoded'];
    $now = time();

    $db->exec('BEGIN IMMEDIATE');
    try {
        $ins = $db->prepare('
            INSERT INTO arena_actions (match_id, seq, action, side, entry_id, actor_id, is_timeout, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ');
        try {
            $ins->execute([(int)$match['id'], $seq, $action, $side, $entryId, $actorId, $isTimeout ? 1 : 0, $now]);
        } catch (PDOException $e) {
            // UNIQUE(match_id, seq) 違反 = 二重送信・同時押し。楽観ロックの最終防壁。
            throw new ArenaDraftError('他の操作と競合しました。最新の状態を再取得してください', 409);
        }

        $newTurnIndex = $seq + 1;
        $newStatus = $newTurnIndex >= count($sequence) ? 'playing' : 'drafting';

        // ローカルモードは常に無制限（turn_deadline=NULL）。オンラインモード対応は Phase 4。
        $newDeadline = null;
        if ($match['mode'] !== 'local' && $newStatus === 'drafting' && (int)$ruleset['turn_seconds'] > 0) {
            $newDeadline = $now + (int)$ruleset['turn_seconds'];
        }

        $upd = $db->prepare('
            UPDATE arena_matches
            SET turn_index = ?, turn_deadline = ?, version = version + 1, status = ?, updated_at = ?
            WHERE id = ?
        ');
        $upd->execute([$newTurnIndex, $newDeadline, $newStatus, $now, (int)$match['id']]);

        $db->exec('COMMIT');
    } catch (Throwable $e) {
        $db->exec('ROLLBACK');
        throw $e;
    }

    $fresh = arenaLoadMatch($db, $match['public_id']);
    return $fresh ?? $match;
}

// 遅延タイムアウト処理。turn_deadline が過去なら自動 BAN/PICK を while ループで追いつくまで適用する。
// turn_deadline が NULL（ローカルモードは常にこれ）の間は何もしない。
// 自動選択は match_id + turn_index をシードにした決定的乱択にし、誰がいつ処理しても同じ結果になる。
function arenaApplyTimeouts(PDO $db, array $match, array $ruleset): array {
    while (
        $match['status'] === 'drafting'
        && $match['turn_deadline'] !== null
        && (int)$match['turn_deadline'] < time()
    ) {
        $sequence = $ruleset['sequence_decoded'];
        $turnIndex = (int)$match['turn_index'];
        if (!isset($sequence[$turnIndex])) {
            break;
        }
        $step = $sequence[$turnIndex];

        $actionsStmt = $db->prepare('SELECT action, side, entry_id FROM arena_actions WHERE match_id = ?');
        $actionsStmt->execute([(int)$match['id']]);
        $rawActions = array_map(function ($r) {
            return [
                'action'   => $r['action'],
                'side'     => $r['side'],
                'entry_id' => $r['entry_id'] !== null ? (int)$r['entry_id'] : null,
            ];
        }, $actionsStmt->fetchAll());
        [$bannedIds, $pickedA, $pickedB] = arenaCollectUsedEntryIds($rawActions);
        $fearlessExcluded = arenaFearlessExcludedIds($db, $match, $ruleset);

        $entriesStmt = $db->prepare('SELECT id FROM arena_entries WHERE game_id = ? AND enabled = 1 ORDER BY id');
        $entriesStmt->execute([(int)$match['game_id']]);
        $allIds = array_map('intval', array_column($entriesStmt->fetchAll(), 'id'));

        $available = array_values(array_filter($allIds, function ($id) use ($step, $ruleset, $bannedIds, $pickedA, $pickedB, $fearlessExcluded) {
            return arenaIsEntryAvailable($id, $step['s'], (bool)$ruleset['mirror_allowed'], $bannedIds, $pickedA, $pickedB, $fearlessExcluded);
        }));

        if (empty($available)) {
            // 選べるエントリーが無ければ entry_id=NULL のまま手番だけ進める
            $entryId = null;
        } else {
            $seedIndex = hexdec(substr(sha1($match['id'] . ':' . $turnIndex), 0, 8)) % count($available);
            $entryId = $available[$seedIndex];
        }

        $match = arenaCommitAction($db, $match, $ruleset, $turnIndex, $step['t'], $step['s'], $entryId, null, true);
    }
    return $match;
}

// BAN/PICK を1手実行する。楽観ロック・選択可否・手番の検証をすべて行い、
// 問題なければ arenaCommitAction() で確定する。失敗時は ArenaDraftError を投げる。
function arenaApplyAction(PDO $db, array $match, array $ruleset, array $actor, int $seq, string $action, int $entryId): array {
    // 先に遅延タイムアウトを流して最新状態に追いつかせる（ローカルモードは常にno-op）
    $match = arenaApplyTimeouts($db, $match, $ruleset);

    if ($match['status'] !== 'drafting') {
        throw new ArenaDraftError('この試合は現在ドラフト中ではありません', 400);
    }

    $turnIndex = (int)$match['turn_index'];

    // 楽観ロック: リクエストの seq が turn_index と一致しなければ 409
    if ($seq !== $turnIndex) {
        throw new ArenaDraftError('他の操作と競合しました。最新の状態を再取得してください', 409);
    }

    $sequence = $ruleset['sequence_decoded'];
    if (!isset($sequence[$turnIndex])) {
        throw new ArenaDraftError('ドラフト手順の範囲外です', 400);
    }
    $step = $sequence[$turnIndex];

    if (!in_array($action, ['ban', 'pick'], true) || $action !== $step['t']) {
        throw new ArenaDraftError('この手番では ' . ($step['t'] === 'ban' ? 'BAN' : 'PICK') . ' のみ実行できます', 400);
    }

    $side = $step['s'];
    if (!arenaCanAct($match, (int)$actor['id'], $side)) {
        throw new ArenaDraftError('あなたの手番ではありません', 403);
    }

    $entryStmt = $db->prepare('SELECT id FROM arena_entries WHERE id = ? AND game_id = ? AND enabled = 1');
    $entryStmt->execute([$entryId, (int)$match['game_id']]);
    if (!$entryStmt->fetch()) {
        throw new ArenaDraftError('選択したエントリーが見つかりません', 400);
    }

    $actionsStmt = $db->prepare('SELECT action, side, entry_id FROM arena_actions WHERE match_id = ?');
    $actionsStmt->execute([(int)$match['id']]);
    $rawActions = array_map(function ($r) {
        return [
            'action'   => $r['action'],
            'side'     => $r['side'],
            'entry_id' => $r['entry_id'] !== null ? (int)$r['entry_id'] : null,
        ];
    }, $actionsStmt->fetchAll());
    [$bannedIds, $pickedA, $pickedB] = arenaCollectUsedEntryIds($rawActions);
    $fearlessExcluded = arenaFearlessExcludedIds($db, $match, $ruleset);

    if (!arenaIsEntryAvailable($entryId, $side, (bool)$ruleset['mirror_allowed'], $bannedIds, $pickedA, $pickedB, $fearlessExcluded)) {
        throw new ArenaDraftError('そのエントリーは既に使用できません（BAN済みまたは選択済みです）', 400);
    }

    return arenaCommitAction($db, $match, $ruleset, $turnIndex, $action, $side, $entryId, (int)$actor['id'], false);
}
