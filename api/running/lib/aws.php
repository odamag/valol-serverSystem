<?php
// AWS API Gateway への署名付き転送ヘルパー。
//
// なぜ単純な Bearer トークンではなく HMAC 署名なのか:
// 単純な Bearer 方式だと、トークンさえ漏れれば任意の Discord ID を名乗って
// なりすませてしまう。HMAC 署名なら Discord ID そのものを署名対象に含められる
// ため、「PHP のセッション認証を通過した本人だけが、その Discord ID を名乗って
// リクエストできる」ことを AWS 側で検証できる（Discord ID と署名がセットで
// 改ざん不可能に結び付く）。

// リクエストに HMAC 署名を付けて API Gateway へ転送する。
//
// canonical string は改行区切りで以下の順（AWS 側の検証実装と厳密に一致させる
// 必要があるため、順序を変更してはいけない）:
//   method \n path \n query \n discordId \n ts \n nonce \n sha256hex(body)
//
// 戻り値: ['status' => int, 'body' => string|null]
//   接続失敗（curl エラー）の場合は status = 0, body = null を返す。
function runningForward(array $config, string $method, string $path, string $query, string $discordId, string $body): array {
    $ts    = (string)time();
    $nonce = bin2hex(random_bytes(16));

    $canon = implode("\n", [
        $method,
        $path,
        $query,
        $discordId,
        $ts,
        $nonce,
        hash('sha256', $body),
    ]);
    $signature = hash_hmac('sha256', $canon, $config['shared_secret']);

    $url = rtrim($config['api_base'], '/') . $path;
    if ($query !== '') {
        $url .= '?' . $query;
    }

    $headers = [
        'X-Run-Discord-Id: ' . $discordId,
        'X-Run-Ts: ' . $ts,
        'X-Run-Nonce: ' . $nonce,
        'X-Run-Signature: ' . $signature,
        'Content-Type: application/json',
    ];

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CUSTOMREQUEST  => $method,
        CURLOPT_POSTFIELDS     => $body,
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_CONNECTTIMEOUT => 4,
        CURLOPT_TIMEOUT        => $config['timeout'] ?? 10,
    ]);

    $responseBody = curl_exec($ch);
    if ($responseBody === false) {
        error_log('[running] curl error: ' . curl_error($ch));
        curl_close($ch);
        return ['status' => 0, 'body' => null];
    }

    $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);

    return ['status' => $status, 'body' => $responseBody];
}
