# 01. 今の環境

## ホスティング

| 項目 | 今 |
|---|---|
| サーバ | ロリポップ（設計書の記述ではライトプラン、FTP の記述ではエコノミープラン。**どちらか要確認**） |
| Web サーバ | Apache（`.htaccess` で制御） |
| 言語 | PHP 8.5（CI の構文チェックも 8.5。直前のコミットで 8.5 対応済み） |
| DB | SQLite（`db-folder/` に 4 ファイル）。PDO 経由 |
| セッション | PHP 標準のファイルセッション（`session_start()`） |
| 使えないもの | SSH、常駐プロセス、WebSocket、cron（使っていない） |
| 一時ファイル | `sys_get_temp_dir()` に LoL 戦績のキャッシュ、ルートに `starting_*.lock` |

## ルーティング（`.htaccess`）

1. `config.php` / `site_config.php` / `discord_config.php` への直アクセスを拒否
2. `/api/*` と `/games/*` はそのまま PHP / 静的ファイルとして返す
3. `dist/` にファイルがあればそれを返す（Vite のビルド成果物）
4. それ以外はすべて `dist/index.html`（SPA のフォールバック）

`api/arena/`・`api/running/` は `index.php` 1 本に集約するフロントコントローラ方式。
`?path=` → `PATH_INFO` → `REQUEST_URI` の順でパスを解決する（PHP 組み込みサーバでも動かすため）。
`db-folder/`・`lib/`・`api/*/lib/`・`api/arena/routes/` には `.htaccess` で直アクセス拒否をかけている。

## フロントエンド

| 項目 | 今 |
|---|---|
| フレームワーク | React 18.3 + react-router-dom 6.26 |
| ビルド | Vite 5.4 → リポジトリ直下の `dist/` に出力 |
| 開発時 | `vite` の dev server が `/api`・`/games` を `localhost:8080` へプロキシ |
| 状態管理 | React Context（`AuthContext`）のみ。ライブラリなし |
| スタイル | `frontend/src/index.css` 1 本 |

## ブラウザゲーム（`games/`）

ビルドなしの素の HTML/JS。CDN から読み込んでいる:

| ゲーム | 使っているもの |
|---|---|
| Auto Battle RPG (`minigame/`) | unpkg の React 18 (development ビルド) + Babel standalone + Tailwind CDN + lucide@latest |
| Pong (`pong/`) | PeerJS (unpkg) — P2P 対戦 |
| 軍儀 (`gungi/`) | PeerJS (unpkg) — P2P 対戦 + CPU 対戦 |
| ライン通過ゲーム (`linegame/`) | なし |

※ 別ブランチ `claude/mg01-race-threejs-feasibility-0e9387` に MG01 Race（Three.js + PeerJS、最大8人、`games/_shared` の共通枠）が実装済み・未マージで残っている。

## デプロイ・CI（GitHub Actions）

| ワークフロー | いつ | 何をする |
|---|---|---|
| `ci.yml` | PR | フロントのビルド / PHP 8.5 で `php -l` / `aws/` の `tsc --noEmit` と `cdk synth` |
| `deploy.yml` | `main` へ push | フロントをビルド → **lftp で FTP ミラー**（差分のみ、`--delete` なし） |
| `cdk.yml` | `main` へ push（`aws/**` 変更時） | GitHub OIDC で AWS ロールを引き受けて `cdk deploy RunningData RunningApp` |

- FTP 接続には Secrets `FTP_SERVER` / `FTP_USERNAME` / `FTP_PASSWORD`、Variables `FTP_SERVER_DIR` を使う。
- 設定ファイル類・`db-folder/`・`aws/`・`document/`・`frontend/` は FTP の対象外。設定ファイルは**手作業で FTP 配置**している。
- `RunningGithubOidc` スタックだけはローカルから手動デプロイ（鶏と卵になるため）。
- 自動テストは `aws/` の TypeScript テスト（`npm test`）だけ。PHP と React にはテストがない。

## 設定ファイル・秘密情報

どれも Git 管理外。本番サーバに手で置いている。

