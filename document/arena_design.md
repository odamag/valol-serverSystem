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
| GET | `/v1/head-to-head?a=&b=` | read | 対戦相手別の戦績集計（ゲーム別内訳・ストリーク・直近試合のBAN/PICK内訳） |
| GET | `/v1/games/{slug}/stats` | read | エントリー別のPICK/BAN数・勝率統計。`?user_id=`でプレイヤー絞り込み |
| GET | `/v1/series/{series_id}` | read | フィアレス/BO3シリーズの試合一覧・サイド別勝敗・使用済みエントリープール |
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

## フィアレス／BO3シリーズ（Phase 6）

`arena_matches.series_id`はPhase 1からスキーマに存在していたが、Phase 5までは常にNULLだった。
Phase 6でこれを実際に発行し、複数試合を1つの「シリーズ」として繋げられるようにした。
**スキーマは変更していない**（`series_id`と`arena_rulesets.fearless`は既存のまま）。

### シリーズの発行と継続

- `POST /v1/matches`に`best_of`（1・3・5、省略時1）を渡すと、`best_of > 1`のときだけ
  `series_id`を`public_id`と同じ方式（`bin2hex(random_bytes(4))`の8文字16進数、衝突時再試行）
  で新規発行する。単発試合（`best_of=1`）は従来どおり`series_id = NULL`のまま。
- BO3/BO5の「何本先取か」という設定は、スキーマを増やさず**`arena_meta`の汎用KV**に
  `arena_series_bestof:<series_id>`キーで持たせている（`arena_meta`はPhase 1からこの用途向けに
  用意されているテーブル）。
- 2試合目以降は`POST /v1/matches`に`{"series_id": "..."}`だけを渡す（`game`/`ruleset`/`mode`/
  `opponent_user_id`/`best_of`は無視される）。サーバー側はシリーズ1試合目（アンカー）から
  `game_id`・`ruleset_id`・`mode`・対戦カード（`player_a_id`/`player_b_id`）をそのまま引き継ぎ、
  呼び出したユーザーがそのシリーズの参加者本人であることと、シリーズがまだ決着していないことを
  検証してから新しい試合行を作る。オンラインモードでも対戦相手は既に判明しているため、
  2試合目以降は`waiting`/`join`を経由せず即`drafting`にする（`turn_deadline`は`join`時と同じ計算）。
- シリーズの決着判定は「勝利数 ≧ `intdiv(best_of, 2) + 1`」（BO3なら2本、BO5なら3本）。
  決着済みシリーズに対して`series_id`付きで`POST /v1/matches`を叩くと400になる。

### Eloは「試合ごとに1回」のまま変わらない

シリーズであっても、Elo反映は`arenaApplyMatchResult()`が試合の`/confirm`のたびに1回だけ行う
（Phase 3〜5から一切変更していない）。つまりBO3を最後まで打つと、Elo反映は3試合分＝
`arena_rating_history`に**12行**（1試合4行 × 3試合）入る。シリーズという概念はレーティング計算に
一切影響しない。

`POST /v1/matches/{public_id}/confirm`のレスポンス（および試合単体を返す他の全エンドポイント）
には、`series_id`が立っている試合について`series`オブジェクトを埋め込む：

```json
"series": {
  "series_id": "80add791", "best_of": 3, "wins_needed": 2,
  "player_a_id": 1, "player_a_name": "Alice",
  "player_b_id": 2, "player_b_name": "Bob",
  "wins_a": 1, "wins_b": 0, "games_played": 1, "games_finished": 1,
  "is_over": false
}
```

フロントはこれを見て「次のゲームを開始する」ボタンの表示・非表示を判断する
（`is_over=false`の`finished`試合でのみボタンを出す）。ただし`/v1/matches`一覧や
`/v1/players/{id}`の直近試合一覧のように1リクエストで多数の試合行を返すエンドポイントでは、
行ごとに`series`集計クエリを追加で走らせるとN+1気味になるため`series`は`null`のまま返し
（`series_id`自体は含む）、単体取得系（作成・取得・ドラフト・結果申告・承認）でのみ埋め込む。

### フィアレス判定（`arena_rulesets.fearless = 1`）

`api/arena/lib/draft.php`の`arenaFearlessExcludedIds()`が、同一`series_id`の**別試合**で
**PICKされた**エントリーを列挙する。対象は`status IN ('playing','reported','finished')`の試合の
PICKのみ（`waiting`/`drafting`/`cancelled`は対象外）。**BANは持ち越さない**。

この関数は`arenaIsEntryAvailable()`を通じて次の2箇所から共通に呼ばれるため、手動PICKと
タイムアウトによる自動選択のどちらでも同じ除外集合が使われる：

- `arenaApplyAction()`（手動BAN/PICKの検証。除外対象を選ぶと400）
- `arenaApplyTimeouts()`（遅延評価によるタイムアウト自動選択。除外対象は候補プールに
  含めない。乱択の候補が空になった場合のみ`entry_id = NULL`のまま手番を進める）

