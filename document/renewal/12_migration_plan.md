# 12. 移行の段階とデータ移行

[10_architecture.md](10_architecture.md) の続き。どの順番で移し、どう切り替え、まずいときにどう戻すか。
それと、データの移し方と、計算結果が変わらないことの確かめ方。

---

<a id="stages"></a>
## 1. 段階表

タスクの番号（T01 など）は [13_tasks.md](13_tasks.md) のもの。

| 段階 | 中身 | タスク | 切り替え方 | 元に戻す方法 | 次に進む目安 |
|---|---|---|---|---|---|
| **0** ロリポップで片付け | 穴の応急処置（サーバー起動に認証、停止はタグで探す）。捨てる機能のコードを消す | T01, T02, T03 | いつもの FTP デプロイ（`main` にマージ） | `git revert` して再デプロイ | 起動・停止がログインしないとできないこと、残す機能が全部動くことを確かめる |
| **1** 新しいドメインの VPS に PHP のまま移す | ドメインを取り、Lightsail を作り、Caddy + PHP-FPM で今の PHP と dist をそのまま動かす。`auth.db` を写す。デプロイを rsync に変える | T04〜T08 | 下の「[段階 1 の手順](#stage1)」。新しい URL で確かめてから、ロリポップの URL を新しい URL へ転送する | ロリポップの転送をやめる（ロリポップは段階 4 まで解約しない） | 1 週間、問題が出ない |
| **2** Rust の土台 + LoL 戦績 | `server/` を作り、systemd で動かす。LoL 戦績を Rust に移す | T09, T10, T11 | フロントの `LoLStreak.jsx` が新しい URL を呼ぶリリースを出す（`/api/v1/*` は Caddy で常に Rust に行く） | `activate <前のリリース>`。PHP の `streak.php` は残っているので、古いフロントはそのまま動く | 本番で PHP と Rust の応答を比べて同じ（§3.2）。数日問題が出ない |
| **3** 認証・サーバー起動・ランニング | 合言葉・Discord ログイン・アカウント削除・ゲームサーバー・ランニングの中継を Rust に | T12〜T16 を先にマージ → **T17 で一度に切り替える**（T18） | 下の「[段階 3 の手順](#stage3)」 | `activate <段階 3 の直前のリリース>`。PHP 側の `auth.db` とセッションは手を付けていないので、そのまま前の状態で動く（全員もう 1 回ログインするだけ） | 2 週間問題が出ない。仲間が全員ログインできた |
| **4** PHP を消す | PHP のファイル・Caddy の PHP のブロック・PHP の CI を消す。古い AWS キーを消す。ロリポップを解約 | T19, T20, T21 | PHP を含まないリリースを出す | `activate <段階 3 のリリース>`（PHP-FPM はこのあと 2 週間はアンインストールしない） | 2 週間後に PHP-FPM を外し、ロリポップを解約する |

段階 0 と 1 は Rust を書かずにできる。先に済ませておくと、そのあとは VPS の上だけで作業できる。
各段階の切り替えの前には、Lightsail の手動スナップショットを撮る（[11 のバックアップ](11_vps_operations.md#backup)）。

<a id="stage1"></a>
### 段階 1 の手順（URL が変わる）

今のサイトは `https://valol.jellybean.jp`（ロリポップの共有ドメイン）で、DNS を自分で向け直すことはできない。
そのため段階 1 は「DNS の切り替え」ではなく、**新しい URL に引っ越して、古い URL から転送する**形になる。
新しいドメインはまだ誰も使っていないので、公開の前にいくらでも試せる。

前もって:

1. ドメインを取り、A レコード（と AAAA レコード）を Lightsail の静的 IP に向ける（T04）。
2. VPS を作り、`deploy/` の手順で構築し、`main` をデプロイする（T05〜T08）。この時点では、新しい URL を仲間にはまだ知らせない。
3. Discord の開発者画面で、Redirect URI に `https://<新しいドメイン>/api/auth/discord_callback.php` を**足す**（古い URI は消さない）。VPS 側の `discord_config.php` の `redirect_uri` は新しいほうにする。
4. ランニングの AWS 側の設定を直す（T07）: `aws/cdk.json` の `siteOrigin` を**オリジンの一覧**（新・旧の 2 つ）にし、`cdk deploy` する。
   - S3 の CORS（写真を直接アップロードするときに使う）が、新旧どちらのオリジンからも通るようになる。これを忘れると、新しい URL で写真のアップロードだけが失敗する。
   - Discord の `/run web` が案内する URL は、一覧の先頭（新しい URL）になる。
5. 新しい URL で、全機能（合言葉・OTP と Discord のログイン・ゲームサーバー・LoL 戦績・ランニングの記録と写真・ゲーム 3 本）を確かめる。

切り替えの日:

6. ロリポップの `auth.db` を FTP で落とし、VPS の `/var/lib/serversystem/php/db-folder/` に置き直す（確かめている間にできた行を、本番の最新で上書きする）。
7. ロリポップの `.htaccess` の先頭に、すべてのパスを新しい URL へ **302** で転送する行を足す（301 だとブラウザが覚えてしまい、戻すときに困るため）。
8. 仲間に新しい URL を知らせる（合言葉とログインは 1 回やり直しになる。デバイストークンも PHP のセッションも、ドメインが変わると引き継げないため）。

まずいとき: ロリポップの `.htaccess` から転送の行を消せば、元の URL で前と同じに動く。
VPS 側でできたユーザーは `auth.db` の差分になるが、ロリポップ側にも Discord ログインで自動で作られるので、困らない。

<a id="why-bundle"></a>
### 段階 3 をまとめて切り替える理由

「1 機能ずつ切り替える」が基本だが、段階 3 の機能は**ログインのセッションを共有している**。
PHP のセッション（`PHPSESSID`）と Rust のセッション（`sid`）は互いに読めない。そのため、ログインだけを Rust に移すと、まだ PHP のゲームサーバー起動やランニングの中継が「ログインしていない」と判断してしまう。
PHP のセッションを Rust から読む仕組みを作ることもできるが、移行の間しか使わないものに手間をかけることになり、そこが新しい穴にもなりやすい。

そこで、**実装とマージは機能ごとに分け（T12・T13・T14・T16）、フロントの切り替えだけを 1 回にまとめる（T17）**。
T12〜T16 はフロントから呼ばれない間は眠っているだけなので、出来た順に本番に出して、curl で先に確かめられる。
切り替えるときに変わるのはフロントのリリースだけなので、戻すのも 1 コマンドで済む。

<a id="stage3"></a>
### 段階 3 の手順

前もって（T12〜T16 をマージしたあと）:

1. Discord の開発者画面で、Redirect URI に `https://<ドメイン>/api/v1/auth/discord/callback` を**足す**（古い URI は消さない。戻すときに要る）。
2. `/etc/serversystem/env` に Discord・AWS（T15 で作った IAM ユーザー）・ランニングの値を入れ、`APP_SITE_GATE_ENABLED=false` のまま `systemctl restart serversystem`。
3. 本番で curl を使って確かめる（合言葉のミドルウェアは、この時点ではまだ OFF）:
   - `GET /api/v1/health` → 200
   - `POST /api/v1/site/login`（正しい合言葉）→ `site_pass` Cookie が返る。間違いを 11 回 → 429
   - ブラウザで `/api/v1/auth/discord/start` を直接開く → ログインできて `/server` に戻る。`sid` Cookie ができている。ギルドに入っていない別アカウントで試す → `/login?discord_error=not_member`
   - その Cookie を付けて `GET /api/v1/servers` → 今の PHP と同じ内容が返る
   - その Cookie を付けて `GET /api/v1/running/settings` と `GET /api/v1/running/me/summary` → PHP 経由と同じ内容が返る
   - Origin を付けない POST が 403 になる
4. Lightsail で手動スナップショットを撮る。

切り替えの日:

5. `serversystem import-legacy --auth-db /var/lib/serversystem/php/db-folder/auth.db --dry-run` で件数を見る → `--dry-run` を外して流す。
6. `env` の `APP_SITE_GATE_ENABLED` を `true` にして restart。
7. T17（フロントの切り替え）をマージ → デプロイ。
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
| `auth.db` の OTP だけのユーザー・`otp_secret` | 取り込まない（D3・D18）。保管もしない | — |
| `auth.db` の `site_tokens` | 取り込まない。仕組みが変わる（Cookie）ので、全員が合言葉を 1 回入れ直す | — |
| `auth.db` の `bot_requests` | 取り込まない（AI 質問を捨てる） | — |
| `arena.db`・`lol_predict.db`・`valorant_predict.db` | 取り込まない。保管もしない（D18）。段階 1 で VPS に写すのは `auth.db` だけ | — |
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
### 捨てる機能のデータ（Arena の Elo・予想のポイント・TOTP）

ユーザーの判断で、**引き継がず、保管もしない**。使わないため。
新しいコードではどれも計算しないので、「計算結果を変えない」ことを確かめるテストも作らない。
元のファイルはロリポップに残っていて、ロリポップを解約したときに一緒に消える。

いつか Arena などを作り直すことになっても、データは無い前提で、ゼロから始める。

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
| 0 | ログインせずに `/api/server/control.php` を叩くと 401／停止がタグで探した ID を使う／消した機能のページ・メニュー・API が無い／残す機能（合言葉・ログイン・LoL 戦績・ランニング・ゲーム 3 本）が動く |
| 1 | 新しい URL で、全機能が今と同じに動く（ランニングの写真のアップロードを含む）／HTTPS の証明書が取れている／`config.php` や `db-folder` が外から見えない／rsync のデプロイと `activate` での戻しを 1 回ずつ試した／自動スナップショットが有効／ロリポップの URL が新しい URL に転送される |
| 2 | `cargo test` が通る／`/api/v1/health` が 200／LoL 戦績の PHP と Rust の比較で差が無い／前のリリースに戻して、また進める練習をした |
| 3 | 段階 3 の手順 3 の項目すべて／ギルドの外の人がログインできない／アカウントを削除するとセッションも消える／合言葉なしで `/api/v1/servers` を叩くと 401 |
| 4 | リポジトリに PHP のファイルが無い／`/api/auth/status.php` などが 404（SPA の index.html ではなく）／古い AWS キーが無効／README と `document/` が新しい構成になっている |

段階 4 で、`/api/*` の古い URL は Caddy で 404 にする（SPA にフォールバックさせると、古いフロントがキャッシュに残っているときに分かりにくい壊れ方をするため）。
