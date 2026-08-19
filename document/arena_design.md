# Arena（バンピック & ランキング）設計書

## 概要

友人内で複数タイトルを1v1で対戦する際の BAN/PICK（バンピック）進行とレーティング管理を Web 化した機能。`api/arena/` にAPIファーストな構成で実装し、`frontend/src/pages/Arena*.jsx` がそれを叩くSPAとして動作する。ローカル（1画面で交互操作）とオンライン（別端末＋ポーリング同期）の両モードに対応し、対戦成績はEloレーティングとして`db-folder/arena.db`（SQLite）に蓄積される。

将来 Discord ボットから同じAPIを叩けるように、セッション認証に加えて APIキー（Bearer トークン）による認証経路を用意している（本ドキュメントの後半で詳述）。**ボット本体はこのリポジトリには実装していない。**

## 全体アーキテクチャ

- `api/arena/index.php` — フロントコントローラ。ルーティング表（正規表現 + ハンドラ関数名）を持ち、リクエストパスをディスパッチするだけ。ビジネスロジックは持たない。
- `api/arena/lib/db.php` — `getArenaDB(): PDO`。`db-folder/arena.db` への接続と、接続時の `CREATE TABLE IF NOT EXISTS` 一式（既存の `getValDB()` と同じパターン）。
- `api/arena/lib/auth.php` — 認証・認可ヘルパー（後述）。
- `api/arena/lib/seed.php` — `api/arena/data/*.json` からの初期投入（ブートストラップ専用）。
- `api/arena/lib/draft.php` — ドラフト状態機械。
- `api/arena/lib/rating.php` — Eloレーティング計算と結果確定処理。
- `api/arena/routes/*.php` — リソースごとのハンドラ実装（`read.php` `me.php` `match.php` `ranking.php` `admin.php`）。

`arena.db` は `auth.db`（ログインユーザー情報）とは別ファイルのSQLiteであり、`ATTACH`/`JOIN` はできない。そのため試合レコードにはユーザー名をスナップショット列（`player_a_name` 等）として持たせ、必要な箇所だけ `getDB()`（`api/common.php`）で別ハンドルを開いて参照する。

## テーブル構成（`db-folder/arena.db`）

| テーブル | 役割 |
|---|---|
| `arena_meta` | KVストア。JSONシードの版管理（`seed_version`）など |
| `arena_games` | ゲームマスタ（スラッグ・表示名・エントリーの呼称・アイコン等） |
| `arena_entries` | BAN/PICK対象（キャラクター/エージェント/マップ等） |
| `arena_rulesets` | BAN/PICK手順（`sequence` はJSON配列）・持ち時間・ミラー可否・フィアレス可否 |
| `arena_user_games` | ユーザーごとの所持ゲーム（対戦候補の絞り込みに使用） |
| `arena_admins` | Arenaのゲームマスタ管理権限を持つユーザー |
| `arena_matches` | 試合本体。モード・状態・手番・タイマー・スコア・確定情報を1行に集約 |
| `arena_actions` | 1手ごとのBAN/PICK記録。`UNIQUE(match_id, seq)`が二重送信の最終防壁 |
| `arena_ratings` | ゲーム別（`game_id`）＋総合（`game_id=0`）のレーティング・戦績 |
| `arena_rating_history` | レート変動の監査ログ。`UNIQUE(match_id, game_id, user_id)`が二重反映防止の最終防壁 |
| `arena_api_keys` | Discordボット等が使うAPIキー（ハッシュのみ保存） |

スキーマは Phase 1 で確定しており、本フェーズでは変更していない。

## エンドポイント一覧（`/api/arena/v1` プレフィックス）

本番は `api/arena/.htaccess` のリライトで `/api/arena/v1/...` を直接叩けるが、PHPビルトインサーバーや万一リライトが効かない環境向けに `index.php?path=/v1/...` 形式も同じコードパスで受ける（`frontend/src/lib/arenaApi.js` の `ARENA_USE_PATH_FALLBACK` 定数で切り替え）。

