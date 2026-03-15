<?php
// ▼▼▼ エラーを表示させる設定 ▼▼▼
ini_set('display_errors', 1);
ini_set('display_startup_errors', 1);
error_reporting(E_ALL);
$creds = include('config.php');

// ==========================================================
// ★★★ 設定エリア ★★★
// ==========================================================
$aws_config = [
    'region' => $creds['AWS_REGION'],       // 東京リージョン
    'key'    => $creds['AWS_KEY'],
    'secret' => $creds['AWS_SECRET'],
];

$servers = [
    'minecraft' => [
        'name'    => '⛏️ Minecraft',
        'lt_id'   => $creds['MINECRAFT_LT_ID'], // Minecraft用の起動テンプレートID
        'tag'     => 'minecraft',       // Nameタグ
        'port'    => 25565,
        'image'   => 'background: #2d3436;', // カードの装飾用
    ],
    'palworld' => [
        'name'    => '🐼 Palworld',
        'lt_id'   => $creds['PALLWORLD_LT_ID'], // Palworld用の起動テンプレートID
        'tag'     => 'palworld',        // Nameタグ
        'port'    => 8211,
        'image'   => 'background: #0984e3;',
    ],
];
// ==========================================================

// DB接続
try {
    $db = new PDO('sqlite:db-folder/auth.db');
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
} catch(PDOException $e) {
    die("DB接続エラー: " . $e->getMessage());
}

// ユーザーがログインしているか確認
session_start();
$is_logged_in = isset($_SESSION['user_id']);
$user_id = $_SESSION['user_id'] ?? null;
$username = $_SESSION['username'] ?? null;

// AWS SDKの読み込み
if (!file_exists('aws.phar')) {
    die('<h2 style="color:red">エラー: aws.phar が見つかりません</h2>');
}
require 'aws.phar';
use Aws\Ec2\Ec2Client;

if (empty($aws_config['key']) || empty($aws_config['secret'])) {
    die('<h2 style="color:red">設定エラー: キーが入力されていません</h2>');
}

// EC2クライアント作成
try {
    $ec2 = new Ec2Client([
        'version' => 'latest',
        'region'  => $aws_config['region'],
        'credentials' => [
            'key'    => $creds['AWS_KEY'],
            'secret' => $creds['AWS_SECRET']
        ],
    ]);
} catch (Exception $e) {
    die("AWS Client Error: " . $e->getMessage());
}

$message = "";

// --- アクション処理 ---
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['action']) && isset($_POST['target'])) {
    $target = $_POST['target'];
    if (!isset($servers[$target])) die("Unknown target");

    $conf = $servers[$target];
    $lock_file = "starting_{$target}.lock";

    // 起動処理
    if ($_POST['action'] === 'start') {
        if (file_exists($lock_file) && (time() - filemtime($lock_file) < 120)) {
            $message = "⚠️ {$conf['name']} は起動処理中です。";
        } else {
            file_put_contents($lock_file, time());
            try {
                // すでに起動していないか最終確認（終了中も含む）
                $check = $ec2->describeInstances([
                    'Filters' => [
                        ['Name' => 'tag:Name', 'Values' => [$conf['tag']]],
                        ['Name' => 'instance-state-name', 'Values' => ['pending', 'running', 'shutting-down', 'stopping']]
                    ]
                ]);
                
                if (empty($check['Reservations'])) {
                    $ec2->runInstances([
                        'LaunchTemplate' => ['LaunchTemplateId' => $conf['lt_id'], 'Version' => '$Latest'],
                        'MinCount' => 1, 'MaxCount' => 1,
                        'InstanceMarketOptions' => [
                            'MarketType' => 'spot',
                            'SpotOptions' => ['SpotInstanceType' => 'one-time', 'InstanceInterruptionBehavior' => 'terminate'],
                        ],
                        'TagSpecifications' => [[
                            'ResourceType' => 'instance',
                            'Tags' => [
                                ['Key' => 'Name', 'Value' => $conf['tag']],
                                ['Key' => 'GameStatus', 'Value' => 'Booting']
                            ]
                        ]]
                    ]);
                    header("Location: " . $_SERVER['PHP_SELF'] . "?t=" . time()); exit;
                } else {
                    // 終了処理中でもここに来るので起動を防げる
                    $message = "⚠️ すでに起動しているか、終了処理中です。";
                }
            } catch (Exception $e) {
                $message = "起動エラー: " . $e->getMessage();
                @unlink($lock_file);
            }
        }
    }

    // 停止処理
    if ($_POST['action'] === 'stop' && isset($_POST['instance_id'])) {
        try {
            $ec2->terminateInstances(['InstanceIds' => [$_POST['instance_id']]]);
            @unlink($lock_file);
            header("Location: " . $_SERVER['PHP_SELF'] . "?t=" . time()); exit;
        } catch (Exception $e) { $message = "停止エラー: " . $e->getMessage(); }
    }
}

