<?php
// LoL 用 Data Dragon 同期。api/lol/streak.php と同じく cURL + タイムアウトで取得する。
// 失敗しても既存の arena_entries はそのまま（テーブルを空にしない・API全体を落とさない）。

const ARENA_DDRAGON_BASE = 'https://ddragon.leagueoflegends.com';

// タイムアウト付きで URL を取得し、JSON デコードした配列を返す。失敗時は null。
function arenaDdragonFetchJson(string $url, int $timeoutSec = 10): ?array {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => $timeoutSec,
        CURLOPT_CONNECTTIMEOUT => $timeoutSec,
        CURLOPT_USERAGENT      => 'valol-serverSystem-arena/1.0',
        CURLOPT_SSL_VERIFYPEER => true,
    ]);
    $body = curl_exec($ch);
    $err  = curl_error($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($body === false || $err !== '') {
        error_log('[arena] ddragon fetch failed: ' . $url . ' : ' . $err);
        return null;
    }
    if ($code !== 200) {
        error_log('[arena] ddragon fetch non-200: ' . $url . ' : ' . $code);
        return null;
    }
    $data = json_decode($body, true);
    if (!is_array($data)) {
        error_log('[arena] ddragon fetch invalid json: ' . $url);
        return null;
    }
    return $data;
}

// $game（entry_source='ddragon' の arena_games 行）のチャンピオンを Data Dragon から
// 取得して arena_entries に UPSERT する。失敗時は既存データを一切変更しない。
function arenaSyncDdragon(PDO $db, array $game, int $actorId): array {
    $versions = arenaDdragonFetchJson(ARENA_DDRAGON_BASE . '/api/versions.json');
    if (!is_array($versions) || empty($versions[0])) {
        return ['success' => false, 'message' => 'Data Dragon のバージョン取得に失敗しました'];
    }
    $version = (string)$versions[0];

    $champUrl = ARENA_DDRAGON_BASE . "/cdn/{$version}/data/ja_JP/champion.json";
    $champData = arenaDdragonFetchJson($champUrl, 15);
    if (!is_array($champData) || empty($champData['data']) || !is_array($champData['data'])) {
        return ['success' => false, 'message' => 'チャンピオンデータの取得に失敗しました'];
    }

    $gameId = (int)$game['id'];
    $now    = time();
    $count  = 0;

    $stmt = $db->prepare("
        INSERT INTO arena_entries (game_id, slug, name, image_url, tags, source, enabled, created_by, updated_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'seed', 1, ?, ?, ?, ?)
        ON CONFLICT(game_id, slug) DO UPDATE SET
            name = excluded.name, image_url = excluded.image_url, tags = excluded.tags,
            enabled = 1, updated_by = excluded.updated_by, updated_at = excluded.updated_at
        WHERE arena_entries.source = 'seed'
    ");

    $db->beginTransaction();
    try {
        foreach ($champData['data'] as $key => $champ) {
            $id   = (string)($champ['id'] ?? $key);
            $name = (string)($champ['name'] ?? $id);
            if ($id === '') {
                continue;
            }
            $slug = strtolower(preg_replace('/[^A-Za-z0-9]+/', '-', $id));
            $imageFile = (string)($champ['image']['full'] ?? ($id . '.png'));
            $imageUrl  = ARENA_DDRAGON_BASE . "/cdn/{$version}/img/champion/{$imageFile}";
            $tags = is_array($champ['tags'] ?? null) ? implode(',', $champ['tags']) : '';

            $stmt->execute([$gameId, $slug, $name, $imageUrl, $tags, $actorId, $actorId, $now, $now]);
            $count++;
        }
        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        error_log('[arena] ddragon upsert failed: ' . $e->getMessage());
        return ['success' => false, 'message' => 'チャンピオンデータの保存に失敗しました'];
    }

    arenaMetaSet($db, 'ddragon_synced_at', (string)$now);

    return ['success' => true, 'version' => $version, 'count' => $count];
}
