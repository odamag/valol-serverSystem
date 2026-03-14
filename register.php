<?php
// アカウント作成ページ
session_start();

// DB接続
try {
    $db = new PDO('sqlite:db-folder/auth.db');
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
} catch(PDOException $e) {
    die("DB接続エラー: " . $e->getMessage());
}

// アカウント作成処理
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['action']) && $_POST['action'] === 'register') {
    $user_id = $_POST['user_id'];
    $username = $_POST['username'];
    
    // ランダムなシークレットキーを生成（Base32形式）
    $otp_secret = base32_encode(random_bytes(10));
    
    try {
        // ユーザーを登録
        $stmt = $db->prepare("INSERT INTO users (user_id, username, otp_secret) VALUES (?, ?, ?)");
        $stmt->execute([$user_id, $username, $otp_secret]);
        
        // 登録成功メッセージとシークレットキーを表示
        $success = "アカウントが作成されました。以下はOTP生成用のシークレットキーです。これを安全な場所に保存してください。<br><br>";
        $success .= "<strong>" . $otp_secret . "</strong><br><br>";
        $success .= "このキーを使って、OTP認証アプリ（例：Google Authenticator）を設定してください。";
        
    } catch(PDOException $e) {
        if ($e->getCode() == 23000) { // 重複エラー
            $error = "ユーザーIDが既に使用されています";
        } else {
            $error = "アカウント作成に失敗しました: " . $e->getMessage();
        }
    }
}

// Base32エンコード関数（PHP標準では提供されていない）
function base32_encode($data) {
    $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    $bits = '';
    
    // バイトデータをビットに変換
    foreach (unpack('C*', $data) as $byte) {
        $bits .= str_pad(decbin($byte), 8, '0', STR_PAD_LEFT);
    }
    
    // 5ビットごとに分割してアルファベットに変換
    $result = '';
    for ($i = 0; $i < strlen($bits); $i += 5) {
        if ($i + 5 <= strlen($bits)) {
            $chunk = substr($bits, $i, 5);
            $index = bindec($chunk);
            if ($index < 32) {
                $result .= $alphabet[$index];
            }
        }
    }
    
    return $result;
}

?>

<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>アカウント作成</title>
    <style>
        body { font-family: sans-serif; text-align: center; padding: 20px; background: #f4f4f9; color: #333; }
        .container { max-width: 500px; margin: 50px auto; background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); }
        input { width: 100%; padding: 12px; margin: 10px 0; border: 1px solid #ddd; border-radius: 8px; box-sizing: border-box; }
        button { background: #0984e3; color: white; padding: 15px; border: none; border-radius: 8px; cursor: pointer; width: 100%; font-size: 16px; }
        button:hover { background: #076bc2; }
        .error { color: #d63031; margin: 10px 0; }
        .success { color: #00b894; margin: 10px 0; background: #e6fffa; padding: 15px; border-radius: 8px; }
        a { color: #0984e3; text-decoration: none; }
    </style>
</head>
<body>
    <div class="container">
        <h2>アカウント作成</h2>
        
        <?php if (isset($error)): ?>
            <p class="error"><?php echo htmlspecialchars($error); ?></p>
        <?php endif; ?>
        
        <?php if (isset($success)): ?>
            <p class="success"><?php echo $success; ?></p>
        <?php endif; ?>
        
        <?php if (!isset($success)): ?>
        <form method="post">
            <input type="hidden" name="action" value="register">
            <input type="text" name="user_id" placeholder="ユーザーID" required>
            <input type="text" name="username" placeholder="ユーザー名" required>
            <button type="submit">アカウント作成</button>
        </form>
        <?php endif; ?>
        
        <p><a href="login.php">ログインする</a></p>
    </div>
</body>
</html>