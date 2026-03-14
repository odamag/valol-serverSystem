<?php
// マイページ
session_start();

// DB接続
try {
    $db = new PDO('sqlite:db-folder/auth.db');
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
} catch(PDOException $e) {
    die("DB接続エラー: " . $e->getMessage());
}

// ユーザーがログインしているか確認
if (!isset($_SESSION['user_id'])) {
    header("Location: login.php");
    exit();
}

$user_id = $_SESSION['user_id'];
$username = $_SESSION['username'];

// アカウント削除処理
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['action']) && $_POST['action'] === 'delete_account') {
    try {
        // ユーザーを削除
        $stmt = $db->prepare("DELETE FROM users WHERE id = ?");
        $stmt->execute([$user_id]);
        
        // セッションを破棄してログアウト
        $_SESSION = array();
        if (ini_get("session.use_cookies")) {
            $params = session_get_cookie_params();
            setcookie(session_name(), '', time() - 42000,
                $params["path"], $params["domain"],
                $params["secure"], $params["httponly"]
            );
        }
        session_destroy();
        
        // ログインページへリダイレクト
        header("Location: login.php");
        exit();
    } catch(PDOException $e) {
        $error = "アカウント削除に失敗しました: " . $e->getMessage();
    }
}

?>

<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>マイページ</title>
    <style>
        body { font-family: sans-serif; text-align: center; padding: 20px; background: #f4f4f9; color: #333; }
        .container { max-width: 500px; margin: 50px auto; background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); }
        .user-info { margin: 20px 0; padding: 15px; background: #e6fffa; border-radius: 8px; }
        button { background: #0984e3; color: white; padding: 15px; border: none; border-radius: 8px; cursor: pointer; width: 100%; font-size: 16px; margin: 10px 0; }
        button:hover { background: #076bc2; }
        .btn-delete { background: #d63031; }
        .btn-delete:hover { background: #c41e2a; }
        .error { color: #d63031; margin: 10px 0; }
        a { color: #0984e3; text-decoration: none; }
    </style>
</head>
<body>
    <div class="container">
        <h2>マイページ</h2>
        
        <div class="user-info">
            <p><strong>ユーザーID:</strong> <?php echo htmlspecialchars($user_id); ?></p>
            <p><strong>ユーザー名:</strong> <?php echo htmlspecialchars($username); ?></p>
        </div>
        
        <?php if (isset($error)): ?>
            <p class="error"><?php echo htmlspecialchars($error); ?></p>
        <?php endif; ?>
        
        <form method="post" onsubmit="return confirm('本当にアカウントを削除しますか？')">
            <input type="hidden" name="action" value="delete_account">
            <button type="submit" class="btn-delete">アカウント削除</button>
        </form>
        
        <p><a href="logout.php">ログアウト</a></p>
    </div>
</body>
</html>