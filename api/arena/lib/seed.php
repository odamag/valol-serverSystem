<?php
// api/arena/data/*.json を初期投入（ブートストラップ）する。
// JSON は「出荷時のデフォルト」、DB が「実際に使う値」という関係にするため、
// INSERT のみ行い UPDATE は一切しない（ON CONFLICT DO NOTHING）。UI 側の編集を
// 上書きしないための取り決め。挿入した行は source='seed' にする。

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

// data/*.json を読み込んで arena_games / arena_entries / arena_rulesets に
// INSERT ONLY で投入する。毎リクエストで呼んでよい（バージョンが変わらなければ即 return）。
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
    if (!is_array($json) || empty($json['slug'])) {
        error_log('[arena] seed: invalid json in ' . $file);
        return;
    }

    $now  = time();
    $slug = (string)$json['slug'];

    $db->beginTransaction();
    try {
        $stmt = $db->prepare('
            INSERT INTO arena_games
                (slug, name, entry_label, icon, sort_order, entry_source, source, enabled, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, \'seed\', 1, ?, ?)
            ON CONFLICT(slug) DO NOTHING
        ');
        $stmt->execute([
            $slug,
            (string)($json['name'] ?? $slug),
            (string)($json['entry_label'] ?? 'キャラクター'),
            (string)($json['icon'] ?? ''),
            (int)($json['sort_order'] ?? 0),
            (string)($json['entry_source'] ?? 'manual'),
            $now,
            $now,
        ]);

        $idStmt = $db->prepare('SELECT id FROM arena_games WHERE slug = ?');
        $idStmt->execute([$slug]);
        $gameId = (int)$idStmt->fetchColumn();

        $entryStmt = $db->prepare('
            INSERT INTO arena_entries
                (game_id, slug, name, image_url, tags, source, enabled, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, \'seed\', 1, ?, ?)
            ON CONFLICT(game_id, slug) DO NOTHING
        ');
        foreach (($json['entries'] ?? []) as $entry) {
            if (empty($entry['slug']) || empty($entry['name'])) {
                continue;
            }
            $entryStmt->execute([
                $gameId,
                (string)$entry['slug'],
                (string)$entry['name'],
                (string)($entry['image_url'] ?? ''),
                (string)($entry['tags'] ?? ''),
                $now,
                $now,
            ]);
        }

        $rulesetStmt = $db->prepare('
            INSERT INTO arena_rulesets
                (game_id, slug, name, sequence, turn_seconds, mirror_allowed, fearless, is_default, source, enabled, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, \'seed\', 1, ?, ?)
            ON CONFLICT(game_id, slug) DO NOTHING
        ');
        foreach (($json['rulesets'] ?? []) as $ruleset) {
            if (empty($ruleset['slug']) || empty($ruleset['sequence'])) {
                continue;
            }
            $rulesetStmt->execute([
                $gameId,
                (string)$ruleset['slug'],
                (string)($ruleset['name'] ?? $ruleset['slug']),
                json_encode($ruleset['sequence'], JSON_UNESCAPED_UNICODE),
                (int)($ruleset['turn_seconds'] ?? 30),
                !empty($ruleset['mirror_allowed']) ? 1 : 0,
                !empty($ruleset['fearless']) ? 1 : 0,
                !empty($ruleset['is_default']) ? 1 : 0,
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