| Method | Path | 認証 | 内容 |
|---|---|---|---|
| GET | `/v1/games` | read | ゲーム一覧＋ルールセット。`?playable_with={user_id}`で共通所持ゲームに絞り込み |
| GET | `/v1/games/{slug}/entries` | read | BAN/PICK対象一覧。ETag対応 |
| GET | `/v1/users` | read | 対戦相手選択用のユーザー一覧 |
| GET | `/v1/me` | read | 自分の情報・管理者フラグ |
| GET | `/v1/me/games` | read | 所持ゲーム一覧 |
| PUT | `/v1/me/games` | write | 所持ゲームを一括更新 |
| POST | `/v1/matches` | write | 試合作成（local/online） |
| GET | `/v1/matches` | read | 自分が参加する試合一覧 |
| GET | `/v1/matches/{public_id}` | read | 試合詳細 |
| POST | `/v1/matches/{public_id}/join` | write | オンライン戦への参加 |
| GET | `/v1/matches/{public_id}/draft?since=N` | read | ドラフト状態（`version<=N`なら304） |
| POST | `/v1/matches/{public_id}/draft` | write | BAN/PICK実行 |
| POST | `/v1/matches/{public_id}/result` | write | 結果申告 |
| POST | `/v1/matches/{public_id}/confirm` | write | 相手による承認→Elo確定 |
| POST | `/v1/matches/{public_id}/cancel` | write | 中止 |
| GET | `/v1/ranking?game={slug\|overall}` | read | リーダーボード |
| GET | `/v1/players/{user_id}` | read | 個人成績・直近試合 |
| GET | `/v1/head-to-head?a=&b=` | read | 対戦相手別の戦績集計 |
| * | `/v1/admin/*` | **セッションのみ** | ゲームマスタ管理・APIキー発行・管理者管理 |

「認証」列の read/write は、次章の `arenaActor()` が要求するスコープに対応する。`/v1/admin/*` は APIキーでは**絶対に**到達できない（後述）。

## ドラフト状態機械

サーバー権威で全判定を行い、クライアントは表示専任。

- **作成**：`mode=local` は相手を作成時に指定して即 `drafting`。`mode=online` は `waiting` で `public_id`（8文字のルームコード）を発行し、相手の `/join` を待つ。
- **手番**：`turn_index` が `ruleset.sequence` の添字。`sequence[turn_index].s` が操作可能な側（A/B）。local では作成者が両側を操作できる（`arenaCanAct()`）。
- **アクション適用**（`BEGIN IMMEDIATE` の1トランザクション）：
  1. 先に遅延タイムアウト処理を流して最新状態に追いつかせる
  2. 楽観ロック検証（リクエストの `seq === turn_index`。ズレていれば409）
  3. 手番・エントリー有効性・BAN/PICK済みでないか（`mirror_allowed`/フィアレス考慮）を検証
  4. `arena_actions` へINSERT（`UNIQUE(match_id, seq)`が最終防壁。競合時409）
  5. `turn_index+1`・`turn_deadline`更新・`version+1`。手順を使い切ったら`status=playing`へ
- **遅延タイムアウト**：常駐プロセス（cron）を使わない。任意のリクエスト（読み取り含む）が来た時に `turn_deadline` 超過を検知し、while ループで追いつくまで自動BAN/PICKを適用する。自動選択は `sha1(match_id . ':' . turn_index)` をシードにした決定的な乱択で、誰がいつ処理しても同じ結果になる。localモードは `turn_deadline` が常にNULLのため対象外。
- **同期**：`GET /draft?since=N` は `version<=N` なら304（ボディなし）。フロントは1秒間隔でポーリングし、304の間は state を更新しない。

## 結果申告とElo