// --- ステータス確認 ---
foreach ($servers as $key => $conf) {
    $servers[$key]['state'] = 'stopped'; // AWS上のステータス
    $servers[$key]['ip'] = '';
    $servers[$key]['gameStatus'] = '';
    $servers[$key]['instanceId'] = '';
    $servers[$key]['displayState'] = 'stopped'; // 画面表示用の判定

    try {
        $result = $ec2->describeInstances([
            'Filters' => [
                ['Name' => 'tag:Name', 'Values' => [$conf['tag']]],
                // ここで終了中のステータスも取得するのが重要
                ['Name' => 'instance-state-name', 'Values' => ['pending', 'running', 'stopping', 'shutting-down']]
            ]
        ]);
        
        if (!empty($result['Reservations'])) {
            $inst = $result['Reservations'][0]['Instances'][0];
            $servers[$key]['state'] = $inst['State']['Name'];
            $servers[$key]['ip'] = $inst['PublicIpAddress'] ?? '';
            $servers[$key]['instanceId'] = $inst['InstanceId'];
            if (isset($inst['Tags'])) {
                foreach ($inst['Tags'] as $t) {
                    if ($t['Key'] === 'GameStatus') { $servers[$key]['gameStatus'] = $t['Value']; break; }
                }
            }
        }
    } catch (Exception $e) {
        $message .= "状態取得エラー: " . $e->getMessage() . "<br>";
    }

    $s_state = $servers[$key]['state'];
    $s_game  = $servers[$key]['gameStatus'];
    $lock_f  = "starting_{$key}.lock";

    // ▼▼▼ 判定ロジックの修正 ▼▼▼
    if ($s_state === 'shutting-down' || $s_state === 'stopping') {
        // AWSが「終了中」と言っている場合
        $servers[$key]['displayState'] = 'closing';
    }
    elseif ($s_state === 'running') {
        $servers[$key]['displayState'] = ($s_game === 'Online') ? 'ready' : 'loading';
    }
    elseif (file_exists($lock_f) && (time() - filemtime($lock_f) < 120) && $s_state === 'stopped') {
        $servers[$key]['displayState'] = 'pending';
    }
    // それ以外は stopped (起動ボタン表示)
}
?>

