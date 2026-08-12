<?php
session_start();
require_once dirname(__DIR__) . '/common.php';
requireAuth();

$aiConfig = require dirname(__DIR__) . '/ai_config.php';
$apiKey   = $aiConfig['ANTHROPIC_API_KEY'] ?? '';
if (!$apiKey) {
    jsonResponse(['success' => false, 'message' => 'AI設定が未完了です'], 503);
}

$body   = json_decode(file_get_contents('php://input'), true) ?? [];
$action = $body['action'] ?? '';

switch ($action) {
    case 'chat': handleChat($body, $apiKey); break;
    default: jsonResponse(['success' => false, 'message' => '不明なアクション'], 400);
}

// レート制限チェック（1時間に20回）
function checkRateLimit(int $userId): void {
    $db = getDB();
    $db->exec("
        CREATE TABLE IF NOT EXISTS bot_requests (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    INTEGER NOT NULL,
            created_at INTEGER NOT NULL
        )
    ");
    $since = time() - 3600;
    $stmt  = $db->prepare('SELECT COUNT(*) FROM bot_requests WHERE user_id = ? AND created_at > ?');
    $stmt->execute([$userId, $since]);
    $count = (int) $stmt->fetchColumn();

    if ($count >= 20) {
        jsonResponse(['success' => false, 'message' => '1時間のリクエスト上限（20回）に達しました。しばらく待ってください。'], 429);
    }
    $db->prepare('INSERT INTO bot_requests (user_id, created_at) VALUES (?, ?)')->execute([$userId, time()]);
}

function handleChat(array $body, string $apiKey): void {
    checkRateLimit((int) $_SESSION['user_id']);

    $message      = trim($body['message'] ?? '');
    $championData = $body['champion_data'] ?? [];
    if (!$message || !$championData) {
        jsonResponse(['success' => false, 'message' => 'パラメータ不足'], 400);
    }

    $ctx    = buildChampionContext($championData);
    $system = 'あなたはLeague of Legendsの専門AIアシスタントです。'
            . 'チャンピオンのデータに基づいて、日本語で簡潔かつ実用的なアドバイスを提供してください。'
            . '回答は300文字以内を目安にしてください。'
            . 'アイテムビルドやメタに関する質問には、あなたの学習データには情報のカットオフがあるため最新パッチと異なる場合があることを必ず断ったうえで回答してください。'
            . '最新ビルドはOP.GGやu.gg等の外部サイトで確認するよう案内してください。';

    $payload = json_encode([
        'model'      => 'claude-haiku-4-5-20251001',
        'max_tokens' => 512,
        'system'     => $system,
        'messages'   => [
            ['role' => 'user', 'content' => "【チャンピオン情報】\n{$ctx}\n\n【質問】\n{$message}"],
        ],
    ], JSON_UNESCAPED_UNICODE);

    $ch = curl_init('https://api.anthropic.com/v1/messages');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 20,
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => $payload,
        CURLOPT_HTTPHEADER     => [
            'Content-Type: application/json',
            'x-api-key: ' . $apiKey,
            'anthropic-version: 2023-06-01',
        ],
    ]);
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);

    if ($httpCode !== 200 || !$response) {
        jsonResponse(['success' => false, 'message' => 'AI APIエラーが発生しました'], 502);
    }

    $data    = json_decode($response, true);
    $content = $data['content'][0]['text'] ?? '';
    jsonResponse(['success' => true, 'reply' => $content]);
}

function buildChampionContext(array $d): string {
    $name     = $d['name']  ?? '不明';
    $title    = $d['title'] ?? '';
    $tags     = implode(', ', $d['tags'] ?? []);
    $stats    = $d['stats'] ?? [];
    $statsStr = "HP:{$stats['hp']} AD:{$stats['attackdamage']} "
              . "移動速度:{$stats['movespeed']} 射程:{$stats['attackrange']}";

    $spellKeys = ['Q', 'W', 'E', 'R'];
    $spells    = '';
    foreach (($d['spells'] ?? []) as $i => $spell) {
        $key    = $spellKeys[$i] ?? $i;
        $spells .= "{$key}: {$spell['name']} - {$spell['description']}\n";
    }

    $passive     = $d['passive']['name']        ?? '';
    $passiveDesc = $d['passive']['description'] ?? '';

    return "名前:{$name}（{$title}）\nロール:{$tags}\nステータス:{$statsStr}\n"
         . "パッシブ:{$passive} - {$passiveDesc}\nスキル:\n{$spells}";
}
