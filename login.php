<?php
// ログインページ
session_start();

// 既にログインしている場合はマイページにリダイレクト
if (isset($_SESSION['user_id'])) {
    header("Location: ./start_server.php");
    exit();
}

$error = "";

// ログイン処理
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $id = $_POST['id'] ?? '';
    $otp = $_POST['otp'] ?? '';
    
    if (empty($id) || empty($otp)) {
        $error = "IDとOTPを入力してください";
    } else {
        try {
            // DB接続
            $db = new PDO('sqlite:db-folder/auth.db');
            $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
            
            // ユーザーを検索
            $stmt = $db->prepare("SELECT id, username, otp_secret FROM users WHERE user_id = ?");
            $stmt->execute([$id]);
            $user = $stmt->fetch(PDO::FETCH_ASSOC);
            
            if ($user) {
                // OTPの検証
                $secret = $user['otp_secret'];
                $valid = verifyTOTP($secret, $otp);
                
                if ($valid) {
                    // ログイン成功
                    $_SESSION['user_id'] = $user['id'];
                    $_SESSION['username'] = $user['username'];
                    header("Location: ./start_server.php");
                    exit();
                } else {
                    $error = "OTPが正しくありません";
                }
            } else {
                $error = "ユーザーが見つかりません";
            }
        } catch (PDOException $e) {
            $error = "ログイン処理エラー: " . $e->getMessage();
        }
    }
}

// TOTP検証関数
function verifyTOTP($secret, $otp) {
    // Base32デコード
    $key = base32_decode($secret);
    
    // 現在時刻のタイムスタンプを取得（30秒ごとの周期）
    $timestamp = floor(time() / 30);
    
    // シークレットと現在のタイムスタンプを使ってハッシュを生成
    $hash = hash_hmac('sha1', pack('N*', 0) . pack('N*', $timestamp), $key, true);
    
    // ハッシュからオフセットを取得
    $offset = ord($hash[19]) & 0x0F;
    
    // TOTPを生成
    $otp_value = (
        ((ord($hash[$offset]) & 0x7F) << 24) |
        ((ord($hash[$offset + 1]) & 0xFF) << 16) |
        ((ord($hash[$offset + 2]) & 0xFF) << 8) |
        (ord($hash[$offset + 3]) & 0xFF)
    ) % 1000000;
    
    // 6桁のOTPにフォーマット
    $otp_value = sprintf('%06d', $otp_value);
    
    return hash_equals($otp_value, $otp);
}

// Base32デコード関数
function base32_decode($input) {
    $chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    $bits = "";
    $output = "";
    
    for ($i = 0; $i < strlen($input); $i++) {
        $pos = strpos($chars, strtoupper($input[$i]));
        if ($pos !== false) {
            $bits .= str_pad(decbin($pos), 5, '0', STR_PAD_LEFT);
        }
    }
    
    for ($i = 0; $i < strlen($bits); $i += 8) {
        $byte = substr($bits, $i, 8);
        if (strlen($byte) == 8) {
            $output .= chr(bindec($byte));
        }
    }
    
    return $output;
}

?>

<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ログイン - Server Controller</title>
    <style>
        body { 
            font-family: sans-serif; 
            text-align: center; 
            padding: 20px; 
            background: #f4f4f9; 
            color: #333; 
            margin: 0;
            padding: 20px;
        }
        .container {
            max-width: 400px;
            margin: 50px auto;
            background: white;
            padding: 30px;
            border-radius: 12px;
            box-shadow: 0 4px 15px rgba(0,0,0,0.1);
        }
        h1 { color: #0984e3; margin-bottom: 30px; }
        input[type="text"], input[type="password"] {
            width: 100%;
            padding: 12px;
            margin: 10px 0;
            border: 1px solid #ddd;
            border-radius: 8px;
            box-sizing: border-box;
        }
        button {
            background: #0984e3;
            color: white;
            border: none;
            padding: 15px;
            border-radius: 30px;
            font-size: 16px;
            font-weight: bold;
            cursor: pointer;
            width: 100%;
            margin-top: 10px;
        }
        button:hover {
            background: #076cc2;
        }
        .error {
            color: #d63031;
            background: #ffeaa7;
            padding: 10px;
            border-radius: 8px;
            margin: 10px 0;
        }
        .links {
            margin-top: 20px;
        }
        .links a {
            color: #0984e3;
            text-decoration: none;
            margin: 0 10px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🔐 ログイン</h1>
        
        <?php if ($error): ?>
            <div class="error"><?php echo htmlspecialchars($error); ?></div>
        <?php endif; ?>
        
        <form method="post">
            <input type="text" name="id" placeholder="ユーザーID" required>
            <input type="password" name="otp" placeholder="6桁のOTP" required>
            <button type="submit">ログイン</button>
        </form>
        
        <div class="links">
            <a href="./register.php">アカウント作成</a>
        </div>
    </div>
</body>
</html>