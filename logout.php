<?php
// ログアウト処理
session_start();

// セッションを破棄
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
?>