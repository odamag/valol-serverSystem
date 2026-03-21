<?php
session_start();
require_once dirname(__DIR__) . '/common.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed'], 405);
}

$root  = dirname(dirname(__DIR__));
$creds = include($root . '/config.php');

$awsPhar = $root . '/lib/aws.phar';
if (!file_exists($awsPhar)) {
    jsonResponse(['success' => false, 'message' => 'aws.phar が見つかりません'], 500);
}
require $awsPhar;
use Aws\Ec2\Ec2Client;

$servers = [
    'minecraft' => [
        'name'  => '⛏️ Minecraft',
        'lt_id' => $creds['MINECRAFT_LT_ID'],
        'tag'   => 'minecraft',
    ],
    'palworld' => [
        'name'  => '🐼 Palworld',
        'lt_id' => $creds['PALLWORLD_LT_ID'],
        'tag'   => 'palworld',
    ],
];

$data       = json_decode(file_get_contents('php://input'), true);
$action     = $data['action']     ?? '';
$target     = $data['target']     ?? '';
$instanceId = $data['instanceId'] ?? '';

if (!isset($servers[$target])) {
    jsonResponse(['success' => false, 'message' => '不明なターゲット']);
}

$conf     = $servers[$target];
$lockFile = $root . '/starting_' . $target . '.lock';

try {
    $ec2 = new Ec2Client([
        'version'     => 'latest',
        'region'      => $creds['AWS_REGION'],
        'credentials' => ['key' => $creds['AWS_KEY'], 'secret' => $creds['AWS_SECRET']],
    ]);
} catch (Exception $e) {
    jsonResponse(['success' => false, 'message' => 'AWS接続エラー: ' . $e->getMessage()]);
}

if ($action === 'start') {
    if (file_exists($lockFile) && (time() - filemtime($lockFile) < 120)) {
        jsonResponse(['success' => false, 'message' => "⚠️ {$conf['name']} は起動処理中です。"]);
    }

    file_put_contents($lockFile, time());

    try {
        $check = $ec2->describeInstances([
            'Filters' => [
                ['Name' => 'tag:Name', 'Values' => [$conf['tag']]],
                ['Name' => 'instance-state-name', 'Values' => ['pending', 'running', 'shutting-down', 'stopping']],
            ],
        ]);

        if (!empty($check['Reservations'])) {
            jsonResponse(['success' => false, 'message' => '⚠️ すでに起動しているか、終了処理中です。']);
        }

        $ec2->runInstances([
            'LaunchTemplate' => ['LaunchTemplateId' => $conf['lt_id'], 'Version' => '$Latest'],
            'MinCount'       => 1,
            'MaxCount'       => 1,
            'InstanceMarketOptions' => [
                'MarketType'  => 'spot',
                'SpotOptions' => ['SpotInstanceType' => 'one-time', 'InstanceInterruptionBehavior' => 'terminate'],
            ],
            'TagSpecifications' => [[
                'ResourceType' => 'instance',
                'Tags'         => [
                    ['Key' => 'Name',       'Value' => $conf['tag']],
                    ['Key' => 'GameStatus', 'Value' => 'Booting'],
                ],
            ]],
        ]);

        jsonResponse(['success' => true, 'message' => '🚀 起動リクエストを送信しました']);
    } catch (Exception $e) {
        @unlink($lockFile);
        jsonResponse(['success' => false, 'message' => '起動エラー: ' . $e->getMessage()]);
    }
}

if ($action === 'stop') {
    if (empty($instanceId)) {
        jsonResponse(['success' => false, 'message' => 'instance_id が必要です']);
    }
    try {
        $ec2->terminateInstances(['InstanceIds' => [$instanceId]]);
        @unlink($lockFile);
        jsonResponse(['success' => true, 'message' => '停止リクエストを送信しました']);
    } catch (Exception $e) {
        jsonResponse(['success' => false, 'message' => '停止エラー: ' . $e->getMessage()]);
    }
}

jsonResponse(['success' => false, 'message' => '不明なアクション']);