<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>マイクラ & パルワールド管理</title>
    <style>
        body { font-family: sans-serif; text-align: center; padding: 20px; background: #f4f4f9; color: #333; }
        .container { display: flex; flex-wrap: wrap; justify-content: center; gap: 20px; }
        .card { background: white; width: 350px; padding: 20px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); display: flex; flex-direction: column; justify-content: space-between; }
        .card-header { padding: 10px; border-radius: 8px 8px 0 0; color: white; margin: -20px -20px 20px -20px; }
        .status { margin-bottom: 20px; padding: 10px; border-radius: 8px; font-weight: bold; }
        
        .status.ready   { background: #e6fffa; color: #00b894; border: 2px solid #00b894; }
        .status.loading { background: #fff7e6; color: #ff9f43; border: 2px solid #ff9f43; }
        .status.pending { background: #dfe6e9; color: #636e72; }
        .status.closing { background: #fab1a0; color: #d63031; border: 2px solid #d63031; } /* 新しい終了中スタイル */
        .status.stopped { background: #ffeaa7; color: #d63031; }

        .ip-box { background: #2d3436; color: #fff; padding: 15px; border-radius: 8px; font-size: 1.1em; margin: 10px 0; cursor: pointer; word-break: break-all; }
        button { border: none; padding: 15px; border-radius: 30px; font-size: 16px; font-weight: bold; cursor: pointer; width: 100%; transition:0.2s;}
        button:active { transform: scale(0.98); }
        button:disabled { background-color: #b2bec3; cursor: not-allowed; transform: none; }
        .btn-start { background: #0984e3; color: white; }
        .btn-stop { background: #d63031; color: white; margin-top: 10px; }
        .header-links { margin-bottom: 20px; }
        .header-links a { margin: 0 10px; color: #0984e3; text-decoration: none; }
    </style>
    <script>
        setTimeout(() => {
            const url = location.href.split('?')[0] + '?t=' + new Date().getTime();
            location.href = url;
        }, 5000);

        function submitForm(btn, msg) {
            if(confirm(msg)) {
                btn.disabled = true;
                btn.innerText = '処理中...';
                btn.form.submit();
            }
            return false;
        }
        function submitStart(btn) {
            btn.disabled = true;
            btn.innerText = '🚀 起動リクエスト中...';
            btn.form.submit();
            return false;
        }
    </script>
</head>
<body>
    <h1>🎮 Server Controller</h1>
    
    <?php if ($is_logged_in): ?>
        <div class="header-links">
            <a href="./profile.php">マイページ</a>
            <a href="./logout.php">ログアウト</a>
        </div>
        <p>ようこそ、<?php echo htmlspecialchars($username); ?> さん</p>
    <?php else: ?>
        <div class="header-links">
            <a href="./login.php">ログイン</a>
            <a href="./register.php">アカウント作成</a>
        </div>
    <?php endif; ?>
    
    <?php if ($message): ?><p style="color:#d63031; font-weight:bold;"><?php echo $message; ?></p><?php endif; ?>

    <div class="container">
    <?php foreach ($servers as $key => $s): ?>
        <div class="card">
            <div class="card-header" style="<?php echo $s['image']; ?>">
                <h2><?php echo $s['name']; ?></h2>
            </div>

            <?php if ($s['displayState'] === 'ready'): ?>
                <div class="status ready">✨ オンライン ✨</div>
                <p>IPをタップしてコピー</p>
                <div class="ip-box" onclick="navigator.clipboard.writeText('<?php echo $s['ip'] . ':' . $s['port']; ?>');alert('コピーしました')">
                    <?php echo $s['ip']; ?>:<?php echo $s['port']; ?>
                </div>
                <form method="post">
                    <input type="hidden" name="action" value="stop">
                    <input type="hidden" name="target" value="<?php echo $key; ?>">
                    <input type="hidden" name="instance_id" value="<?php echo $s['instanceId']; ?>">
                    <button type="button" class="btn-stop" 
                        onclick="submitForm(this, '本当に停止しますか？')">
                        停止
                    </button>
                </form>

            <?php elseif ($s['displayState'] === 'loading'): ?>
                <div class="status loading">⏳ 起動処理中...</div>
                <p>起動完了まで数分かかります。</p>

            <?php elseif ($s['displayState'] === 'pending'): ?>
                <div class="status pending">🚀 サーバー準備中...</div>
                <p>インスタンスを作成しています</p>

            <?php elseif ($s['displayState'] === 'closing'): ?>
                <div class="status closing">🔴 終了処理中...</div>
                <p>データを保存して電源を切っています。<br>完全に消えるまで数分お待ちください。</p>
                <button disabled>起動できません</button>

            <?php else: ?>
                <div class="status stopped">停止中</div>
                <form method="post">
                    <input type="hidden" name="action" value="start">
                    <input type="hidden" name="target" value="<?php echo $key; ?>">
                    <button type="button" class="btn-start" onclick="submitStart(this)">起動する</button>
                </form>
            <?php endif; ?>
        </div>
    <?php endforeach; ?>
    </div>
    <div>
        <a href="./minigame.html">ミニゲーム</a>
        <br/>
        <a href="./pong_p2p.html">エアホッケー</a>
        <br/>
        <a href="./linegame/index.html">ライン通過ゲーム</a>
        <br/>
        <a href="https://www.notion.so/Minecraft-Server-2fcb31a2feb68015b9f5fc19b6cf793f?source=copy_link">ノーション</a>
    </div>
</body>
