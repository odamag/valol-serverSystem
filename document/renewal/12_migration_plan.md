# 12. 移行の段階とデータ移行

[10_architecture.md](10_architecture.md) の続き。どの順番で移し、どう切り替え、まずいときにどう戻すか。
それと、データの移し方と、計算結果が変わらないことの確かめ方。

---

<a id="stages"></a>
## 1. 段階表

| 段階 | 中身 | 実装プラン | 切り替え方 | 元に戻す方法 | 次に進む目安 |
|---|---|---|---|---|---|
| **0** ロリポップで片付け | 穴の応急処置（サーバー起動に認証、停止はタグで探す）。捨てる機能のコードを消す。旧 DB を保管 | P0, P1 | いつもの FTP デプロイ（`main` にマージ） | `git revert` して再デプロイ。消したのはコードだけで、DB ファイルはサーバーに残っている（保管もしてある） | 起動・停止がログインしないとできないこと、残す機能が全部動くことを確かめる |
| **1** VPS に PHP のまま移す | VPS を作り、Caddy + PHP-FPM で今の PHP と dist をそのまま動かす。`auth.db` を写す。デプロイを rsync に変える | P2, P3 | ① 仮のサブドメイン（例 `new.example.com`）で動かして確かめる → ② `auth.db` を写し直す → ③ DNS の A レコードを VPS に向ける | DNS をロリポップに戻す（ロリポップは段階 4 まで解約しない。TTL は前もって 300 秒にしておく） | 1 週間、問題が出ない |
| **2** Rust の土台 + LoL 戦績 | `server/` を作り、systemd で動かす。LoL 戦績を Rust に移す | P4, P5 | フロントの `LoLStreak.jsx` が新しい URL を呼ぶリリースを出す（`/api/v1/*` は Caddy で常に Rust に行く） | `activate <前のリリース>`。PHP の `streak.php` は残っているので、古いフロントはそのまま動く | 本番で PHP と Rust の応答を比べて同じ（§3.2）。数日問題が出ない |
| **3** 認証・サーバー起動・ランニング | 合言葉・Discord ログイン・アカウント削除・ゲームサーバー・ランニングの中継を Rust に。バックアップを動かす | P6, P7, P8, P10 を先にマージ → **P9 で一度に切り替える** | 下の「[段階 3 の手順](#stage3)」 | `activate <段階 3 の直前のリリース>`。PHP 側の `auth.db` とセッションは手を付けていないので、そのまま前の状態で動く（全員もう 1 回ログインするだけ） | 2 週間問題が出ない。仲間が全員ログインできた |
| **4** PHP を消す | PHP のファイル・Caddy の PHP のブロック・PHP の CI を消す。古い AWS キーを消す。ロリポップを解約 | P11 | PHP を含まないリリースを出す | `activate <段階 3 のリリース>`（PHP-FPM はこのあと 2 週間はアンインストールしない） | 2 週間後に PHP-FPM を外し、ロリポップを解約する |

段階 0 と 1 は Rust を書かずにできる。先に済ませておくと、そのあとは VPS の上だけで作業できる。

<a id="why-bundle"></a>
### 段階 3 をまとめて切り替える理由

「1 機能ずつ切り替える」が基本だが、段階 3 の機能は**ログインのセッションを共有している**。
PHP のセッション（`PHPSESSID`）と Rust のセッション（`sid`）は互いに読めない。そのため、ログインだけを Rust に移すと、まだ PHP のゲームサーバー起動やランニングの中継が「ログインしていない」と判断してしまう。
PHP のセッションを Rust から読む仕組みを作ることもできるが、移行の間しか使わないものに手間をかけることになり、そこが新しい穴にもなりやすい。

そこで、**実装とマージは機能ごとに分け（P6・P7・P8）、フロントの切り替えだけを 1 回にまとめる（P9）**。
P6〜P8 はフロントから呼ばれない間は眠っているだけなので、出来た順に本番に出して、curl で先に確かめられる。
切り替えるときに変わるのはフロントのリリースだけなので、戻すのも 1 コマンドで済む。

<a id="stage3"></a>
### 段階 3 の手順

前もって（P6〜P8・P10 をマージしたあと）:

1. Discord の開発者画面で、Redirect URI に `https://<ドメイン>/api/v1/auth/discord/callback` を**足す**（古い URI は消さない。戻すときに要る）。
2. `/etc/serversystem/env` に Discord・AWS（新しい IAM ユーザー）・ランニングの値を入れて、`systemctl restart serversystem`。
3. 本番で curl を使って確かめる（合言葉のミドルウェアは、この時点ではまだ OFF）:
   - `GET /api/v1/health` → 200
   - `POST /api/v1/site/login`（正しい合言葉）→ `site_pass` Cookie が返る。間違いを 11 回 → 429
   - ブラウザで `/api/v1/auth/discord/start` を直接開く → ログインできて `/server` に戻る。`sid` Cookie ができている。ギルドに入っていない別アカウントで試す → `/login?discord_error=not_member`
   - その Cookie を付けて `GET /api/v1/servers` → 今の PHP と同じ内容が返る
   - その Cookie を付けて `GET /api/v1/running/settings` と `GET /api/v1/running/me/summary` → PHP 経由と同じ内容が返る
   - Origin を付けない POST が 403 になる
4. `serversystem backup` を手で 1 回流し、S3 に置かれたことを確かめる。timer を有効にする。

切り替えの日:

5. `serversystem import-legacy --auth-db /var/lib/serversystem/php/db-folder/auth.db --dry-run` で件数を見る → `--dry-run` を外して流す。
6. `env` で合言葉のミドルウェアを ON にして restart。
7. P9（フロントの切り替え）をマージ → デプロイ。
8. 仲間に「合言葉とログインを 1 回やり直してください（Discord の同意画面が 1 回出ます）」と知らせる。

まずいとき:

- `activate <手順 7 の直前のリリース>` で戻す。PHP は `auth.db` と PHP のセッションをそのまま持っているので、すぐ前の状態で動く。
- Rust 側で作られたユーザーやセッションは `app.db` に残るが、害はない。直してからもう一度手順 7 をやればよい。

---

<a id="data"></a>
## 2. 既存データの移行

| データ | どうするか | いつ |
|---|---|---|
| `auth.db` の `users` + `discord_users` | `import-legacy` で `app.db` の `users` に取り込む（下記） | 段階 3 の切り替えの日 |
| `auth.db` の OTP だけのユーザー・`otp_secret` | 取り込まない（D3）。保管だけ | — |
| `auth.db` の `site_tokens` | 取り込まない。仕組みが変わる（Cookie）ので、全員が合言葉を 1 回入れ直す | — |
| `auth.db` の `bot_requests` | 取り込まない（AI 質問を捨てる） | — |
| `arena.db`・`lol_predict.db`・`valorant_predict.db` | 取り込まない。保管だけ（下記） | 段階 0 |
| PHP のセッション・ロックファイル・LoL 戦績のキャッシュ | 移さない | — |
| ランニング（DynamoDB・S3） | 移さない（AWS のまま。D1） | — |
| ブラウザの localStorage（デバイストークン） | 新しい `SiteGate.jsx` が起動するときに消す | 段階 3 |

### `import-legacy` の決まりごと

```sql
-- 旧 auth.db から読むもの
SELECT u.id, du.discord_id, u.username, du.created_at
FROM discord_users du JOIN users u ON u.id = du.user_id;
```

- 読んだ行ごとに `INSERT INTO users (id, discord_id, display_name, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)` をする。`last_login_at` には `created_at` を入れる。
- `discord_id` か `id` が既に `app.db` にあれば**飛ばす**（2 回流しても壊れない。切り替えの前に試しに流して、あとでもう一度流してよい）。
- 旧 DB は**読み取り専用**で開く（`mode=ro`）。旧 DB には一切書き込まない。
- 最後に「取り込んだ数・飛ばした数・Discord と紐付いていないので対象外にした数」を表示する。`--dry-run` のときは書き込まずに数だけ出す。
- `users` の列は、作られた順番によって `created_at` などが有ったり無かったりする（04 の注記）。そのため **`users` からは `id` と `username` しか読まない**。日時は `discord_users.created_at` を使う。

<a id="legacy"></a>
### 捨てる機能のデータの保管（Arena の Elo・予想のポイント・TOTP）

ユーザーの依頼では「Arena の Elo、LoL/VAL のポイント計算、TOTP の計算結果を変えないこと」を保証する必要があった。
しかし、この 3 つは**機能ごと捨てる**（02 の判断）ことになり、新しいコードではどれも計算しない。
だから「新しい計算が古い計算と同じになる」ことを確かめるのではなく、**計算の結果が入っている元のファイルを、1 バイトも変えずに残す**ことで保証する。

手順（段階 0、P1 の前にユーザーと一緒にやる）:

1. ロリポップから FTP で `db-folder/*.db` を 4 つとも落とす。**WAL の残り（`*.db-wal`・`*.db-shm`）があれば、それも一緒に落とす**（`lol_predict.db` は WAL モード）。
2. 手元で、落としたファイルのコピーに対して `sqlite3 <file> "PRAGMA wal_checkpoint(TRUNCATE); PRAGMA integrity_check;"` を流す。`ok` が出ることを確かめる（元のファイルには流さない）。
3. チェックポイントを済ませたファイルの `sha256sum` と、各テーブルの行数（`SELECT count(*)`）を `legacy-manifest.txt` に書く。
4. ファイル 4 つと `legacy-manifest.txt` を、S3 のバックアップ用バケット `legacy/<日付>/` に置く。手元にも 1 部残す。
5. 確かめるとき（いつでも）: S3 から落として `sha256sum` を比べる。中身は `sqlite3` でそのまま見られる（Elo は `arena_ratings`・`arena_rating_history`、ポイントは `lol_points`・`val_points`）。

いつか Arena を作り直して Elo を引き継ぐことになったら、そのときに `arena_design.md` と 05 の「移植時に壊しやすいところ」をもとにテストを作る。
それは今回の範囲には入れない。

---

<a id="golden"></a>
## 3. 移す計算を変えないためのテスト

Rust に移る計算は 4 つある。どれも「**PHP（または AWS の検証側）で作った固定の入出力**」をフィクスチャにして、Rust のテストで同じ結果になることを確かめる。
フィクスチャは `server/tests/fixtures/` に置き、**どうやって作ったか（コマンド）をファイルの先頭か README に書いておく**。
あとで誰かが作り直せるようにするため。

### 3.1 ランニングの HMAC 署名（一番大事。ずれると全部 401 になる）

- 仕様は `document/running_api.md` §2。受ける側は `aws/src/lib/verify-hmac.ts`。
- フィクスチャ `running_hmac.json` に、次の組み合わせを 5 つ以上入れる。それぞれ、全部の入力（method・path・query・discordId・ts・nonce・body・secret）と、期待する `canonical` と `signature` を書く。
  - GET（ボディが空 → `sha256('')`）、クエリなし
  - GET、クエリあり（`limit=20&cursor=...`）
  - POST、日本語を含む JSON ボディ（UTF-8 のバイト列でハッシュすること）
  - PATCH（記録 ID を含むパス）
  - DELETE、クエリあり（`updatedAt=...`）
- 期待値は **受ける側と同じ計算を Node で**作る（`node:crypto` の `createHash` と `createHmac` を、`verify-hmac.ts` と同じ順番で使う短いスクリプト）。受ける側が正なので、受ける側と同じ式で作るのが一番確か。そのスクリプトは `server/tests/fixtures/gen_running_hmac.mjs` として残す。
- Rust のテスト: `running_relay::canonical(...)` と `running_relay::sign(...)` が期待値と同じ文字列を返すこと。署名は**小文字の hex** であること。
- **クエリは、受け取ったままの文字列で署名し、同じ文字列をそのまま転送する**こと（AWS は `rawQueryString` で検証する。並べ替えたり、エンコードし直したりしない）。これは wiremock で「署名に使ったクエリと、届いたクエリが同じ」ことを確かめるテストで守る。
- 本番での確認: 段階 3 の手順 3（curl で `settings` と `me/summary` を取る）。

### 3.2 LoL の連勝計算

- 計算部分を純粋関数にする（`fn summarize(puuid, matches: &[Match]) -> StreakSummary`、`fn sort_results(...)`）。Riot API を呼ぶ部分とは分ける。
- 手で作ったフィクスチャで、`streak.php` と同じ動きになることを確かめる。
  - 3 連勝のあと負け → `streak = 3`
  - 2 連敗のあと勝ち → `streak = -2`
  - 試合が 0 件 → `streak = 0`、`lastChampion = null`、`recentMatches = []`
  - 途中の試合の取得が失敗（`null`）→ その試合を飛ばして続ける
  - 参加者に本人がいない試合 → 飛ばす
  - 連勝が切れても、`recentMatches` は 5 件たまるまで集め続ける。連勝が切れていて 5 件たまったら、そこでやめる
  - アカウントが見つからない → `{name, tag, error:"プレイヤーが見つかりません", streak:0, lastChampion:null, lastMatchTime:null, recentMatches:[]}`（**`soloRank`・`flexRank` のキーは付けない**。PHP と同じ）
  - 並び順: `abs(streak)` の大きい順で、同じなら**設定に書いた順**（PHP の `usort` は 8.0 から安定ソート。Rust の `sort_by` も安定ソート）
- ランクは `RANKED_SOLO_5x5` と `RANKED_FLEX_SR` だけを拾う。取れなければ `null`。
- 本番での確認（段階 2）: 同じ時刻に `GET /api/lol/streak.php` と `GET /api/v1/lol/streak` を取り、`jq -S` でキーを並べてから `diff` する。PHP の 5 分キャッシュとずれないよう、2〜3 回試す。

### 3.3 合言葉の bcrypt 照合

- 今の `SITE_PASSWORD_HASH` は PHP の `password_hash()` で作った `$2y$...` の形。
- フィクスチャに、テスト用の合言葉と、それを PHP で `password_hash('テスト用', PASSWORD_BCRYPT)` して作ったハッシュを入れる（作るコマンドを書いておく）。Rust の `bcrypt::verify` が `true` を返し、違う文字列では `false` を返すことを確かめる。
- 本番の値でも、段階 3 の手順 3 の `site/login` で確かめる。

### 3.4 ゲームサーバーの `displayState`

- [10 の §6.6](10_architecture.md#gameservers) の表の行ごとに、テストを 1 つ作る（`pending` の変更を含む）。
- `GameServerBackend` を偽物にして、「停止のとき、送られた ID ではなくタグで探した ID が使われる」「インスタンスが無いときは停止しない」「120 秒以内の 2 回目の起動は 409」「同時に 2 回起動しても `run_instances` は 1 回しか呼ばれない」を確かめる。

---

## 4. 段階ごとの確認リスト

実装プランの「終わりの条件」に写して使う。

| 段階 | 確かめること |
|---|---|
| 0 | ログインせずに `/api/server/control.php` を叩くと 401／停止がタグで探した ID を使う／消した機能のページ・メニュー・API が無い／残す機能（合言葉・ログイン・LoL 戦績・ランニング・ゲーム 3 本）が動く／旧 DB が S3 にあり、ハッシュ値が記録されている |
| 1 | 仮のサブドメインで、全機能が今と同じに動く／HTTPS の証明書が取れている／`config.php` や `db-folder` が外から見えない／rsync のデプロイと `activate` での戻しを 1 回ずつ試した |
| 2 | `cargo test` が通る／`/api/v1/health` が 200／LoL 戦績の PHP と Rust の比較で差が無い／前のリリースに戻して、また進める練習をした |
| 3 | 段階 3 の手順 3 の項目すべて／ギルドの外の人がログインできない／アカウントを削除するとセッションも消える／合言葉なしで `/api/v1/servers` を叩くと 401／バックアップが S3 にあり、それを手元で開ける |
| 4 | リポジトリに PHP のファイルが無い／`/api/auth/status.php` などが 404（SPA の index.html ではなく）／古い AWS キーが無効／README と `document/` が新しい構成になっている |

段階 4 で、`/api/*` の古い URL は Caddy で 404 にする（SPA にフォールバックさせると、古いフロントがキャッシュに残っているときに分かりにくい壊れ方をするため）。
