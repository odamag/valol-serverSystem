# Arena（バンピック & ランキング）設計書

> **【重要】2026-08 改訂** — 当初「各タイトルの中でキャラクターをBAN/PICKする」と解釈して
> 実装したが、これは要件の読み違いだった。正しくは **9つのゲームタイトル自体をBAN/PICKして
> 5番勝負の対戦カードを決める**。キャラクター単位のBAN/PICK（arena_entries / arena_rulesets /
> arena_matches / arena_actions、Data Dragon同期、エントリー一括インポート）は全て廃止済み。
> 本書は再設計後の実装を記述する。

## 概要

友人内の1v1対戦を支援するツール。9つのゲームタイトルのプールから交互にBAN/PICKして
5番勝負の対戦カードを決め、勝敗をEloレーティングとして蓄積する。
ロリポップ ライトプラン上の PHP + SQLite で完結し、WebSocketも常駐プロセスも使わない。

## ドラフトの流れ

```
A ban → B ban → B pick → A pick → B ban → A ban → A pick → B pick → Decider
  BAN 4 + PICK 4 + Decider 1 = 9   ← 9タイトルのプールをちょうど使い切る
```

- **プール**: シリーズ作成時に確定。既定値は「両者が所持しているタイトル」。
  書式の `pool_size`（既定9）とちょうど一致しないと400。
- **先手後手の決定**: シリーズEloの差で2通りに分岐する。判定は `arenaSeriesSideDecision()`。
  - **差がしきい値以内（既定 ±25）** → **ルーレット**。サーバーが `random_bytes` のシードから
    A/Bを確定する。クライアントは回転演出を見せるだけで、**引き直し不可**。
  - **差がしきい値を超える** → **レートが低いほうが先行(A)/後行(B)を選ぶ**（ハンデ）。
    `POST /v1/series/{id}/choose-side {side}`。選べるのは低いほうのプレイヤーだけで、
    高いほうが叩くと403。時間制限は設けず、選ぶまで待つ。
  - どちらの経路でも結果は `arena_series.side_a_user_id` / `side_b_user_id` に保存され、
    確定後のやり直しは400。方式が合わない側のエンドポイントを叩いても400で弾く。
  - 比較に使うのは**シリーズElo**（`arena_ratings.game_id = -1`）。レート行が無ければ1200。
    したがって初対戦同士は必ずルーレットになる。
  - しきい値は `arena_meta.side_choice_threshold` に保持し、管理画面
    （`GET|PATCH /v1/admin/settings`）から変更できる。
  - ローカル（1画面）モードでは、ドラフト同様に作成者が低いほう本人の代わりに選択できる。
- **Decider**: 8手目のPICKが終わった瞬間、残った唯一のタイトルを同一トランザクション内で
  `decider` アクションとして確定し、`arena_series_games` に5行（PICK順=第1〜4試合、
  Decider=第5試合）を書き込む。ドラフト済みなのに対戦カードが無い状態は発生しない。
- **手番の所有**: ローカル（1画面）モードは作成者が両側を操作できる。
  オンラインは `sequence[turn_index].s` に対応する本人のみ（それ以外は403）。
- **楽観ロック**: リクエストの `seq` が `turn_index` と不一致なら409。
  最終防壁は `arena_series_actions` の `UNIQUE(series_id, seq)`。
- **ターン制限時間**: cronを使わず、リクエストが来たときに期限超過を判定して
  自動選択を適用する（複数手ぶん飛んでいてもループで追いつく）。
  自動選択は `sha1(series_id:seq)` を種にした決定的乱択で、誰がいつ叩いても同じ結果になる。
- **同期**: オンラインは `GET /v1/series/{id}/draft?since=N` を1秒間隔でポーリング。
  `version <= N` ならボディ無しの304を返す。

## テーブル構成（`db-folder/arena.db`）

| テーブル | 役割 |
|---|---|
| `arena_games` | ゲームタイトルのマスタ（＝BAN/PICKの対象） |
| `arena_user_games` | ユーザーごとの所持タイトル |
| `arena_formats` | ドラフト書式（sequence / pool_size / wins_needed / turn_seconds） |
| `arena_series` | 5番勝負1本。ルーレット結果・ドラフト状態・勝敗数を持つ |
| `arena_series_pool` | そのシリーズのタイトルプール |
| `arena_series_actions` | BAN/PICK/Deciderのログ |
| `arena_series_games` | 第1〜5試合の並びと各試合の勝敗 |
| `arena_ratings` | Elo。`game_id` は 正の値=タイトル別 / 0=総合 / -1=シリーズ別 |
| `arena_rating_history` | Elo増減の監査ログ。`UNIQUE(scope, ref_id, game_id, user_id)` |
| `arena_admins` / `arena_api_keys` / `arena_meta` | 管理者・APIキー・内部KV |

## 勝敗とEloレーティング

- 試合は**必ず順番に**記録する（第2試合を飛ばして第3試合は400）。
- 申告 → **相手アカウントによる承認**で確定。申告者本人は承認できない。
  ローカルモードでも承認を必須にしており、これが片方が勝手にレートを盛れない唯一の歯止め。
- 48時間承認されない申告は、次にそのシリーズが読まれた時点で自動承認する（遅延評価）。
- Eloは3スコープ:
  - 試合確定時 … そのタイトル（`game_id > 0`）と総合（`game_id = 0`）
  - シリーズ確定時 … シリーズ（`game_id = -1`）
- **二重反映防止**: 1トランザクション内で `arena_rating_history` に先にINSERTし、
  そのUNIQUE制約が防壁になってから `arena_ratings` を更新する。
  3-0で終わったシリーズなら履歴はちょうど14行（3試合×4 + シリーズ2）。
- 初期レート1200、K値は対戦数に応じて 40 / 28 / 20。

## 統計

- `GET /v1/title-stats[?user_id=]` — タイトル別のBAN率・PICK率・Decider回数・勝率。
  `?user_id=` は **陣営（side）で絞る**。`actor_id` で絞らないのは、ローカルモードでは
  作成者が両側を操作し、タイムアウト自動選択では `actor_id` がNULLになるため。
- `GET /v1/head-to-head?a=&b=` — 対戦相手別のシリーズ戦績、タイトル別内訳、連勝、
  各シリーズの対戦カードと試合ごとの勝敗。

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

`/v1/admin/*`（タイトル/ドラフト書式のCRUD、APIキー発行・失効、管理者の追加・削除）は今回も一切変更せず、`requireArenaAdmin()`（＝`requireArenaUser()`のみ）で保護されたまま。`write`スコープを持つAPIキーであっても`Authorization`ヘッダだけでは`$_SESSION['user_id']`が立たないため、常に401になる。つまり**APIキーにゲームマスタ権限・管理者権限を持たせる経路はコード上どこにも存在しない**。

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

- **キャラクター単位のBAN/PICKは持たない。** 各タイトル内で誰を使うかはゲーム側で決める。
- ロリポップ ライトプランには **SSH が無い**ため、初期データ投入・管理者付与・APIキー発行は
  すべてWeb UI経由で完結させている。`arena_admins` が空のうちは
  `/v1/me` が `admin_bootstrap_available: true` を返し、最初に管理APIを叩いた人が管理者になる。
- WebSocketが使えないため、オンライン同期は1秒ポーリング（304で軽量化）。
- Discordボット本体は未実装。APIの受け口のみ用意してある。
