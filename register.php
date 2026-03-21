<?php
// アカウント作成ページ
session_start();

// 既にログインしている場合はマイページにリダイレクト
if (isset($_SESSION['user_id'])) {
    header("Location: ./start_server.php");
    exit();
}

$error = "";
$success = "";
$id = "";
$username = "";
$secret_key = "";

// アカウント作成処理
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $id = $_POST['id'] ?? '';
    $username = $_POST['username'] ?? '';
    
    if (empty($id) || empty($username)) {
        $error = "IDとユーザー名を入力してください";
    } else {
        try {
            // DB接続
            $db = new PDO('sqlite:db-folder/auth.db');
            $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
            
            // ユーザーが既に存在するか確認
            $stmt = $db->prepare("SELECT id FROM users WHERE user_id = ?");
            $stmt->execute([$id]);
            if ($stmt->fetch()) {
                $error = "そのIDはすでに使用されています";
            } else {
                // 新しいシークレットキーを生成 (Base32)
                $secret_key = generateSecretKey();
                
                // ユーザーを登録
                $stmt = $db->prepare("INSERT INTO users (user_id, username, otp_secret) VALUES (?, ?, ?)");
                $stmt->execute([$id, $username, $secret_key]);
                
                $success = "アカウントが作成されました。";
            }
        } catch (PDOException $e) {
            $error = "アカウント作成エラー: " . $e->getMessage();
        }
    }
}

// シークレットキー生成関数
function generateSecretKey() {
    // Base32でエンコードされたランダムなシークレットキーを生成
    $length = 16; // 16文字のBase32キー (より安全)
    $chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    $key = "";
    
    for ($i = 0; $i < $length; $i++) {
        $key .= $chars[rand(0, strlen($chars) - 1)];
    }
    
    return $key;
}

// QRコード生成関数
function generateQRCode($user_id, $secret_key) {
    // qrcode_lib/qrlib.phpからOTP URIを取得
    require_once 'qrcode_lib/qrlib.php';
    if (class_exists('QRCode')) {
        $qr = new QRCode();
        return $qr->getOTPURI($user_id, $secret_key, "ServerController");
    } else {
        // フォールバック：直接URIを生成
        $uri = "otpauth://totp/ServerController:" . urlencode($user_id);
        $uri .= "?secret=" . urlencode($secret_key);
        $uri .= "&issuer=ServerController";
        $uri .= "&algorithm=SHA1";
        $uri .= "&digits=6";
        $uri .= "&period=30";
        return $uri;
    }
}

?>

<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>アカウント作成 - Server Controller</title>
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
        input[type="text"] {
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
        .success {
            color: #00b894;
            background: #e6fffa;
            padding: 10px;
            border-radius: 8px;
            margin: 10px 0;
        }
        .secret-key {
            background: #f8f9fa;
            border: 1px solid #ddd;
            padding: 15px;
            border-radius: 8px;
            margin: 20px 0;
            font-family: monospace;
            word-break: break-all;
        }
        .qr-code {
            margin: 20px 0;
        }
        .qr-code img {
            max-width: 200px;
            height: auto;
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
        <h1>👤 アカウント作成</h1>
        
        <?php if ($error): ?>
            <div class="error"><?php echo htmlspecialchars($error); ?></div>
        <?php endif; ?>
        
        <?php if ($success): ?>
            <div class="success"><?php echo htmlspecialchars($success); ?></div>
            <div class="secret-key">
                あなたのシークレットキー:<br>
                <strong><?php echo $secret_key ?? ''; ?></strong>
            </div>
            <div class="qr-code">
                <p>QRコードをGoogle Authenticatorにスキャンしてください:</p>
                <?php
                // 使用するQRコードライブラリのOTP URIを生成
                $otp_uri = generateQRCode($id, $secret_key);
                // 既存のQRコード表示方式を使用
                echo "<p><img src='https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=" . urlencode($otp_uri) . "' alt='QR Code'></p>";
                echo "<p>または、以下のURIをOTPアプリに登録してください:</p>";
                echo "<p style='font-family: monospace; word-break: break-all;'>" . htmlspecialchars($otp_uri) . "</p>";
                ?>
            </div>
            <p>このシークレットキーをOTP認証アプリに登録してください。</p>
        <?php else: ?>
            <form method="post">
                <input type="text" name="id" placeholder="ユーザーID" required>
                <input type="text" name="username" placeholder="ユーザー名" required>
                <button type="submit">アカウント作成</button>
            </form>
        <?php endif; ?>
        
        <div class="links">
            <a href="./login.php">ログイン</a>
        </div>
    </div>
</body>
</html>
