<?php
// タイトルドラフト書式（arena_formats）まわりの検証・読み込みヘルパー。

// フォーマットの sequence を検証する。
// - 空でない配列で、各要素は {"t":"ban"|"pick","s":"A"|"B"}
// - count(sequence) + 1 が pool_size と一致（Decider の1枠を足してプールを使い切る）
// - PICK数 + 1（Decider）が「シリーズの試合数」。wins_needed はその過半数より多く、
//   試合数以下でなければならない（例: 5試合なら 3〜5）
// 問題なければ null、問題があれば日本語のエラーメッセージを返す。
function arenaValidateFormatSequence(array $seq, int $poolSize, int $winsNeeded): ?string {
    if (empty($seq) || array_keys($seq) !== range(0, count($seq) - 1)) {
        return 'sequence は空でない配列（BAN/PICKの手順リスト）で指定してください';
    }

    $bans  = 0;
    $picks = 0;
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
        if ($t === 'ban') {
            $bans++;
        } else {
            $picks++;
        }
    }

    if ($poolSize <= 0) {
        return 'pool_size は正の整数で指定してください';
    }
    if (count($seq) + 1 !== $poolSize) {
        return 'sequence の手数（' . count($seq) . '）+ 1（Decider分）が pool_size（' . $poolSize . '）と一致しません';
    }

    // シリーズの試合数 = PICKされたタイトル数 + Decider(1試合)
    $games = $picks + 1;
    if ($winsNeeded <= 0) {
        return 'wins_needed は正の整数で指定してください';
    }
    if (!($winsNeeded > $games / 2 && $winsNeeded <= $games)) {
        return "wins_needed は {$games} 試合中の過半数（{$games}試合の半分より多い数）以上、{$games}以下で指定してください";
    }

    return null;
}

// id からフォーマットを取得し、sequence を配列にデコードして 'sequence_decoded' に入れて返す。
function arenaLoadFormat(PDO $db, int $formatId): ?array {
    $stmt = $db->prepare('SELECT * FROM arena_formats WHERE id = ?');
    $stmt->execute([$formatId]);
    $row = $stmt->fetch();
    if (!$row) {
        return null;
    }
    $row['sequence_decoded'] = json_decode($row['sequence'], true) ?: [];
    return $row;
}

// クライアント/管理画面向けにフォーマット1件をシリアライズする。
function arenaSerializeFormatRow(array $row): array {
    return [
        'id'           => (int)$row['id'],
        'slug'         => $row['slug'],
        'name'         => $row['name'],
        'sequence'     => json_decode($row['sequence'], true) ?: [],
        'pool_size'    => (int)$row['pool_size'],
        'wins_needed'  => (int)$row['wins_needed'],
        'turn_seconds' => (int)$row['turn_seconds'],
        'is_default'   => (bool)$row['is_default'],
        'enabled'      => (bool)$row['enabled'],
        'source'       => $row['source'],
    ];
}
