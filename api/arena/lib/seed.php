<?php
// api/arena/data/*.json を初期投入（ブートストラップ）する。
// JSON は「出荷時のデフォルト」、DB が「実際に使う値」という関係にするため、
// INSERT のみ行い UPDATE は一切しない（ON CONFLICT DO NOTHING）。UI 側の編集を
// 上書きしないための取り決め。挿入した行は source='seed' にする。
//
// セクション12の再設計により、投入対象は「9タイトルのゲームマスタ」と
// 「タイトルドラフトのフォーマット」の2種類になった（キャラ/ルールセットは廃止）。

// data/*.json 全体のハッシュ（内容が変わらない限り毎回読み直さない）
function arenaSeedFingerprint(string $dataDir): string {
    $files = glob($dataDir . '/*.json') ?: [];
    sort($files);
    $parts = [];
    foreach ($files as $f) {
        $parts[] = basename($f) . ':' . filemtime($f) . ':' . filesize($f);
    }
    return sha1(implode('|', $parts));
}

// data/*.json を読み込んで arena_games / arena_formats に INSERT ONLY で投入する。
// 毎リクエストで呼んでよい（バージョンが変わらなければ即 return）。
function arenaSeed(PDO $db): void {
    $dataDir = __DIR__ . '/../data';
    if (!is_dir($dataDir)) {
        return;
    }

    $fingerprint = arenaSeedFingerprint($dataDir);
    $current     = arenaMetaGet($db, 'seed_version');
    if ($current === $fingerprint) {
        return;
    }

    $files = glob($dataDir . '/*.json') ?: [];
    sort($files);

    foreach ($files as $file) {
        try {
            arenaSeedOneFile($db, $file);
        } catch (Throwable $e) {
            // 1ファイルの不正な JSON が API 全体を落とさないようにする
            error_log('[arena] seed failed for ' . $file . ': ' . $e->getMessage());
        }
    }

    arenaMetaSet($db, 'seed_version', $fingerprint);
}

function arenaSeedOneFile(PDO $db, string $file): void {
    $json = json_decode(file_get_contents($file), true);
    if (!is_array($json)) {
        error_log('[arena] seed: invalid json in ' . $file);
        return;
    }

    $now = time();

    $db->beginTransaction();
    try {
        $gameStmt = $db->prepare('
            INSERT INTO arena_games (slug, name, icon, sort_order, source, enabled, created_at, updated_at)
            VALUES (?, ?, ?, ?, \'seed\', 1, ?, ?)
            ON CONFLICT(slug) DO NOTHING
        ');
        foreach (($json['games'] ?? []) as $game) {
            if (empty($game['slug']) || empty($game['name'])) {
                continue;
            }
            $gameStmt->execute([
                (string)$game['slug'],
                (string)$game['name'],
                (string)($game['icon'] ?? ''),
                (int)($game['sort_order'] ?? 0),
                $now,
                $now,
            ]);
        }

        $formatStmt = $db->prepare('
            INSERT INTO arena_formats
                (slug, name, sequence, pool_size, wins_needed, turn_seconds, is_default, source, enabled, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, \'seed\', 1, ?, ?)
            ON CONFLICT(slug) DO NOTHING
        ');
        foreach (($json['formats'] ?? []) as $format) {
            if (empty($format['slug']) || empty($format['sequence'])) {
                continue;
            }
            $poolSize   = (int)($format['pool_size'] ?? 0);
            $winsNeeded = (int)($format['wins_needed'] ?? 0);
            $sequence   = is_array($format['sequence']) ? $format['sequence'] : [];
            if (arenaValidateFormatSequence($sequence, $poolSize, $winsNeeded) !== null) {
                error_log('[arena] seed: invalid format sequence for ' . $format['slug']);
                continue;
            }
            $formatStmt->execute([
                (string)$format['slug'],
                (string)($format['name'] ?? $format['slug']),
                json_encode($sequence, JSON_UNESCAPED_UNICODE),
                $poolSize,
                $winsNeeded,
                (int)($format['turn_seconds'] ?? 0),
                !empty($format['is_default']) ? 1 : 0,
                $now,
                $now,
            ]);
        }

        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        throw $e;
    }
}
