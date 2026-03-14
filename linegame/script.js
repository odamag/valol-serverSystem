// グローバル変数
let canvas = document.getElementById('gameCanvas');
let ctx = canvas.getContext('2d');
let passwordInput = document.getElementById('passwordInput');
let connectButton = document.getElementById('connectButton');
let startButton = document.getElementById('startButton');
let restartButton = document.getElementById('restartButton');
let player1ScoreElement = document.getElementById('player1Score');
let player2ScoreElement = document.getElementById('player2Score');
let connectionStatus = document.getElementById('connectionStatus');
let gameOverScreen = document.getElementById('gameOver');
let winnerText = document.getElementById('winnerText');

// ゲーム状態
let gameRunning = false;
let players = [];
let enemies = [];
let password = '';
let player1Score = 0;
let player2Score = 0;

// プレイヤークラス
class Player {
    constructor(x, y, color, controls) {
        this.x = x;
        this.y = y;
        this.radius = 15;
        this.color = color;
        this.controls = controls;
        this.speed = 2; // 減速しました
        this.resetPosition = {x: x, y: y};
        this.scored = false; // ポイント獲得フラグ
    }
    
    draw() {
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
        ctx.fillStyle = this.color;
        ctx.fill();
        ctx.closePath();
    }
    
    update() {
        // キー入力による移動
        if (this.controls.up && this.y > this.radius) {
            this.y -= this.speed;
        }
        if (this.controls.down && this.y < canvas.height - this.radius) {
            this.y += this.speed;
        }
        if (this.controls.left && this.x > this.radius) {
            this.x -= this.speed;
        }
        if (this.controls.right && this.x < canvas.width - this.radius) {
            this.x += this.speed;
        }
        
        // 上ライン通過判定（ポイント獲得は一度だけ）
        if (this.y <= 20 && this.y + this.radius >= 20 && !this.scored) {
            // ポイント加算後、下のラインに戻る
            this.resetPosition = {x: this.x, y: canvas.height - 20}; // 下のラインに戻る
            // ポイントを1つだけ獲得するように変更
            if (this.color === '#FF0000') {
                player1Score++;
                player1ScoreElement.textContent = `プレイヤー1: ${player1Score}`;
            } else {
                player2Score++;
                player2ScoreElement.textContent = `プレイヤー2: ${player2Score}`;
            }
            this.scored = true; // ポイント獲得済みにする
        }
    }
    
    reset() {
        this.x = this.resetPosition.x;
        this.y = this.resetPosition.y;
        this.scored = false; // リセット時にポイント獲得フラグをリセット
    }
}

// 敵クラス
class Enemy {
    constructor(x, y, width, height, speed, lineIndex) {
        this.x = x;
        this.y = y;
        this.width = width;
        this.height = height;
        this.speed = speed;
        this.lineIndex = lineIndex; // 行番号を追加
        // 敵は左右から生成される
        if (lineIndex % 2 === 0) {
            // 偶数行: 左から右へ
            this.direction = 1;
            this.x = -this.width; // 左端から開始
        } else {
            // 奇数行: 右から左へ
            this.direction = -1;
            this.x = canvas.width; // 右端から開始
        }
    }
    
