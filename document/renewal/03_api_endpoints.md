# 03. API エンドポイント一覧

Rust で作り直すときの範囲。レスポンスは基本 `{ "success": bool, "message": "日本語", ... }`（`jsonResponse()`）。
認証は PHP セッション Cookie。「認証」欄: **なし** / **ログイン** / **管理者**、Arena だけ **read / write**（下で説明）。

## 認証 `api/auth/`

| メソッド | パス | 認証 | 内容 |
|---|---|---|---|
| GET | `/api/auth/site_status.php` | なし | 合言葉を通過済みか |
| POST | `/api/auth/site_login.php` | なし | 合言葉チェック → デバイストークン発行 `{password}` |
| POST | `/api/auth/site_device_login.php` | なし | デバイストークンで合言葉通過 `{deviceToken}` |
| GET | `/api/auth/status.php` | なし | ログイン状態（30 分無操作で破棄） |
| POST | `/api/auth/register.php` | なし | ユーザー作成、TOTP シークレットと otpauth URI を返す `{id, username}` |
| POST | `/api/auth/login.php` | なし | ID + OTP でログイン `{id, otp}` |
| GET/POST | `/api/auth/logout.php` | なし | セッション破棄 |
| DELETE | `/api/auth/profile.php` | ログイン | アカウント削除 |
| GET | `/api/auth/discord_redirect.php` | なし | Discord 認可画面へリダイレクト |
| GET | `/api/auth/discord_callback.php` | なし | コード交換 → ログイン → `/server` へリダイレクト |

## ゲームサーバー `api/server/`

| メソッド | パス | 認証 | 内容 |
|---|---|---|---|
| GET | `/api/server/status.php` | **なし** | 3 サーバーの状態・IP・ポート |
| POST | `/api/server/control.php` | **なし** | `{action: start\|stop, target: minecraft\|palworld\|7days, instanceId}` |

## LoL `api/lol/`

`predict.php` は `?action=` か POST ボディの `action` で分岐する 1 ファイル方式。

| メソッド | パス / action | 認証 | 内容 |
|---|---|---|---|
| GET | `/api/lol/streak.php` | なし | メンバーのランク・連勝・直近試合（5 分キャッシュ） |
| POST | `/api/lol/champion-bot.php` `{action: chat, ...}` | ログイン | チャンピオンについて AI に質問（1 時間 20 回） |
| GET | `predict.php?action=matches` | なし | 試合一覧（呼ばれるたびに同期・自動確定） |
| POST | `predict.php` `vote` | ログイン | `{match_id, prediction: team1\|team2}` |
| GET | `predict.php?action=leaderboard` | なし | ポイントランキング |
| GET | `predict.php?action=leagues` | なし | リーグ一覧 |

## VALORANT `api/valorant/`

| メソッド | action | 認証 | 内容 |
|---|---|---|---|
| GET | `matches` | なし | 試合一覧（PandaScore と同期） |
| POST | `vote` | ログイン | 投票 |
| POST | `add_match` | ログイン | 手動で試合登録 |
| POST | `resolve` | ログイン | 手動で結果確定 |
| GET | `leaderboard` | なし | ポイントランキング |
| POST | `reset_sync` | ログイン | 同期のクールダウン解除＆再同期 |

## Arena `api/arena/` （REST、`/api/arena/v1/...`）

| メソッド | パス | 認証 | 内容 |
|---|---|---|---|
| GET | `/v1/users` | read | ユーザー一覧 |
| GET | `/v1/games` | read | ゲームタイトル一覧 |
| GET | `/v1/formats` | read | ドラフト書式一覧 |
| GET | `/v1/me` | read | 自分の情報（管理者か等） |
| GET | `/v1/me/games` | read | 所持ゲーム取得 |
| PUT | `/v1/me/games` | write | 所持ゲーム更新 |
| POST | `/v1/series` | write | シリーズ作成 |
| GET | `/v1/series` | read | シリーズ一覧 |
| GET | `/v1/series/{id}` | read | シリーズ詳細 |
| POST | `/v1/series/{id}/join` | write | 参加 |
| POST | `/v1/series/{id}/roulette` | write | 先手後手ルーレット |
| POST | `/v1/series/{id}/choose-side` | write | 低レート側が先手後手を選ぶ |
| GET | `/v1/series/{id}/draft?since=N` | read | ドラフト状態（差分なしは 304） |
| POST | `/v1/series/{id}/draft` | write | BAN/PICK（`seq` で楽観ロック） |
| POST | `/v1/series/{id}/cancel` | write | 中止 |
| POST | `/v1/series/{id}/games/{n}/result` | write | 勝敗申告 |
| POST | `/v1/series/{id}/games/{n}/confirm` | write | 相手が承認（Elo 反映） |
| GET | `/v1/ranking` | read | ランキング |
| GET | `/v1/players/{id}` | read | プレイヤー詳細 |
| GET | `/v1/head-to-head` | read | 対戦成績 |
| GET | `/v1/title-stats` | read | タイトル別統計 |
| GET | `/v1/seasons/current` | read | 現シーズン |
| GET/POST | `/v1/admin/games` | 管理者 | タイトル一覧・追加 |
| PATCH/DELETE | `/v1/admin/games/{slug}` | 管理者 | タイトル更新・削除 |
| GET/POST | `/v1/admin/formats` | 管理者 | 書式一覧・追加 |
| PATCH/DELETE | `/v1/admin/formats/{id}` | 管理者 | 書式更新・削除 |
| POST | `/v1/admin/seasons` | 管理者 | 新シーズン開始 |
| PATCH | `/v1/admin/seasons/current` | 管理者 | 現シーズン更新 |
| GET/PATCH | `/v1/admin/settings` | 管理者 | 設定（先手選択のしきい値等） |
| GET/POST | `/v1/admin/keys` | 管理者 | API キー一覧・発行 |
| DELETE | `/v1/admin/keys/{id}` | 管理者 | API キー失効 |
| GET/POST | `/v1/admin/admins` | 管理者 | 管理者一覧・追加 |
| DELETE | `/v1/admin/admins/{id}` | 管理者 | 管理者削除 |

`{id}` はシリーズの `public_id`（8 桁 hex）。
認証欄の **read / write** は「セッション、またはそのスコープを持つ API キー（`Authorization: Bearer`）」の意味（`arenaActor($db, 'read'|'write')`）。
**管理者** は `requireArenaAdmin()` で、セッションのみ（API キーでは絶対に通らない）。誰が操作してよいか（本人か・相手か）の判定は各ハンドラの中にある。

## ランニング `api/running/` （中継のみ）

PHP はログイン確認 → `discord_users` から Discord ID を引く → HMAC 署名して AWS へ転送。中身は `document/running_api.md`。

| メソッド | パス |
|---|---|
| GET / POST | `/v1/records` |
| PATCH / DELETE | `/v1/records/{YYYY-MM-DD}_{32hex}` |
| POST | `/v1/records/{id}/photo-url`（S3 署名付き URL の発行） |
| POST | `/v1/records/{id}/photo`（アップロード完了の通知） |
| GET | `/v1/ranking` |
| GET | `/v1/me/summary` |
| GET | `/v1/settings` |

AWS 側には他に `POST /discord/interactions`（Discord からの Webhook）がある。

## デバッグ

| メソッド | パス | 認証 | 内容 |
|---|---|---|---|
| GET | `/api/debug/api_check.php` | ログイン | 外部 API の疎通確認 |
