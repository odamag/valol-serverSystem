<?php
header('Content-Type: application/json; charset=utf-8');

$config  = require __DIR__ . '/config.php';
$apiKey  = $config['api_key'];
$members = $config['members'];

// 5分間のファイルキャッシュ
$cacheFile = sys_get_temp_dir() . '/lol_streak_v5_' . md5(json_encode($members)) . '.json';
$cacheTTL  = 300;

if (file_exists($cacheFile) && (time() - filemtime($cacheFile)) < $cacheTTL) {
    echo file_get_contents($cacheFile);
    exit;
}

function riotGet(string $url, string $apiKey): ?array {
    $opts = ['http' => [
        'header'        => "X-Riot-Token: {$apiKey}\r\nUser-Agent: PHP\r\n",
        'timeout'       => 10,
        'ignore_errors' => true,
    ]];
    $body = @file_get_contents($url, false, stream_context_create($opts));
    if ($body === false) return null;

    foreach ($http_response_header as $h) {
        if (preg_match('/HTTP\/\S+\s+(\d+)/', $h, $m) && (int)$m[1] !== 200) return null;
    }
    return json_decode($body, true) ?: null;
}

/**
 * PUUIDからソロ/フレックスのランク情報を取得する。
 * summoner ID が不要な新エンドポイント by-puuid を使用。
 */
function fetchRank(string $puuid, string $apiKey): array {
    $entries = riotGet("https://jp1.api.riotgames.com/lol/league/v4/entries/by-puuid/{$puuid}", $apiKey);

    if (!is_array($entries)) return ['soloRank' => null, 'flexRank' => null];

    $soloRank = null;
    $flexRank = null;
    foreach ($entries as $entry) {
        $rank = [
            'tier'   => $entry['tier'],
            'rank'   => $entry['rank'],
            'lp'     => $entry['leaguePoints'],
            'wins'   => $entry['wins'],
            'losses' => $entry['losses'],
        ];
        if ($entry['queueType'] === 'RANKED_SOLO_5x5') $soloRank = $rank;
        if ($entry['queueType'] === 'RANKED_FLEX_SR')  $flexRank = $rank;
    }
    return ['soloRank' => $soloRank, 'flexRank' => $flexRank];
}

/**
 * PUUIDからランクの連勝/連敗ストリークを計算する。
 * streak > 0 → 連勝数、streak < 0 → 連敗数（例: -3 = 3連敗）、0 = 試合なし
 */
function fetchStreak(string $puuid, string $apiKey): array {
    $ids = riotGet(
        "https://asia.api.riotgames.com/lol/match/v5/matches/by-puuid/{$puuid}/ids?type=ranked&count=20",
        $apiKey
    );
    if (!$ids) {
        return ['streak' => 0, 'lastChampion' => null, 'lastMatchTime' => null, 'recentMatches' => []];
    }

    $streak       = 0;
    $streakBroken = false;
    $firstResult  = null; // true=win, false=loss
    $lastChampion = null;
    $lastMatchTime = null;
    $recentMatches = [];

    foreach ($ids as $matchId) {
        $match = riotGet("https://asia.api.riotgames.com/lol/match/v5/matches/{$matchId}", $apiKey);
        if (!$match) continue;

        // このプレイヤーの参加情報を探す
        $p = null;
        foreach ($match['info']['participants'] as $participant) {
            if ($participant['puuid'] === $puuid) { $p = $participant; break; }
        }
        if (!$p) continue;

        $won = (bool)$p['win'];

        if ($firstResult === null) {
            // 最初の試合
            $firstResult   = $won;
            $lastChampion  = $p['championName'];
            $lastMatchTime = $match['info']['gameEndTimestamp'] ?? null;
            $streak        = $won ? 1 : -1;
        } elseif (!$streakBroken) {
            if ($won === $firstResult) {
                $streak = $won ? $streak + 1 : $streak - 1;
            } else {
                $streakBroken = true;
            }
        }

        if (count($recentMatches) < 5) {
            $recentMatches[] = [
                'win'       => $won,
                'champion'  => $p['championName'],
                'kills'     => $p['kills'],
                'deaths'    => $p['deaths'],
                'assists'   => $p['assists'],
                'timestamp' => $match['info']['gameEndTimestamp'] ?? null,
            ];
        }

        // ストリークが切れて直近5試合も揃ったら終了
        if ($streakBroken && count($recentMatches) >= 5) break;
    }

    return [
        'streak'        => $streak,
        'lastChampion'  => $lastChampion,
        'lastMatchTime' => $lastMatchTime,
        'recentMatches' => $recentMatches,
    ];
}

$results = [];

foreach ($members as $member) {
    $name        = $member['name'];
    $tag         = $member['tag'];
    $encodedName = rawurlencode($name);
    $encodedTag  = rawurlencode($tag);

    $account = riotGet(
        "https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/{$encodedName}/{$encodedTag}",
        $apiKey
    );

    if (!$account) {
        $results[] = [
            'name'          => $name,
            'tag'           => $tag,
            'error'         => 'プレイヤーが見つかりません',
            'streak'        => 0,
            'lastChampion'  => null,
            'lastMatchTime' => null,
            'recentMatches' => [],
        ];
        continue;
    }

    $puuid     = $account['puuid'];
    $streak    = fetchStreak($puuid, $apiKey);
    $rank      = fetchRank($puuid, $apiKey);
    $results[] = array_merge(
        ['name' => $account['gameName'], 'tag' => $account['tagLine']],
        $streak,
        $rank
    );
}

// 連勝/連敗の絶対値が大きい順にソート
usort($results, fn($a, $b) => abs($b['streak']) - abs($a['streak']));

$json = json_encode($results, JSON_UNESCAPED_UNICODE);
file_put_contents($cacheFile, $json);
echo $json;
