# 04. データの置き場所

移行時に**本番から持ってくる必要があるもの**の一覧でもある（`db-folder/*.db` は Git に入っていない）。

## SQLite（`db-folder/`）

テーブルはすべて、接続するたびに `CREATE TABLE IF NOT EXISTS` で作るスタイル。マイグレーションの仕組みは Arena の列追加（`arenaEnsureColumn`）だけ。
日時はほぼ UNIX 秒の INTEGER。

### `auth.db` — ユーザーと認証（全機能が参照）

| テーブル | 主な列 | 用途 |
|---|---|---|
| `users` | `id` PK, `user_id` UNIQUE（ログイン ID or `discord_<id>`）, `username`, `otp_secret`（Base32 平文） | ユーザー本体。**全 DB の `user_id` はこの `id`** |
| `discord_users` | `discord_id` PK, `user_id` UNIQUE, `created_at` | Discord ID との紐付け。ランニングはこれで Discord ID を引く |
| `site_tokens` | `token` UNIQUE, `device_name`, `created_at`, `last_used_at` | サイト合言葉のデバイストークン |
| `bot_requests` | `user_id`, `created_at` | AI 質問の回数制限 |

※ `document/database_design.md` の `users` には `created_at`/`updated_at` があるが、Discord ログイン側で作られた場合は列が無い可能性がある（どちらが先に作ったかで構造が変わる）。**本番 DB の実際のスキーマを `.schema` で確認すること。**
※ OTP シークレットは暗号化せず保存している。

### `lol_predict.db` — LoL 予想

| テーブル | 用途 |
|---|---|
| `lol_matches` | 試合（`match_id` UNIQUE、チーム名・コード、リーグ、予定時刻、`result`、`is_resolved`） |
| `lol_predictions` | 投票（`UNIQUE(user_id, match_id)`、`prediction` = team1/team2） |
| `lol_points` | ユーザーごとの累計ポイント（`username` を複製して持つ） |
| `lol_meta` | KV（最終同期時刻など） |

WAL モード。

### `valorant_predict.db` — VALORANT 予想

`val_matches`（`tournament`, `round_info`, `is_manual` が追加）/ `val_predictions` / `val_points` / `val_meta`。構造は LoL とほぼ同じ。

### `arena.db` — バンピック & ランキング

詳しくは `document/arena_design.md` と `api/arena/lib/db.php`。

| テーブル | 用途 |
|---|---|
| `arena_games` | ゲームタイトルのマスタ（初期値は `api/arena/data/titles.json` から投入） |
| `arena_user_games` | 所持ゲーム |
| `arena_formats` | ドラフト書式（BAN/PICK の順序 JSON、プール数、勝利数、制限時間） |
| `arena_series` | 5 番勝負 1 本の状態（`status`、`version` でポーリング差分） |
| `arena_series_actions` | BAN/PICK のログ（`UNIQUE(series_id, seq)`） |
| `arena_series_pool` | シリーズごとの対象タイトル |
| `arena_series_games` | 各試合の勝敗・申告者・承認者 |
| `arena_seasons` | シーズン（配置試合数、引き継ぎ圧縮率） |
| `arena_ratings` | Elo（`game_id`: 正=タイトル別 / 0=総合 / -1=シリーズ） |
| `arena_rating_history` | Elo 変動の履歴（二重反映防止の UNIQUE） |
| `arena_admins` | 管理者 |
| `arena_api_keys` | API キー（SHA-256 ハッシュ、scopes） |
| `arena_meta` | KV（設定値など） |

`busy_timeout=5000`。ユーザー名を各テーブルに複製して持っている（`auth.db` と JOIN できないため）。

### DB をまたぐ関係

```
auth.db: users.id ──┬── lol_predict.db:      lol_predictions.user_id / lol_points.user_id
                    ├── valorant_predict.db: val_predictions.user_id / val_points.user_id
                    ├── arena.db:            arena_*.user_id / player*_id / created_by ...
                    └── discord_users.user_id ── discord_id ── AWS DynamoDB の U#<discordId>
```

ファイルが分かれているので外部キーも JOIN も無い。アカウント削除しても他 DB の行は残る。
移行で 1 つの DB にまとめるなら、ここを外部キーでつなぎ直せる。

## AWS（ランニング記録）

| 置き場所 | 中身 |
|---|---|
| DynamoDB `running`（1 テーブル設計） | `pk`/`sk` + `GSI1`（`gsi1pk` × `distanceM` でランキング）。ユーザープロフィール `U#<discordId>/PROFILE`、記録、月・週・通算の集計、ランキング、設定、HMAC の nonce（TTL で自動削除） |
| S3 写真バケット | ランニングの写真。一時置き場のプレフィックスは 1 日で消える |
| SSM Parameter Store `/running/*` | Discord Bot Token、HMAC 共有シークレット |

キー設計の詳細は `aws/src/lib/keys.ts`。

## ファイル・その他

| 場所 | 中身 | 移行で必要か |
|---|---|---|
| PHP セッション（サーバのセッションディレクトリ） | ログイン状態、`site_auth`、Discord OAuth の state | 不要（再ログインでよい） |
| `starting_<target>.lock`（サイトのルート） | ゲームサーバー起動中フラグ（120 秒） | 不要 |
| `sys_get_temp_dir()/lol_streak_v5_*.json` | LoL 戦績の 5 分キャッシュ | 不要 |
| `api/arena/data/titles.json` | Arena のタイトル初期データ | Git にある |
| ブラウザ `localStorage` | サイト合言葉のデバイストークン | 移行後は無効になる（再入力） |
| ブラウザ `sessionStorage` | ログイン後に戻るページ | 不要 |
