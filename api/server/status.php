<?php
session_start();
require_once dirname(__DIR__) . '/common.php';

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
        'name' => '⛏️ Minecraft',
        'tag'  => 'minecraft',
        'port' => 25565,
    ],
    'palworld' => [
        'name' => '🐼 Palworld',
        'tag'  => 'palworld',
        'port' => 8211,
    ],
    '7days' => [
        'name' => '🧟 7 Days to Die',
        'tag'  => '7days',
        'port' => 26900,
    ],
];

try {
    $ec2 = new Ec2Client([
        'version'     => 'latest',
        'region'      => $creds['AWS_REGION'],
        'credentials' => ['key' => $creds['AWS_KEY'], 'secret' => $creds['AWS_SECRET']],
    ]);
} catch (Exception $e) {
    jsonResponse(['success' => false, 'message' => 'AWS接続エラー: ' . $e->getMessage()], 500);
}

$result  = [];
$message = '';

foreach ($servers as $key => $conf) {
    $entry = [
        'name'         => $conf['name'],
        'port'         => $conf['port'],
        'state'        => 'stopped',
        'displayState' => 'stopped',
        'ip'           => '',
        'instanceId'   => '',
        'gameStatus'   => '',
    ];

    try {
        $res = $ec2->describeInstances([
            'Filters' => [
                ['Name' => 'tag:Name', 'Values' => [$conf['tag']]],
                ['Name' => 'instance-state-name', 'Values' => ['pending', 'running', 'stopping', 'shutting-down']],
            ],
        ]);

        if (!empty($res['Reservations'])) {
            $inst = $res['Reservations'][0]['Instances'][0];
            $entry['state']      = $inst['State']['Name'];
            $entry['ip']         = $inst['PublicIpAddress'] ?? '';
            $entry['instanceId'] = $inst['InstanceId'];
            foreach ($inst['Tags'] ?? [] as $tag) {
                if ($tag['Key'] === 'GameStatus') {
                    $entry['gameStatus'] = $tag['Value'];
                }
            }
        }
    } catch (Exception $e) {
        $message .= "状態取得エラー({$key}): " . $e->getMessage() . ' ';
    }

    $lockFile = $root . '/starting_' . $key . '.lock';
    $s        = $entry['state'];
    $gs       = $entry['gameStatus'];

    if ($s === 'shutting-down' || $s === 'stopping') {
        $entry['displayState'] = 'closing';
    } elseif ($s === 'running') {
        $entry['displayState'] = ($gs === 'Online') ? 'ready' : 'loading';
    } elseif (file_exists($lockFile) && (time() - filemtime($lockFile) < 120) && $s === 'stopped') {
        $entry['displayState'] = 'pending';
    }

    $result[$key] = $entry;
}

jsonResponse(['servers' => $result, 'message' => trim($message)]);