- `/result` で `status=reported`・`reported_by` を記録。相手が `/confirm` すると `status=finished` になりEloを反映する。
- **48時間経過しても未承認なら自動承認**（`arenaMaybeAutoConfirm()`、これも遅延評価。試合の読み取り時に判定するだけでcronは使わない）。localモードでも承認を必須にしており、片方が勝手にレートを盛れない設計。
- Elo：初期レート1200。`eloExpected()`は期待勝率、`eloK()`は対戦数に応じたK値（15戦未満=40、40戦未満=28、それ以上=20）。ゲーム別（`game_id`）と総合（`game_id=0`）を**同じ関数で2回**更新するため、1試合の確定で `arena_rating_history` に**4行**（2ユーザー×2スコープ）が入る。
- 二重反映防止：`arena_rating_history`へ先にINSERTしてから`arena_ratings`をUPDATEする。`UNIQUE(match_id, game_id, user_id)`が最終防壁であり、`/confirm`を再度叩いても何も起きない。

## ローカル / オンラインの分岐点

同じテーブル・同じ検証ロジックを通る。違いは次の2点のみ：

1. `arenaCanAct()` — local は作成者が両側を操作可能。online は `sequence[turn_index].s` に対応する本人のみ。
2. `turn_deadline` — local は常にNULL（無制限）。online は `ruleset.turn_seconds` に基づき`/join`時・各手番確定時に設定される。

フロント側も `useDraftSync` フックが吸収しており、呼び出し側からはlocal/onlineの違いを意識しない形になっている。

## Discordボット向けの受け口（APIキー認証）

ボット本体は実装していないが、**将来ボットから同じAPIを叩けるように認証経路だけ用意済み**。

### 認証の入口 `arenaActor()`

`api/arena/lib/auth.php` に3つの関数がある：

- `requireArenaUser()` — セッション必須（ログイン画面からの通常利用）。
- `requireArenaAdmin()` — 管理者必須。`requireArenaUser()`しか呼ばないため**セッション以外では絶対に通らない**。`arena_admins`が空の状態で最初に叩いたログインユーザーを自己ブートストラップで管理者登録する（ロリポップ ライトプランにSSHが無いため）。
- `arenaActor(PDO $db, string $requiredScope='read')` — 各エンドポイントの入口で呼ぶ本体。内部で`resolveActor()`を使い、
  1. `$_SESSION['user_id']`があればそれを使う（ブラウザの挙動は完全に不変。スコープ制限も受けない）。
  2. 無ければ`Authorization: Bearer <key>`を`hash('sha256', ...)`で`arena_api_keys`と照合する（`revoked_at IS NULL`が条件。失効済みキーはここで「見つからない」扱いになり401＝fail closed）。
  3. 鍵が有効なら、`X-Arena-Discord-Id`ヘッダ（無ければボディの`discord_id`）を`auth.db`の`discord_users`テーブルで`users.id`に解決し、そのユーザーとして代理実行する。`users`/`discord_users`が存在しない環境でも例外を握りつぶして401を返す（500にしない）。
  4. キー経由で解決できた場合のみ、`arena_api_keys.scopes`（カンマ区切り）に`$requiredScope`が含まれるかを見る。無ければ403「このAPIキーにはこの操作を行う権限（スコープ）がありません」。

読み取り系エンドポイントは`arenaActor($db, 'read')`、更新系（試合作成・参加・BAN/PICK・結果申告・承認・中止・所持ゲーム更新）は`arenaActor($db, 'write')`を要求する。

### 管理APIは絶対にAPIキーを受け付けない

`/v1/admin/*`（ゲーム/エントリー/ルールセットのCRUD、APIキー発行・失効、管理者の追加・削除）は今回も一切変更せず、`requireArenaAdmin()`（＝`requireArenaUser()`のみ）で保護されたまま。`write`スコープを持つAPIキーであっても`Authorization`ヘッダだけでは`$_SESSION['user_id']`が立たないため、常に401になる。つまり**APIキーにゲームマスタ権限・管理者権限を持たせる経路はコード上どこにも存在しない**。

### キーの発行・運用

