<?php
// ログインページ
session_start();

// DB接続
try {
    $db = new PDO('sqlite:db-folder/auth.db');
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
} catch(PDOException $e) {
    die("DB接続エラー: " . $e->getMessage());
}

// ログイン処理
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['action']) && $_POST['action'] === 'login') {
    $user_id = $_POST['user_id'];
    $otp = $_POST['otp'];
    
    // ユーザーを検索
    $stmt = $db->prepare("SELECT id, user_id, username, otp_secret FROM users WHERE user_id = ?");
    $stmt->execute([$user_id]);
    $user = $stmt->fetch(PDO::FETCH_ASSOC);
    
    if ($user) {
        // OTP検証（HMAC-SHA1を使用）
        if (verify_otp($user['otp_secret'], $otp)) {
            // ログイン成功
            $_SESSION['user_id'] = $user['id'];
            $_SESSION['username'] = $user['username'];
            header("Location: index.php");
            exit();
        } else {
            $error = "無効なOTPです";
        }
    } else {
        $error = "ユーザーが見つかりません";
    }
}

function verify_otp($secret, $otp) {
    // TOTP (Time-based One-Time Password)を生成して比較
    $timestamp = floor(time() / 30); // 30秒ごとに変化
    
    // HMAC-SHA1でOTPを計算
    $hash = hash_hmac('sha1', pack('N*', 0) . $timestamp, $secret, true);
    $offset = ord($hash[19]) & 0xf;
    $truncated = (ord($hash[$offset]) & 0x7f) << 24 |
                 (ord($hash[$offset + 1]) & 0xff) << 16 |
                 (ord($hash[$offset + 2]) & 0xff) << 8 |
                 (ord($hash[$offset + 3]) & 0xff);
    
    $otp_value = $truncated % 1000000;
    return $otp_value == $otp;
}

?>

<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ログイン</title>
    <style>
        body { font-family: sans-serif; text-align: center; padding: 20px; background: #f4f4f9; color: #333; }
        .container { max-width: 400px; margin: 50px auto; background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); }
        input { width: 100%; padding: 12px; margin: 10px 0; border: 1px solid #ddd; border-radius: 8px; box-sizing: border-box; }
        button { background: #0984e3; color: white; padding: 15px; border: none; border-radius: 8px; cursor: pointer; width: 100%; font-size: 16px; }
        button:hover { background: #076bc2; }
        .error { color: #d63031; margin: 10px 0; }
        a { color: #0984e3; text-decoration: none; }
    </style>
</head>
<body>
    <div class="container">
        <h2>ログイン</h2>
        <?php if (isset($error)): ?>
            <p class="error"><?php echo htmlspecialchars($error); ?></p>
        <?php endif; ?>
        
        <form method="post">
            <input type="hidden" name="action" value="login">
            <input type="text" name="user_id" placeholder="ユーザーID" required>
            <input type="text" name="otp" placeholder="OTP" required>
            <button type="submit">ログイン</button>
        </form>
        
        <p><a href="register.php">アカウントを作成する</a></p>
    </div>
</body>
</html>