`GET /v1/series/{series_id}`は、シリーズを構成する全試合・サイド別勝敗に加え、
フィアレスルールのときだけ`fearless_used_entries`（シリーズ全体で使用済みのエントリー一覧）を
返す。閲覧できるのはシリーズの参加者本人のみ（403でガード）。

## ヘッドトゥヘッド詳細（Phase 6）

`GET /v1/head-to-head?a=&b=`を拡張し、通算成績に加えて次を返すようにした：

- `per_game`: ゲームごとの内訳（`a_wins`/`b_wins`/`total`）
- `streak`: 現在のストリーク（`{side:'a'|'b'|null, count}`）。最新試合から遡って同じ勝者が
  続く間だけ数え、途切れた時点で確定する
- `matches`: 直近の試合一覧（`ARENA_H2H_RECENT_LIMIT = 30`件まで）。各試合のBAN/PICK内訳
  （`a_picks`/`b_picks`/`bans`）付き。通算成績・`per_game`・`streak`は全履歴から計算するが、
  重い内訳の取得だけを直近30件に絞ることでN+1を避けつつレスポンスを軽く保っている
  （直近試合IDの集合に対してBAN/PICKを1本のグループ化SQLでまとめて取得する）

フロント側は`frontend/src/pages/ArenaHeadToHead.jsx`（`/arena/head-to-head?a=&b=`）として
新設し、`ArenaRanking.jsx`のランキング行（プレイヤー名クリック）とヘッドトゥヘッドの
クイック検索フォームの両方から遷移できるようにした。

## キャラ別勝率統計（Phase 6）

`GET /v1/games/{slug}/stats`は、指定ゲームのエントリーごとにPICK数・BAN数・勝敗数・
各種レートを1本のグループ化SQLで集計して返す（N+1なし）。BAN/PICKされたことが一度もない
エントリーは結果に含まれない。

- `pick_rate`/`ban_rate`の分母（`total_matches`）は「そのゲームで実際にドラフトが行われた
  試合数」（`status IN ('drafting','playing','reported','finished')`。`waiting`と`cancelled`は
  ドラフトが成立していないため除外）。
- `win_rate`の分母は「確定（`finished`）した試合でのPICK数」のみ。ドラフト中・結果未承認の
  試合のPICKはBAN/PICK数にはカウントされるが、勝率計算からは除外される。
- `?user_id=`を指定すると「**そのユーザーの側（A/B）で行われた**PICK/BAN」だけに絞り込む。
  **`actor_id`（実際にボタンを押した人）ではなくsideで絞っている**点が重要：
  - ローカルモードでは対戦の作成者が両サイドを操作するため、`actor_id`基準で絞ると
    相手側のPICKまで作成者自身の記録として数えてしまう。
  - タイムアウトによる自動選択は`actor_id`が常に`NULL`になるため、`actor_id`基準だと
    自動選択されたPICKがそのプレイヤーの記録から漏れる（＝自動選択のまま勝った試合の
    勝率が反映されない）。
  - `side`基準（`a.side='A' AND m.player_a_id=?` または `a.side='B' AND m.player_b_id=?`）なら
    ローカル/オンライン・手動/自動のいずれでも「その試合でそのプレイヤーが実際に使った
    エントリー」として一貫して数えられる。

フロント側は`frontend/src/pages/ArenaStats.jsx`（`/arena/stats/:slug`）として新設し、
`ArenaRanking.jsx`のゲーム別タブ（総合以外）から「📊 このゲームのキャラ別統計を見る」
リンクで遷移できるようにした。プレイヤー絞り込みセレクトと、列見出しクリックでの
昇順/降順ソートに対応する。

## 既知の制約・スコープ外事項

- `arena.db`と`auth.db`はJOINできないため、ユーザー名はスナップショット列で持つ（ユーザーが表示名を変更しても過去の試合記録の表示名は更新されない）。
- LoLのみDataDragonからのエントリー同期に対応。同期に失敗した場合は既存エントリーをそのまま使い、サイトを落とさない。
- シリーズの`best_of`は`arena_meta`のKVで管理しているため、`arena_matches`単体のSQLだけを見ても
  「何本先取か」は分からない（`arenaSeriesBestOf()`を経由する必要がある）。スキーマ変更なしで
  実現するためのトレードオフとして許容した。
- ローカルモードで2試合目以降のシリーズを継続する場合、`created_by`はそのリクエストを送った
  ユーザー（＝その画面を開いた人）になる。ローカルモードの`arenaCanAct()`は「作成者が両側を
  操作できる」という既存仕様のままなので、シリーズの2試合目を別の参加者が開始すると、
  その人が両側を操作する画面になる（1台の端末を交代で使う運用を想定しているため、
  実運用上は問題にならない想定）。