- 発行・失効は管理画面（`/arena/admin`）からのみ行う（ロリポップ ライトプランにはSSHが無くCLIを叩けないため）。
- `POST /v1/admin/keys`で`{name, scopes}`を送ると生鍵を返す。**生鍵が見えるのはこの一度きり**で、DBには`hash('sha256', $rawKey)`しか保存しない。以後は`GET /v1/admin/keys`でも生鍵もハッシュ値も返さない（`id`・`name`・`scopes`・`created_by`・`created_at`・`last_used_at`・`revoked_at`のみ）。
- `scopes`はカンマ区切りの文字列（`read`または`read,write`）。
- 失効は`DELETE /v1/admin/keys/{id}`で`revoked_at`を立てるのみ（物理削除しない＝監査履歴が残る）。失効後は即座に全エンドポイントで401になる。
- キー利用のたびに`last_used_at`を更新するため、管理画面で「最後に使われた日時」から死んだキーを判別できる。

### ボットが呼ぶ想定のリクエスト例

```
GET /api/arena/v1/ranking?game=overall
Authorization: Bearer <発行された生鍵>
X-Arena-Discord-Id: 123456789012345678
```

`X-Arena-Discord-Id`が指すDiscordアカウントが`discord_users`に未登録の場合は401になる。ボット側は「先にサイトでDiscordログインしてもらい、`discord_users`にリンクを作ってから使う」運用を前提とする（既存の`api/auth/discord_callback.php`がこのテーブルを作成・維持している）。

## Discordボット実装時のメモ（将来作業・未実装）

ロリポップ ライトプランはSSHが無く常駐プロセスも動かせないため、Discord GatewayへのWebSocket常時接続は前提にできない。その代わり **Interactions Endpoint URL方式**を使えば、Discord側からのHTTPS POSTをPHPで受けるだけでボットが成立する（常駐プロセス不要）。

- Discord Developer PortalでアプリケーションのInteractions Endpoint URLに、ロリポップ上のPHPエンドポイント（例：`api/discord/interactions.php`、未実装）を設定する。
- **署名検証が必須**：リクエストヘッダ`X-Signature-Ed25519`・`X-Signature-Timestamp`と生のリクエストボディを使い、

  ```php
  $verified = sodium_crypto_sign_verify_detached(
      hex2bin($signature),
      $timestamp . $rawBody,
      hex2bin($publicKeyHex)
  );
  ```

  で検証する。`sodium_*`関数はPHP 7.2以降に標準バンドルされているため追加の拡張は不要（本リポジトリはPHP 7.4+前提）。検証に失敗したリクエストは401で拒否する。
- Discordは`type=1`（PING）を送ってくることがあり、`type=1`を返すだけで疎通確認が完了する。
- **3秒以内に応答できない処理**（試合作成・ドラフト進行など、Arena APIへの複数回のHTTP呼び出しを伴う処理）は、まず`type=5`（deferred response）を即座に返し、その後`PATCH /webhooks/{application_id}/{interaction_token}/messages/@original`でフォローアップメッセージを送る2段構成にする。
- ボット用のAPIキーは事前に管理画面（`/arena/admin`）で発行し、ロリポップの環境変数または設定ファイルに保存する。ボットは各Discordユーザーのコマンド実行時に、そのユーザーのDiscord IDを`X-Arena-Discord-Id`として本APIに渡す（本人が事前にサイトでDiscordログインし`discord_users`にリンク済みであることが前提）。
- 想定コマンド例：`/arena start <game> <opponent>`（`POST /v1/matches`→`/v1/matches/{id}/draft`をチャンネル内のボタン操作で順に叩く）、`/arena ranking [game]`（`GET /v1/ranking`をそのまま整形して返す）。

## 既知の制約・スコープ外事項

- `arena.db`と`auth.db`はJOINできないため、ユーザー名はスナップショット列で持つ（ユーザーが表示名を変更しても過去の試合記録の表示名は更新されない）。
- フィアレス（`series_id`によるシリーズ内の使用済み除外）は判定関数のみ用意済みで、`series_id`を実際に発行するUIは未実装。
- LoLのみDataDragonからのエントリー同期に対応。同期に失敗した場合は既存エントリーをそのまま使い、サイトを落とさない。
