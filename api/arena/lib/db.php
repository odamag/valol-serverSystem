<?php
// Arena機能用DB接続。api/valorant/predict.php の getValDB() と同じく
// 「接続時に CREATE TABLE IF NOT EXISTS を1回 exec()」パターンを踏襲する。
// arena.db は auth.db と JOIN できないため、ユーザー名はスナップショット列で持つ。
//
// ★セクション12での再設計（要件の読み違いの訂正）：
// 「9タイトル(ゲームそのもの)をBAN/PICKして5番勝負の対戦カードを決める」仕様に合わせ、
// キャラクター単位のドラフト用テーブル（arena_entries/arena_rulesets/arena_matches/
// arena_actions）を廃止し、タイトル単位のシリーズドラフト用テーブルに置き換える。
// 本番は未デプロイ（実データ無し）のため破壊的変更として扱う。

function getArenaDB(): PDO {
    $path = dirname(__DIR__, 3) . '/db-folder/arena.db';
    $db   = new PDO('sqlite:' . $path);
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);

    // ポーリングで読み取りが増えるため WAL + busy_timeout の両方が必須
    $db->exec('PRAGMA journal_mode=WAL');
    $db->exec('PRAGMA busy_timeout=5000');

    $db->exec("
        CREATE TABLE IF NOT EXISTS arena_meta (key TEXT PRIMARY KEY, value TEXT);

        -- 9タイトルのマスタ（キャラ/エントリーの概念は廃止。あくまで「ゲームタイトル」自体）
        CREATE TABLE IF NOT EXISTS arena_games (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
          icon TEXT DEFAULT '', sort_order INTEGER DEFAULT 0,
          source TEXT DEFAULT 'seed',          -- 'seed'（JSON 由来）| 'user'（UI で作成/編集）
          enabled INTEGER DEFAULT 1,
          is_default INTEGER DEFAULT 0,        -- シリーズ作成時に初期選択されるタイトルか
          created_by INTEGER, updated_by INTEGER,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );

        -- 所持ゲーム（人によって持っているゲームが違うため）
        CREATE TABLE IF NOT EXISTS arena_user_games (
          user_id INTEGER NOT NULL, game_id INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (user_id, game_id)
        );
        CREATE INDEX IF NOT EXISTS idx_arena_user_games_game ON arena_user_games(game_id);

        -- ゲームマスタ／フォーマットを編集できる人
        CREATE TABLE IF NOT EXISTS arena_admins (
          user_id INTEGER PRIMARY KEY, username TEXT,
          granted_by INTEGER, created_at INTEGER NOT NULL
        );

        -- タイトルドラフトの書式（グローバル。タイトルごとではない）
        CREATE TABLE IF NOT EXISTS arena_formats (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
          sequence TEXT NOT NULL,             -- JSON: [{\"t\":\"ban\",\"s\":\"A\"},...]。Deciderは含めない
          pool_size INTEGER NOT NULL,         -- 9。count(sequence) + 1 と一致必須
          wins_needed INTEGER NOT NULL,       -- 3
          turn_seconds INTEGER DEFAULT 0,     -- 0 = 無制限
          is_default INTEGER DEFAULT 0, enabled INTEGER DEFAULT 1,
          source TEXT DEFAULT 'seed',
          created_by INTEGER, updated_by INTEGER,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );

        -- 5番勝負1本（タイトルドラフト〜結果確定までの単位）
        CREATE TABLE IF NOT EXISTS arena_series (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          public_id TEXT UNIQUE NOT NULL,
          format_id INTEGER NOT NULL,
          mode TEXT NOT NULL,                 -- 'local' | 'online'
          status TEXT NOT NULL,               -- waiting|roulette|drafting|playing|finished|cancelled
          player1_id INTEGER NOT NULL, player1_name TEXT NOT NULL,   -- ルーレット前の並び（作成者側）
          player2_id INTEGER,          player2_name TEXT,
          side_a_user_id INTEGER, side_b_user_id INTEGER,            -- ルーレット結果（先手/後手）
          roulette_seed TEXT, roulette_at INTEGER,
          turn_index INTEGER DEFAULT 0, turn_deadline INTEGER,
          version INTEGER NOT NULL DEFAULT 0, -- 全更新でインクリメント（ポーリング差分用）
          wins_a INTEGER DEFAULT 0, wins_b INTEGER DEFAULT 0, winner_side TEXT,
          created_by INTEGER NOT NULL,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_arena_series_status ON arena_series(status, updated_at);
        CREATE INDEX IF NOT EXISTS idx_arena_series_p1     ON arena_series(player1_id);
        CREATE INDEX IF NOT EXISTS idx_arena_series_p2     ON arena_series(player2_id);

        -- タイトルドラフトのログ（BAN/PICK/Decider）
        CREATE TABLE IF NOT EXISTS arena_series_actions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          series_id INTEGER NOT NULL, seq INTEGER NOT NULL,
          action TEXT NOT NULL,               -- 'ban' | 'pick' | 'decider'
          side TEXT,                          -- 'A' | 'B'。decider は NULL
          game_id INTEGER NOT NULL,           -- arena_games.id（＝タイトル）
          actor_id INTEGER, is_timeout INTEGER DEFAULT 0,
          created_at INTEGER NOT NULL,
          UNIQUE(series_id, seq)              -- 二重送信・同時押しを DB レベルで弾く
        );
        CREATE INDEX IF NOT EXISTS idx_arena_series_actions_series ON arena_series_actions(series_id);

        -- ドラフト対象プール（作成時に確定させる。所持タイトルの積集合が既定値）
        CREATE TABLE IF NOT EXISTS arena_series_pool (
          series_id INTEGER NOT NULL, game_id INTEGER NOT NULL,
          PRIMARY KEY (series_id, game_id)
        );

        -- 5番勝負の各試合（PICK順 = game_no。1〜4がPICK、5がDecider）
        CREATE TABLE IF NOT EXISTS arena_series_games (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          series_id INTEGER NOT NULL, game_no INTEGER NOT NULL,   -- 1..5
          game_id INTEGER NOT NULL, is_decider INTEGER DEFAULT 0,
          picked_by TEXT,                     -- 'A'|'B'。decider は NULL
          winner_side TEXT,                   -- 未実施は NULL
          reported_by INTEGER, confirmed_by INTEGER, reported_at INTEGER,
          played_at INTEGER,
          UNIQUE(series_id, game_no)
        );
        CREATE INDEX IF NOT EXISTS idx_arena_series_games_series ON arena_series_games(series_id);

        -- シーズン。配置期間の長さや引き継ぎ圧縮率をシーズンごとに持つ。
        -- 現行シーズンは ended_at IS NULL の最新行。
        CREATE TABLE IF NOT EXISTS arena_seasons (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          placement_games INTEGER NOT NULL DEFAULT 20,   -- N（配置試合数）
          offset_max REAL NOT NULL DEFAULT 100,          -- OFFSET_MAX（減衰係数 = OFFSET_MAX / N）
          compress_ratio REAL NOT NULL DEFAULT 0.7,      -- 次シーズンへの引き継ぎ圧縮率
          started_at INTEGER NOT NULL,
          ended_at INTEGER
        );

        -- レーティング。game_id の意味：正の値=タイトル別 / 0=総合 / -1=シリーズ（5番勝負）別
        CREATE TABLE IF NOT EXISTS arena_ratings (
          game_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL, username TEXT,
          rating REAL NOT NULL DEFAULT 1200,
          wins INTEGER DEFAULT 0, losses INTEGER DEFAULT 0,
          streak INTEGER DEFAULT 0,           -- 正=連勝 / 負=連敗
          peak_rating REAL DEFAULT 1200,
          -- 表示ランク（配置期間）用。rating は内部レートで、配置期間中だけ表示側を抑える
          season_games INTEGER DEFAULT 0,     -- 今シーズンの試合数
          placement_done INTEGER DEFAULT 0,   -- 配置期間を終えたか（一度立つとシーズン中は下りない）
          placement_done_at INTEGER,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (game_id, user_id)
        );

        -- game→arena_series_games.id / series→arena_series.id を ref_id に持つ
        CREATE TABLE IF NOT EXISTS arena_rating_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scope TEXT NOT NULL,                -- 'game' | 'series'
          ref_id INTEGER NOT NULL,
          game_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL, opponent_id INTEGER,
          rating_before REAL NOT NULL, rating_after REAL NOT NULL,
          result TEXT NOT NULL,               -- 'win' | 'loss'
          created_at INTEGER NOT NULL,
          UNIQUE(scope, ref_id, game_id, user_id)  -- Elo の二重反映を DB レベルで防ぐ
        );

        CREATE TABLE IF NOT EXISTS arena_api_keys (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,   -- hash('sha256', \$rawKey)
          scopes TEXT DEFAULT 'read', created_by INTEGER,
          created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER
        );
    ");

    arenaMigrate($db);

    return $db;
}

// arena_meta から値を取得（無ければ null）
function arenaMetaGet(PDO $db, string $key): ?string {
    $stmt = $db->prepare('SELECT value FROM arena_meta WHERE key = ?');
    $stmt->execute([$key]);
    $row = $stmt->fetch();
    return $row ? (string)$row['value'] : null;
}

// arena_meta へ値を保存（UPSERT）
function arenaMetaSet(PDO $db, string $key, string $value): void {
    $stmt = $db->prepare('
        INSERT INTO arena_meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    ');
    $stmt->execute([$key, $value]);
}

// 既存DBに後から列を足すための最小限のマイグレーション。
// CREATE TABLE IF NOT EXISTS は既存テーブルには何もしないため、
// 列を追加したときはここで補う（SQLiteのALTER TABLE ADD COLUMNは安全・高速）。
function arenaEnsureColumn(PDO $db, string $table, string $column, string $definition): void {
    $stmt = $db->query("PRAGMA table_info(" . $table . ")");
    foreach ($stmt->fetchAll() as $col) {
        if ($col['name'] === $column) {
            return;
        }
    }
    $db->exec("ALTER TABLE {$table} ADD COLUMN {$column} {$definition}");
}

function arenaMigrate(PDO $db): void {
    arenaEnsureColumn($db, 'arena_games', 'is_default', 'INTEGER DEFAULT 0');
    // 表示ランク（配置期間）の導入で追加した列
    arenaEnsureColumn($db, 'arena_ratings', 'season_games', 'INTEGER DEFAULT 0');
    arenaEnsureColumn($db, 'arena_ratings', 'placement_done', 'INTEGER DEFAULT 0');
    arenaEnsureColumn($db, 'arena_ratings', 'placement_done_at', 'INTEGER');
}
