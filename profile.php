<?php
// マイページ
session_start();

// ログインしていない場合はログインページにリダイレクト
if (!isset($_SESSION['user_id'])) {
    header("Location: ./login.php");
    exit();
}

$user_id = $_SESSION['user_id'];
$username = $_SESSION['username'];

$error = "";
$success = "";

// アカウント削除処理
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['action'])) {
    if ($_POST['action'] === 'delete_account') {
        try {
            // DB接続
            $db = new PDO('sqlite:db-folder/auth.db');
            $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
            
            // ユーザーを削除
            $stmt = $db->prepare("DELETE FROM users WHERE id = ?");
            $stmt->execute([$user_id]);
            
            // セッションを破棄
            session_destroy();
            
            $success = "アカウントが削除されました。";
            header("Refresh: 3; URL=./login.php");
        } catch (PDOException $e) {
            $error = "アカウント削除エラー: " . $e->getMessage();
        }
    }
}

?>

<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>マイページ - Server Controller</title>
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
            max-width: 600px;
            margin: 50px auto;
            background: white;
            padding: 30px;
            border-radius: 12px;
            box-shadow: 0 4px 15px rgba(0,0,0,0.1);
        }
        h1 { color: #0984e3; margin-bottom: 30px; }
        .user-info {
            background: #f8f9fa;
            border: 1px solid #ddd;
            padding: 20px;
            border-radius: 8px;
            margin: 20px 0;
        }
        .user-info p {
            margin: 10px 0;
            font-size: 18px;
        }
        .btn {
            background: #0984e3;
            color: white;
            border: none;
            padding: 15px;
            border-radius: 30px;
            font-size: 16px;
            font-weight: bold;
            cursor: pointer;
            width: 100%;
            margin: 10px 0;
        }
        .btn:hover {
            background: #076cc2;
        }
        .btn-delete {
            background: #d63031;
        }
        .btn-delete:hover {
            background: #c32424;
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
        <h1>👤 マイページ</h1>
        
        <?php if ($error): ?>
            <div class="error"><?php echo htmlspecialchars($error); ?></div>
        <?php endif; ?>
        
        <?php if ($success): ?>
            <div class="success"><?php echo htmlspecialchars($success); ?></div>
        <?php else: ?>
            <div class="user-info">
                <p><strong>ユーザーID:</strong> <?php echo htmlspecialchars($user_id); ?></p>
                <p><strong>ユーザー名:</strong> <?php echo htmlspecialchars($username); ?></p>
            </div>
            
            <form method="post" onsubmit="return confirm('本当にアカウントを削除しますか？')">
                <input type="hidden" name="action" value="delete_account">
                <button type="submit" class="btn btn-delete">アカウント削除</button>
            </form>
        <?php endif; ?>
        
        <div class="links">
            <a href="./start_server.php">ホームに戻る</a>
            <a href="./logout.php">ログアウト</a>
        </div>
    </div>
</body>
</html>