| ファイル | 中身 | 使う機能 |
|---|---|---|
| `config.php` | AWS アクセスキー/シークレット、リージョン、EC2 起動テンプレート ID ×3 | サーバー起動 |
| `api/site_config.php` | `SITE_PASSWORD_HASH`（サイト合言葉の bcrypt ハッシュ） | サイトゲート |
| `api/auth/discord_config.php` | Discord OAuth の client_id / client_secret / redirect_uri / scope | Discord ログイン |
| `api/ai_config.php` | `ANTHROPIC_API_KEY` | LoL チャンピオン AI |
| `api/lol/config.php` | Riot API キー、戦績を出すメンバーの Riot ID 一覧 | LoL 戦績 |
| `api/valorant/config.php` | `PANDASCORE_KEY` | VALORANT 予想 |
| `api/running/config.php` | API Gateway の URL、HMAC 共有シークレット、タイムアウト | ランニング |
| `lib/aws.phar` | AWS SDK for PHP（バイナリ） | サーバー起動 |
| `generate_hash.php` | 合言葉ハッシュを作るための使い捨てスクリプト | — |

AWS 側の秘密情報は SSM Parameter Store（`/running/` 配下の SecureString。Discord Bot Token、HMAC 共有シークレット）。
Discord の App ID / Public Key / Guild ID は `aws/cdk.json` の context。

> 注意: Riot API の開発用キーは 24 時間で失効する（`api/lol/config.php.example` の記述）。本番キーを取っているかは要確認。

## 外部サービス

| サービス | 用途 | 認証 |
|---|---|---|
| AWS EC2 | Minecraft / Palworld / 7 Days to Die サーバーをスポットで起動・終了 | IAM アクセスキー（長期） |
| AWS (Lambda / API Gateway / DynamoDB / S3 / EventBridge Scheduler / SSM) | ランニング記録 | OIDC（デプロイ）、HMAC（PHP→API） |
| Discord | OAuth ログイン、ランニング Bot（スラッシュコマンド・ロール付与） | OAuth2 / Ed25519 署名検証 / Bot Token |
| Riot Games API (`jp1` / `asia`) | LoL のランク・直近戦績 | API キー |
| LoL Esports API (`esports-api.lolesports.com`) | 試合日程・リーグ一覧（予想の自動同期） | 公開キー（コード直書き） |
| Data Dragon (`ddragon.leagueoflegends.com`) | チャンピオン情報（ブラウザから直接） | なし |
| PandaScore | VALORANT の試合日程・結果 | API キー |
| Anthropic API | LoL チャンピオン質問 Bot（`claude-haiku-4-5-20251001`） | API キー |
| api.qrserver.com | 登録時の OTP 用 QR 画像生成（ブラウザから直接） | なし |
| PeerJS 公開サーバ | ゲームの P2P 接続の仲介 | なし |
| unpkg / Tailwind CDN | ゲームのライブラリ読み込み | なし |
| Notion | 情報ページからのリンクのみ | — |

## AWS（ランニング記録）の構成

CDK v2 (TypeScript)。リージョン `ap-northeast-1`。

| スタック | 中身 |
|---|---|
| `RunningData` | DynamoDB テーブル `running`（pk/sk、GSI1、TTL）・写真用 S3 バケット（一時置き場は 1 日で消えるライフサイクル） |
| `RunningApp` | Lambda 4 本 + HTTP API + EventBridge Scheduler |
| `RunningGithubOidc` | GitHub Actions 用の OIDC プロバイダと IAM ロール |

| Lambda | 役割 |
|---|---|
| Interactions | Discord のスラッシュコマンドを受ける（Ed25519 署名検証）。重い処理は Worker に回す |
| Worker | 記録の保存、写真取り込み、ランキング更新、ロール付与など本体 |
| Api | Web 版 (`/v1/...`) の API。PHP からの HMAC 署名を検証 |
| Scheduler | 毎月 1 日 0:05 (JST) の月次ロールオーバー（月間 1 位ロールの付け替え等） |