    draw() {
        ctx.fillStyle = '#8B4513';
        ctx.fillRect(this.x, this.y, this.width, this.height);
        
        // 敵の目を描画
        ctx.fillStyle = 'white';
        ctx.beginPath();
        ctx.arc(this.x + 10, this.y + 10, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.closePath();
        
        ctx.beginPath();
        ctx.arc(this.x + this.width - 10, this.y + 10, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.closePath();
    }
    
    update() {
        this.x += this.speed * this.direction;
        
        // 壁に当たったら方向を反転（この場合は無視、敵は画面外に出たら消える）
    }
}

// ゲーム初期化
function initGame() {
    players = [
        new Player(100, canvas.height - 20, '#FF0000', {up: false, down: false, left: false, right: false}),
        new Player(canvas.width - 100, canvas.height - 20, '#0000FF', {up: false, down: false, left: false, right: false})
    ];
    
    // 敵を生成（行ごとに異なる位置から生成）
    enemies = [];
    const lines = 5; // 行数
    for (let i = 0; i < lines; i++) {
        const y = 50 + i * 80; // 各行のy座標を調整（間隔を狭くする）
        let x, speed;
        // ランダムな速度を設定
        speed = 1 + Math.random() * 3; // 1〜4の速度
        
        // 奇数行と偶数行で生成位置を変更
        if (i % 2 === 0) {
            // 偶数行: 左端から右へ
            x = -50;
        } else {
            // 奇数行: 右端から左へ
            x = canvas.width;
        }
        
        enemies.push(new Enemy(x, y, 80, 30, speed, i));
    }
    
    // キー入力イベントリスナー
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);
    
    gameRunning = true;
    gameLoop();
}

// キー入力処理
function handleKeyDown(e) {
    if (!gameRunning) return;
    
    const key = e.key.toLowerCase();
    
    // プレイヤー1 (赤)
    if (key === 'w') players[0].controls.up = true;
    if (key === 's') players[0].controls.down = true;
    if (key === 'a') players[0].controls.left = true;
    if (key === 'd') players[0].controls.right = true;
    
    // プレイヤー2 (青)
    if (key === 'arrowup') players[1].controls.up = true;
    if (key === 'arrowdown') players[1].controls.down = true;
    if (key === 'arrowleft') players[1].controls.left = true;
    if (key === 'arrowright') players[1].controls.right = true;
}

function handleKeyUp(e) {
    const key = e.key.toLowerCase();
    
    // プレイヤー1 (赤)
    if (key === 'w') players[0].controls.up = false;
    if (key === 's') players[0].controls.down = false;
    if (key === 'a') players[0].controls.left = false;
    if (key === 'd') players[0].controls.right = false;
    
    // プレイヤー2 (青)
    if (key === 'arrowup') players[1].controls.up = false;
    if (key === 'arrowdown') players[1].controls.down = false;
    if (key === 'arrowleft') players[1].controls.left = false;
    if (key === 'arrowright') players[1].controls.right = false;
}

// 衝突判定
function checkCollision(player, enemy) {
    return player.x < enemy.x + enemy.width &&
           player.x + player.radius > enemy.x &&
           player.y < enemy.y + enemy.height &&
           player.y + player.radius > enemy.y;
}

// ゲームループ
function gameLoop() {
    if (!gameRunning) return;
    
    // キャンバスをクリア
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // ラインを描画
    drawLines();
    
    // 敵を更新・描画
    enemies.forEach(enemy => {
        enemy.update();
        enemy.draw();
    });
    
    // プレイヤーを更新・描画
    players.forEach(player => {
        player.update();
        player.draw();
        
        // 衝突判定
        enemies.forEach(enemy => {
            if (checkCollision(player, enemy)) {
                player.reset();
            }
        });
    });
    
    // 敵が画面外に出たら削除して新しい敵を生成
    enemies = enemies.filter(enemy => {
        return enemy.x > -enemy.width && enemy.x < canvas.width + enemy.width;
    });
    
    // 新しい敵を追加（一定間隔で）
    if (Math.random() < 0.02) { // 約50fpsで0.02の確率で新しい敵を生成
        const lines = 5; // 行数
        const lineIndex = Math.floor(Math.random() * lines); // ランダムな行を選択
        const y = 50 + lineIndex * 80; // 選択された行のy座標を調整（間隔を狭くする）
        let x, speed;
        // ランダムな速度を設定
        speed = 1 + Math.random() * 3; // 1〜4の速度
        
        // 奇数行と偶数行で生成位置を変更
        if (lineIndex % 2 === 0) {
            // 偶数行: 左端から右へ
            x = -50;
        } else {
            // 奇数行: 右端から左へ
            x = canvas.width;
        }
        
        enemies.push(new Enemy(x, y, 80, 30, speed, lineIndex));
    }
    
    // ゲーム終了条件チェック
    if (player1Score >= 5 || player2Score >= 5) {
        endGame();
        return;
    }
    
    requestAnimationFrame(gameLoop);
}

// ラインを描画
function drawLines() {
    // 下ライン
    ctx.beginPath();
    ctx.moveTo(0, canvas.height - 20);
    ctx.lineTo(canvas.width, canvas.height - 20);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;
    ctx.stroke();
    
    // 上ライン
    ctx.beginPath();
    ctx.moveTo(0, 20);
    ctx.lineTo(canvas.width, 20);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;
    ctx.stroke();
    
    // 中央線（点線）
    ctx.beginPath();
    ctx.setLineDash([10, 10]);
    ctx.moveTo(canvas.width / 2, 0);
    ctx.lineTo(canvas.width / 2, canvas.height);
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.setLineDash([]);
}

// ゲーム終了
function endGame() {
    gameRunning = false;
    
    if (player1Score > player2Score) {
        winnerText.textContent = "プレイヤー1の勝利！";
    } else if (player2Score > player1Score) {
        winnerText.textContent = "プレイヤー2の勝利！";
    } else {
        winnerText.textContent = "引き分け！";
    }
    
    gameOverScreen.classList.remove('hidden');
}

// P2P接続処理（シミュレーション）
function connectToGame() {
    password = passwordInput.value.trim();
    if (password === '') {
        alert('合言葉を入力してください');
        return;
    }
    
    // シミュレーション：接続成功
    connectionStatus.textContent = '接続状況: 接続済み';
    connectButton.disabled = true;
    startButton.disabled = false;
    passwordInput.disabled = true;
    
    // プレイヤーの初期位置を設定
    players[0].x = 100;
    players[0].y = canvas.height - 20;
    players[1].x = canvas.width - 100;
    players[1].y = canvas.height - 20;
}

// ゲーム開始
function startGame() {
    if (gameRunning) return;
    
    initGame();
    startButton.disabled = true;
}

// 再開
function restartGame() {
    player1Score = 0;
    player2Score = 0;
    player1ScoreElement.textContent = `プレイヤー1: ${player1Score}`;
    player2ScoreElement.textContent = `プレイヤー2: ${player2Score}`;
    
    gameOverScreen.classList.add('hidden');
    
    // ゲーム再初期化
    initGame();
}

// ボタンイベントリスナー
connectButton.addEventListener('click', connectToGame);
startButton.addEventListener('click', startGame);
restartButton.addEventListener('click', restartGame);

// 初期状態
connectionStatus.textContent = '接続状況: 待機中';