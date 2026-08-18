<?php
// Arena機能用DB接続。api/valorant/predict.php の getValDB() と同じく
// 「接続時に CREATE TABLE IF NOT EXISTS を1回 exec()」パターンを踏襲する。
// arena.db は auth.db と JOIN できないため、ユーザー名はスナップショット列で持つ。

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

        CREATE TABLE IF NOT EXISTS arena_games (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
          entry_label TEXT NOT NULL DEFAULT 'キャラクター',   -- 「チャンピオン」「エージェント」「マップ」
          icon TEXT DEFAULT '', sort_order INTEGER DEFAULT 0,
          entry_source TEXT DEFAULT 'manual',  -- 'manual' | 'ddragon'（LoL のみ外部同期）
          source TEXT DEFAULT 'seed',          -- 'seed'（JSON 由来）| 'user'（UI で作成/編集）
          enabled INTEGER DEFAULT 1,
          created_by INTEGER, updated_by INTEGER,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS arena_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          game_id INTEGER NOT NULL, slug TEXT NOT NULL, name TEXT NOT NULL,
          image_url TEXT DEFAULT '', tags TEXT DEFAULT '',
          source TEXT DEFAULT 'seed', enabled INTEGER DEFAULT 1,
          created_by INTEGER, updated_by INTEGER,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          UNIQUE(game_id, slug)
        );
        CREATE INDEX IF NOT EXISTS idx_arena_entries_game ON arena_entries(game_id, enabled);

        CREATE TABLE IF NOT EXISTS arena_rulesets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          game_id INTEGER NOT NULL, slug TEXT NOT NULL, name TEXT NOT NULL,
          sequence TEXT NOT NULL,             -- JSON: [{\"t\":\"ban\",\"s\":\"A\"},{\"t\":\"pick\",\"s\":\"B\"},...]
          turn_seconds INTEGER DEFAULT 30,    -- 0 = 無制限
          mirror_allowed INTEGER DEFAULT 0,   -- 相手と同じエントリーを選べるか
          fearless INTEGER DEFAULT 0,         -- 同一シリーズ内で使用済みを再選択不可
          is_default INTEGER DEFAULT 0,
          source TEXT DEFAULT 'seed', enabled INTEGER DEFAULT 1,
          created_by INTEGER, updated_by INTEGER,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          UNIQUE(game_id, slug)
        );

        -- 所持ゲーム（人によって持っているゲームが違うため）
        CREATE TABLE IF NOT EXISTS arena_user_games (
          user_id INTEGER NOT NULL, game_id INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (user_id, game_id)
        );
        CREATE INDEX IF NOT EXISTS idx_arena_user_games_game ON arena_user_games(game_id);

        -- ゲームマスタを編集できる人
        CREATE TABLE IF NOT EXISTS arena_admins (
          user_id INTEGER PRIMARY KEY, username TEXT,
          granted_by INTEGER, created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS arena_matches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          public_id TEXT UNIQUE NOT NULL,     -- 8文字ルームコード（URL / Discord 共有用）
          game_id INTEGER NOT NULL, ruleset_id INTEGER NOT NULL,
          mode TEXT NOT NULL,                 -- 'local' | 'online'
          status TEXT NOT NULL,               -- waiting|drafting|playing|reported|finished|cancelled
          player_a_id INTEGER NOT NULL, player_a_name TEXT NOT NULL,
          player_b_id INTEGER,                player_b_name TEXT,
          turn_index INTEGER DEFAULT 0,       -- sequence 上の現在位置
          turn_deadline INTEGER,              -- unix秒。NULL = 無制限
          version INTEGER NOT NULL DEFAULT 0, -- 全更新でインクリメント（ポーリング差分用）
          winner_side TEXT, score_a INTEGER DEFAULT 0, score_b INTEGER DEFAULT 0,
          reported_by INTEGER, confirmed_by INTEGER,
          series_id TEXT,                     -- フィアレス / BO3 用
          created_by INTEGER NOT NULL,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_arena_matches_status ON arena_matches(status, updated_at);
        CREATE INDEX IF NOT EXISTS idx_arena_matches_pa     ON arena_matches(player_a_id);
        CREATE INDEX IF NOT EXISTS idx_arena_matches_pb     ON arena_matches(player_b_id);
        CREATE INDEX IF NOT EXISTS idx_arena_matches_series ON arena_matches(series_id);

        CREATE TABLE IF NOT EXISTS arena_actions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          match_id INTEGER NOT NULL, seq INTEGER NOT NULL,
          action TEXT NOT NULL,               -- 'ban' | 'pick'
          side TEXT NOT NULL,                 -- 'A' | 'B'
          entry_id INTEGER, actor_id INTEGER, is_timeout INTEGER DEFAULT 0,
          created_at INTEGER NOT NULL,
          UNIQUE(match_id, seq)               -- 二重送信・同時押しを DB レベルで弾く
        );

        CREATE TABLE IF NOT EXISTS arena_ratings (
          game_id INTEGER NOT NULL,           -- 0 = 総合
          user_id INTEGER NOT NULL, username TEXT,
          rating REAL NOT NULL DEFAULT 1200,
          wins INTEGER DEFAULT 0, losses INTEGER DEFAULT 0,
          streak INTEGER DEFAULT 0,           -- 正=連勝 / 負=連敗
          peak_rating REAL DEFAULT 1200, updated_at INTEGER NOT NULL,
          PRIMARY KEY (game_id, user_id)
        );

        CREATE TABLE IF NOT EXISTS arena_rating_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          match_id INTEGER NOT NULL, game_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL, opponent_id INTEGER,
          rating_before REAL NOT NULL, rating_after REAL NOT NULL,
          result TEXT NOT NULL,               -- 'win' | 'loss'
          created_at INTEGER NOT NULL,
          UNIQUE(match_id, game_id, user_id)  -- Elo の二重反映を DB レベルで防ぐ
        );

        CREATE TABLE IF NOT EXISTS arena_api_keys (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,   -- hash('sha256', \$rawKey)
          scopes TEXT DEFAULT 'read', created_by INTEGER,
          created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER
        );
    ");

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
