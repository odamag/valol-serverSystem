# 13. タスク表と担当エージェント

[10](10_architecture.md)〜[12](12_migration_plan.md) の設計を、実際に手を動かす単位に分けたもの。
**だれが（どのモデルが）やるか**、**どの順番で、どれを並べてやるか**、**各エージェントに渡すプロンプト**をまとめた。

---

## 1. 担当の分け方

| 担当 | モデル | 定義ファイル | 任せるもの |
|---|---|---|---|
| **メイン** | 会話しているエージェント（Opus） | — | つなぎ目の判断、ユーザーとの共同作業（AWS・Discord・VPS の画面操作、切り替え）、各タスクの確認とコミット・PR、数行で済む軽微な直し |
| **impl-heavy** | Opus | [`.claude/agents/impl-heavy.md`](../../.claude/agents/impl-heavy.md) | ほかのタスクが前提にする土台、認証（セッション・OAuth）など、間違えると全体や安全性に響くもの |
| **impl-standard** | Sonnet | [`.claude/agents/impl-standard.md`](../../.claude/agents/impl-standard.md) | 設計書で仕様が決まっている、ふつうの実装とテスト |
| **impl-light** | Haiku | [`.claude/agents/impl-light.md`](../../.claude/agents/impl-light.md) | 削除・置き換えなど、手順として決まっている軽い作業 |
| **ユーザー** | — | — | お金・アカウント・秘密情報が絡む操作（ドメインの購入、Lightsail の作成、シークレットの入力、PR のマージ、ロリポップの解約） |

決め方:
- **迷ったら 1 つ上のモデルにする。** やり直しのほうが高くつくため。
- **つなぎ目と結合はメインが持つ。** 不具合はタスクとタスクの間に集まるため（`subagent-plan` の方針と同じ）。
- 設定ファイルを 1〜2 か所直すだけ、などの**軽微な作業はメインがその場でやる**（エージェントを起動するたびに文書を読み直すので、小さすぎる作業を任せると高くつく）。

---

## 2. タスク表

難しさ: ★ 軽い ／ ★★ ふつう ／ ★★★ 難しい。

| ID | タスク | 担当 | 難しさ | 段階 | 前に終わっている必要があるもの |
|---|---|---|---|---|---|
| T01 | PHP の応急処置（ゲームサーバーにログイン必須、停止はタグで探す、Minecraft だけにする） | impl-standard | ★★ | 0 | — |
| T02 | 捨てる機能のコードを消す | impl-light | ★ | 0 | — |
| T03 | 段階 0 のデプロイと確認、Palworld・7 Days to Die の AWS の資源を消す | メイン + ユーザー | ★ | 0 | T01, T02 |
| T04 | ドメインの取得、Lightsail の作成（静的 IP・ファイアウォール・自動スナップショット・SSH 鍵）、DNS | ユーザー（メインが手順を案内） | ★ | 1 | — |
| T05 | VPS の構築ファイル一式（`deploy/`） | impl-standard | ★★ | 1 | — |
| T06 | デプロイの自動化（`deploy.yml` を rsync に、CI の PHP を 8.3 に） | impl-standard | ★★ | 1 | T05 |
| T07 | ランニングの AWS を新旧 2 つのオリジンに対応させる | impl-standard | ★★ | 1 | — |
| T08 | VPS の構築と段階 1 の切り替え | メイン + ユーザー | ★★ | 1 | T03, T04, T06, T07 |
| T09 | Rust の土台（クレート・つなぎ目・ミドルウェア・セッション・テストの補助・CI） | **impl-heavy** | ★★★ | 2 | T06 |
| T10 | LoL 戦績を Rust に | impl-standard | ★★ | 2 | T09 |
| T11 | 段階 2 の切り替えと、PHP との突き合わせ | メイン | ★ | 2 | T08, T10 |
| T12 | 合言葉（`/site/*`・回数制限・`hash-password`） | impl-standard | ★★ | 3 | T09 |
| T13 | Discord ログイン・`/auth/*`・`DELETE /me`・`import-legacy` | **impl-heavy** | ★★★ | 3 | T09 |
| T14 | ゲームサーバーを Rust に | impl-standard | ★★ | 3 | T09 |
| T15 | IAM ユーザーとポリシーを作って確かめる | メイン + ユーザー | ★★ | 3 | T14 |
| T16 | ランニングの中継を Rust に | impl-standard | ★★ | 3 | T09 |
| T17 | フロントの切り替え（段階 3 の分） | impl-standard | ★★ | 3 | T12, T13, T14, T16 |
| T18 | 段階 3 の本番確認と切り替え | メイン + ユーザー | ★★ | 3 | T15, T17 |
| T19 | PHP のコードと設定を消す | impl-light | ★ | 4 | T18 から 2 週間 |
| T20 | README と設計書を新しい構成に合わせて直す | impl-standard | ★ | 4 | T19 |
| T21 | 後片付け（PHP-FPM・古い AWS キー・Discord の古い Redirect URI・ロリポップの解約） | ユーザー + メイン | ★ | 4 | T20 から 2 週間 |

数え: メイン 6（うちユーザーと一緒 5）、impl-heavy 2、impl-standard 10、impl-light 2、ユーザー 1。

---

## 3. ウェーブ（並べて動かす組）

同時に動かすエージェントは **3 つまで**にする。

```
W1 段階0:  [T01 standard] [T02 light]                 → メインが確認・コミット → PR → ユーザーがマージ → T03
W2 段階1:  [T05 standard] [T07 standard]  (T04 ユーザー)
           → [T06 standard]                           → PR → マージ → T08
W3 段階2:  [T09 heavy]                                 → PR → マージ
W4 段階2-3:[T10 standard] [T12 standard] [T16 standard] ← worktree で並列
           → PR（T10 の分は先に出して T11）
           [T13 heavy] [T14 standard]                 ← worktree で並列 → PR → T15
W5 段階3:  [T17 standard]                              → PR（マージは T18 の切り替えの日）
W6 段階4:  [T19 light] → [T20 standard]               → PR → T21
```

- **Rust のタスクを並べるときは、`isolation: "worktree"` で起動する。** 同じクレートなので、同じ作業ツリーで並べると、片方の書きかけのコードがもう片方の `cargo test` を壊すため。メインが終わった順に取り込む。T09 でつなぎ目と依存クレートを全部用意してあるので、`Cargo.toml`・`state.rs`・`routes/mod.rs` はぶつからない。
- フロントやデプロイのタスク（T01/T02、T05/T07）は触るファイルが重ならないので、同じ作業ツリーでよい。
- 使用量に余裕がないときは、並べずに 1 つずつ流す（順番は表のとおり）。

## 4. メインの進め方（1 タスクごと）

1. `main` から作業用ブランチを切る（`claude/renewal-w<番号>` など。ウェーブが終わったら PR にして消す。長く残さない）。
2. このファイルの「プロンプト」をそのまま渡して、`Agent` を `subagent_type: "<担当>"` で起動する。モデルはエージェントの定義で決まる。
3. 報告を読み、差分を設計書と見比べる。特に「変えてよいファイル」以外を触っていないか、つなぎ目を変えていないかを見る。
4. 完了の条件のコマンドを、メインがもう一度流す。
5. 小さな直しはメインが入れる。大きな直しは、同じエージェントに `SendMessage` で頼む（文脈が残っているので安い）。
6. **1 タスク = 1 コミット**。コミットのメッセージにタスクの ID を入れる（例: `T10: LoL 戦績を Rust に移す`）。
7. ウェーブの終わりに PR を作る。**マージはユーザー**。
8. 設計書と違うことになったら、メインが設計書（10〜12・このファイル）を先に直す。

> `.claude/agents/` のエージェントは、Claude Code のセッションを始めたときに読み込まれる。このファイルを追加したセッションでは見えないことがあるので、**実装は新しいセッションで始める**。

---

## 5. 各タスクのプロンプト

エージェントの定義に共通の決まり（読む範囲、触らないもの、コミットしない、報告の形）が書いてあるので、ここにはタスクごとの中身だけを書く。
「§」は特に断りがなければ `document/renewal/10_architecture.md` の節。

### T01 PHP の応急処置と Minecraft だけにする（impl-standard）

```text
担当: T01 PHP の応急処置と Minecraft だけにする
読むもの: document/renewal/10_architecture.md の D2（「Minecraft だけにする」の段落を含む）と §8「今回の調査で見つけた穴」の N1。api/common.php、api/server/control.php、api/server/status.php、frontend/src/pages/ServerControl.jsx。
変えてよいファイル: api/server/control.php、api/server/status.php、frontend/src/pages/ServerControl.jsx
やること:
- control.php と status.php の先頭（session_start と common.php の読み込みのあと）で requireAuth() を呼ぶ。
- control.php の stop は、POST の instanceId を使わない。start の重複確認と同じ describeInstances（tag:Name = 対象のタグ、状態 pending/running/stopping/shutting-down）で探したインスタンスの ID を terminate する。見つからなければ「⚠️ 停止するサーバーが見つかりません」を返す。
- control.php と status.php の $servers から palworld と 7days を消し、minecraft だけにする。$creds の PALLWORLD_LT_ID・SEVENDAYS_LT_ID も読まない。
- ServerControl.jsx: 説明文（page-subtitle）を「Minecraft の AWS サーバーを管理します」にする。status または control の応答が 401 のときは、ポーリングを止め、「サーバーの操作にはログインが必要です」とログイン画面へのリンク（/login?next=/server。リンクを押す前に sessionStorage の postLoginRedirect に '/server' を入れる）を出す。ほかの表示は変えない。
完了の条件: php -l api/server/control.php と php -l api/server/status.php が通る。cd frontend && npm run build が通る。grep -rn "palworld\|7days" api/server frontend/src/pages が何も返さない。
```

### T02 捨てる機能のコードを消す（impl-light）

```text
担当: T02 捨てる機能のコードを消す
読むもの: document/renewal/10_architecture.md の §1 と「フロントの変更範囲」の表の段階 0 の行。frontend/src/App.jsx、frontend/src/components/Sidebar.jsx、frontend/src/pages/MiniGames.jsx。
変えてよいファイル: 下の「消す」に挙げたもの、frontend/src/App.jsx、frontend/src/components/Sidebar.jsx、frontend/src/pages/MiniGames.jsx、frontend/src/index.css（Palworld の 1 行だけ）、config.php.example、README.md（Palworld の記述だけ）
やること:
- 消す（git rm）: frontend/src/pages/ArenaAdmin.jsx ArenaHeadToHead.jsx ArenaHome.jsx ArenaMyGames.jsx ArenaRanking.jsx ArenaSeries.jsx LoLInfo.jsx LoLPredict.jsx ValorantPredict.jsx、frontend/src/components/arena/、frontend/src/hooks/useSeriesSync.js、frontend/src/lib/arenaApi.js、games/minigame/、games/linegame/、api/arena/、api/lol/predict.php、api/lol/champion-bot.php、api/valorant/、api/debug/、api/ai_config.php.example
- App.jsx: 消したページの import と Route を消す（/lol、/lol-predict、/val-predict、/arena 以下すべて）。
- Sidebar.jsx: 消したページへのメニューを消す。
- MiniGames.jsx: /games/minigame/ と /games/linegame/ の 2 件を一覧から消す。
- index.css の使われなくなったスタイルは消さない（あとで別にやる）。ただし `.server-card-header.palworld` の 1 行だけは消す。
- config.php.example から PALLWORLD_LT_ID と SEVENDAYS_LT_ID の行を消す。README.md の「MinecraftやPalworldのサーバー」を「Minecraftのサーバー」にする。
完了の条件: cd frontend && npm run build が通る。grep -rn --include=*.jsx --include=*.js "arena\|LoLPredict\|ValorantPredict\|LoLInfo\|minigame/\|linegame" frontend/src が何も返さない（runningApi.js のコメントの "arenaApi.js の複製" だけは残ってよい）。
```

### T05 VPS の構築ファイル一式（impl-standard）

```text
担当: T05 VPS の構築ファイル一式
読むもの: document/renewal/11_vps_operations.md の全部。document/renewal/12_migration_plan.md の「段階 1 の手順」。.htaccess（今の PHP のルーティングの参考）。
変えてよいファイル: deploy/ 以下（新規）、.gitignore
やること（deploy/ に作るもの）:
- setup.sh: Ubuntu 24.04 の Lightsail で、ubuntu ユーザーから sudo で 1 回流す構築スクリプト。何度流しても同じ結果になるように書く（set -euo pipefail）。中身: 1 GB のスワップ、Caddy（公式 apt リポジトリ）、php8.3-fpm php8.3-sqlite3 php8.3-curl、ユーザー serversystem（nologin）と deploy、11 §1 のディレクトリと所有者・権限、sshd の PasswordAuthentication no / PermitRootLogin no、/etc/sudoers.d/deploy（visudo -c で確かめる）、/etc/caddy/Caddyfile（import の 1 行）、caddy の systemd override で SITE_DOMAIN 環境変数を渡す（ドメインは setup.sh の引数）、PHP-FPM のプール設定（pm=ondemand、max_children=3）、serversystem.service の配置と daemon-reload（enable は bin があるときだけ）、journald の SystemMaxUse=500M。
- activate.sh: 11 §6 の手順 1〜7。PHP の設定ファイルへのシンボリックリンク（/etc/serversystem/php/ の config.php→<release>/config.php、site_config.php→api/site_config.php、discord_config.php→api/auth/discord_config.php、lol_config.php→api/lol/config.php、running_config.php→api/running/config.php、aws.phar→lib/aws.phar、/var/lib/serversystem/php/db-folder→<release>/db-folder）は、リリースに api/ があるときだけ張る。Rust の restart と health の確認は、リリースに bin/serversystem があるときだけ行う。
- caddy/site.caddy: 11 §2 の形。ドメインは {$SITE_DOMAIN} にする（リポジトリにドメインを書かない）。
- systemd/serversystem.service: 11 §3 の形。
- sudoers/deploy、php/pool-override.conf（ファイル名は自由）
- README.md: 構築手順書。T04 で作った Lightsail に SSH で入るところから、setup.sh の実行、/etc/serversystem/env と /etc/serversystem/php/* の置き方（値はユーザーが自分で入れる。ひな形と、各値をどこで取ってくるかを書く）、auth.db の置き方、GitHub の Secrets（VPS_HOST・VPS_SSH_KEY・VPS_KNOWN_HOSTS）の作り方、動作確認、activate での戻し方、スナップショットからの戻し方（11 §5）まで。
- env.example: /etc/serversystem/env のひな形（10 §6.5 の変数をすべて、値はダミー）。
完了の条件: bash -n deploy/*.sh が通る。deploy/README.md の手順に、上の項目がすべて入っている。
```

### T06 デプロイの自動化（impl-standard）

```text
担当: T06 デプロイの自動化
読むもの: document/renewal/11_vps_operations.md の §6・§7。deploy/activate.sh、deploy/README.md（T05 で作ったもの）。.github/workflows/deploy.yml、.github/workflows/ci.yml。
変えてよいファイル: .github/workflows/deploy.yml、.github/workflows/ci.yml
やること:
- deploy.yml を、FTP から「ビルド → リリースの組み立て → rsync over SSH → activate」に書き換える。runs-on は ubuntu-24.04。
  - フロントをビルドする。server/Cargo.toml があるときだけ Rust をビルドする（cargo build --release --locked、Swatinem/rust-cache）。
  - リリース（<YYYYMMDD-HHMM>-<短い sha>）に入れるもの: dist/、games/（*/tests/・*/dev/・*/package.json を除く）、deploy/、api/ と lib/（あるときだけ。*.example と config 類は入れない）、bin/serversystem（あるときだけ）。
  - SSH は secrets.VPS_SSH_KEY・VPS_HOST・VPS_KNOWN_HOSTS を使う（StrictHostKeyChecking は known_hosts で固定）。ユーザーは deploy。
  - workflow_dispatch の入力 release（任意）。指定されたらビルドせず activate <release> だけを流す（戻すため）。
- ci.yml の php-lint を PHP 8.3 にする。aws ジョブに npm test を足す。
完了の条件: npx --yes js-yaml .github/workflows/deploy.yml > /dev/null と npx --yes js-yaml .github/workflows/ci.yml > /dev/null が通る。
```

### T07 ランニングの AWS を新旧 2 つのオリジンに対応させる（impl-standard）

```text
担当: T07 ランニングの AWS を新旧 2 つのオリジンに対応させる
読むもの: document/renewal/12_migration_plan.md の「段階 1 の手順」の 4。aws/cdk.json、aws/lib/running-data-stack.ts、aws/lib/running-app-stack.ts、aws/src/handlers/worker.ts の SITE_ORIGIN と buildWebUrl のまわり。
変えてよいファイル: aws/lib/running-data-stack.ts、aws/lib/running-app-stack.ts、aws/cdk.json、aws/test/ 以下（必要なら追加）
やること:
- cdk.json の context に siteOrigins（文字列の配列）を足し、今の値 "https://valol.jellybean.jp" を 1 つ入れておく。新しいドメインはメインが T08 で先頭に足す。
- 両スタックで、siteOrigins があればそれを、無ければ従来の siteOrigin（文字列）を 1 つの配列として使う小さな関数を共通にする（aws/lib/ に置く）。
- S3 の CORS の allowedOrigins を、その配列すべてにする（無いときは今と同じ http://localhost:5173）。
- Lambda の環境変数 SITE_ORIGIN には配列の先頭を入れる（/run web が案内する URL）。worker.ts は変えない。
完了の条件: cd aws && npx tsc --noEmit && npm test && npx cdk synth > /dev/null が通る。
```

### T09 Rust の土台（impl-heavy）

```text
担当: T09 Rust の土台
読むもの: document/renewal/10_architecture.md の D4・D6（URL 対応表）・§4・§5・§6 の全部。document/renewal/11_vps_operations.md の §7。api/common.php の deviceNameFromUA。
変えてよいファイル: server/ 以下（新規）、.github/workflows/ci.yml（server ジョブの追加だけ）、.gitignore（server/target と server/.env）、frontend/vite.config.js（開発用プロキシに /api/v1 → http://localhost:8081 を、/api の前に足すだけ）
足してよい依存クレート: 10 §6.1 の表にあるもの全部と、async-trait、subtle、base64、bytes、http-body-util、tower（util）、dev-dependencies に wiremock・tempfile。版は今の最新の安定版。後のタスクが依存を足さなくて済むよう、§6.1 のものは使っていなくても全部入れる。
やること:
- §6.2 のファイルを全部作る。§6.7 の型と関数を、書かれた形のとおりに全部作る。
- 中身まで作るもの: config（§6.5 の変数すべて、APP_SITE_GATE_ENABLED を含む）、error（§6.3）、state、clock、db（PRAGMA・プール・sqlx::migrate!）、migrations/0001_init.sql（§6.4）、auth/token、auth/session（CurrentUser・MaybeUser を含む）、auth/site_pass、middleware/csrf、middleware/site_gate、middleware/rate_limit（client_ip を含む）、routes/health、routes/mod.rs（URL 対応表の新しいパスをすべて登録し、どのパスにどのミドルウェアがかかるかを 1 か所で分かるようにする）、lib.rs の build_app、main.rs（clap: serve / import-legacy / hash-password。serve は起動時にマイグレーションを流し、1 時間ごとに期限切れのセッションと合言葉を消すタスクを動かし、SIGTERM で正しく止まる）、tests/common/mod.rs（§6.7 の補助）。
- 仮のままにするもの（T10〜T16 が中身を作る）: routes の site・auth・me・servers・lol・running のハンドラ（501 と {"success":false,"message":"未実装です"} を返す）、services の 3 つ、auth/discord、cli の 2 つ。型と関数の形は §6.7 のとおりに作っておき、中身だけ仮にする。GameServerBackend の本物（Ec2Backend）は作らなくてよいが、state を組み立てるときに差し込む場所は作る。
- テスト: health が 200。Origin の無い POST が 403、正しい Origin なら通る。APP_SITE_GATE_ENABLED が true のとき site_pass の無いリクエストが 401、例外の 3 パスは通る、false なら素通り。セッションの作成・確認・30 日での期限切れ・1 時間ごとの last_seen_at 更新・削除。合言葉の Cookie の作成と期限切れ。RateLimiter（10 回で止まり、600 秒で戻る）。client_ip（X-Forwarded-For の一番右）。hash_token の長さ。Config::from_env が足りない変数を全部並べる。
- CI: ci.yml に server ジョブ（cargo fmt --check、clippy -D warnings、cargo test --locked、Swatinem/rust-cache）を足す。
- server/.env.example（ダミー値）と rust-toolchain.toml（channel = "1.100"）。
完了の条件: cd server && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test が通る。cargo run -- serve を .env.example の値で起動し、curl http://127.0.0.1:8081/api/v1/health が {"success":true} を返す。
```

### T10 LoL 戦績を Rust に（impl-standard）

```text
担当: T10 LoL 戦績を Rust に
読むもの: document/renewal/10_architecture.md の §6.2 の「約束ごと」と §6.7 の services/lol_streak.rs と tests/common の部分。document/renewal/12_migration_plan.md の §3.2。api/lol/streak.php。server/src/services/lol_streak.rs と server/src/routes/lol.rs（T09 の仮のもの）。
使う部品: §6.7 の AppState・AppResult・Clock・LolStreakService の形。設定は Config の riot_api_key・lol_members・riot の base URL（フィールド名は server/src/config.rs を見る）。
変えてよいファイル: server/src/services/lol_streak.rs、server/src/routes/lol.rs、server/tests/lol.rs（新規）、server/tests/fixtures/lol/（新規）、frontend/src/pages/LoLStreak.jsx（URL を /api/v1/lol/streak にするだけ）
やること:
- streak.php と同じ結果を返す。Riot API を呼ぶ部分と、計算の純粋関数（12 §3.2 の summarize・並べ替え）を分ける。
- 5 分のメモリキャッシュ。期限が切れたとき、同時に来たリクエストで Riot API を何度も呼ばない（tokio::sync::Mutex で 1 つずつ）。
- 12 §3.2 の箇条書きのケースを全部テストにする（純粋関数のテストと、wiremock で Riot API を置き換えた GET /api/v1/lol/streak のテスト）。エラーのときに soloRank・flexRank のキーが無いことも確かめる。
完了の条件: cd server && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test が通る。cd frontend && npm run build が通る。
```

### T12 合言葉（impl-standard）

```text
担当: T12 合言葉
読むもの: document/renewal/10_architecture.md の D4・§4 の表・§6.7（auth/site_pass・middleware・tests/common）。document/renewal/12_migration_plan.md の §3.3。api/auth/site_login.php、api/auth/site_status.php。server/src/routes/site.rs と server/src/cli/hash_password.rs（T09 の仮のもの）。
使う部品: §6.7 の site_pass の関数、RateLimiter、client_ip、device_name_from_ua（T09 で中身まで作ってある）。
変えてよいファイル: server/src/routes/site.rs、server/src/cli/hash_password.rs、server/tests/site.rs（新規）、server/tests/fixtures/site/（新規）
やること:
- GET /api/v1/site/status → {"authenticated": bool}（site_pass が有効か）。
- POST /api/v1/site/login {password}: 空なら 400「パスワードを入力してください」。IP が止められていれば 429。bcrypt で照合し、違えば失敗を記録して 401「パスワードが正しくありません」。合えば site_pass を作って Cookie を付け、{"success":true}。
- hash-password: 標準入力から合言葉を読み（画面に出さない）、bcrypt のハッシュを表示する。
- テスト用の bcrypt ハッシュは、ローカルの PHP で php -r 'echo password_hash("テスト用合言葉", PASSWORD_BCRYPT);' として作り、作ったコマンドをフィクスチャの横に README.md で残す。$2y$ のハッシュが bcrypt::verify で通ることを確かめる。
- テスト: 正しい合言葉で Cookie が付き status が true になる。間違いで 401。11 回目で 429。空で 400。
完了の条件: cd server && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test が通る。
```

### T13 Discord ログイン（impl-heavy）

```text
担当: T13 Discord ログイン・ログイン状態・ログアウト・アカウント削除・import-legacy
読むもの: document/renewal/10_architecture.md の D3・D5・§4（Discord ログインの流れを含む）・§5・§6.4・§6.7。document/renewal/12_migration_plan.md の §2（import-legacy の決まりごと）。api/auth/discord_redirect.php、api/auth/discord_callback.php、api/auth/status.php、api/auth/logout.php、api/auth/profile.php。server/src/auth/discord.rs、server/src/routes/auth.rs、server/src/routes/me.rs、server/src/cli/import_legacy.rs（T09 の仮のもの）。
使う部品: §6.7 の session の関数・CurrentUser・MaybeUser・DiscordOAuth の形・tests/common。
変えてよいファイル: server/src/auth/discord.rs、server/src/routes/auth.rs、server/src/routes/me.rs、server/src/cli/import_legacy.rs、server/tests/auth.rs・server/tests/import_legacy.rs（新規）、server/tests/fixtures/legacy/（新規）
やること:
- GET /api/v1/auth/discord/start、GET /api/v1/auth/discord/callback（§4 の流れ。エラーの理由も §4 のとおり）。oauth_state の Cookie の属性は §4 の表のとおり。state は定数時間で比べる。
- GET /api/v1/auth/status → {"loggedIn","userId","username"}。POST /api/v1/auth/logout。DELETE /api/v1/me（users を消し、Cookie を消す）。
- users の upsert: discord_id で探し、あれば display_name と last_login_at を更新、無ければ作る。
- import-legacy: 12 §2 の決まりごとのとおり（読み取り専用で開く、2 回流しても壊れない、--dry-run、件数の表示）。旧 auth.db のフィクスチャはテストの中で作る（created_at 列が有る users と無い users の両方）。
- テスト（Discord は wiremock）: 正常にログインできて sid が付く。state 違い・期限切れ・拒否・トークン交換失敗・ギルド外（404）で、それぞれ /login?discord_error=<理由> に戻る。表示名の更新。ログアウトで行が消える。アカウント削除でセッションも消える。import-legacy の件数と冪等性。
完了の条件: cd server && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test が通る。
```

### T14 ゲームサーバーを Rust に（impl-standard）

```text
担当: T14 ゲームサーバーを Rust に
読むもの: document/renewal/10_architecture.md の D2・§6.6・§6.7（services/game_servers.rs と tests/common）。document/renewal/12_migration_plan.md の §3.4。api/server/status.php、api/server/control.php（T01 で直したもの）。server/src/services/game_servers.rs と server/src/routes/servers.rs（T09 の仮のもの）。
使う部品: §6.7 の GameServerBackend・InstanceInfo・GameServerService の形、CurrentUser、tests/common。
変えてよいファイル: server/src/services/game_servers.rs、server/src/routes/servers.rs、server/tests/servers.rs（新規）。state を組み立てる関数で Ec2Backend を差し込む 1 行が必要なら、その 1 行だけ server/src/state.rs を変えてよい。
やること:
- Ec2Backend（aws-sdk-ec2）: find_instance は status.php の describeInstances と同じフィルタ。run_from_template は control.php の runInstances と同じパラメータ（スポット・one-time・terminate・Name と GameStatus=Booting のタグ）。
- GameServerService: サーバーの定数の一覧（今は Minecraft の 1 件だけ。名前・タグ・ポート・起動テンプレート ID の設定名。§6.5 の下の段落）、§6.6 の displayState の表、起動中ロック（120 秒、メモリ上、ターゲットごとの Mutex で 1 つずつ）、状態の 3 秒キャッシュ（起動・停止で捨てる）。status の JSON は status.php と同じ形。メッセージの文言は control.php と同じ。AWS のエラー文は画面に出さない（§6.3）。
- ルート: GET /api/v1/servers、POST /api/v1/servers/{target}/start、POST /api/v1/servers/{target}/stop（どれも CurrentUser 必須。target が minecraft 以外なら 404）。
- テスト（偽の GameServerBackend）: 12 §3.4 の項目すべて。未ログインで 401。target=palworld で 404。
完了の条件: cd server && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test が通る。
```

### T16 ランニングの中継を Rust に（impl-standard）

```text
担当: T16 ランニングの中継を Rust に
読むもの: document/renewal/10_architecture.md の D1・URL 対応表のランニングの行・§6.7（services/running_relay.rs と tests/common）。document/renewal/12_migration_plan.md の §3.1。document/running_api.md の §1・§2。api/running/index.php、api/running/lib/aws.php、aws/src/lib/verify-hmac.ts。server/src/services/running_relay.rs と server/src/routes/running.rs（T09 の仮のもの）。
使う部品: §6.7 の canonical・sign・RunningRelay の形、CurrentUser（SessionUser に discord_id がある）、tests/common。
変えてよいファイル: server/src/services/running_relay.rs、server/src/routes/running.rs、server/tests/running.rs（新規）、server/tests/fixtures/running_hmac.json・gen_running_hmac.mjs（新規）
やること:
- /api/v1/running/<X> を受け、index.php の $ALLOWED と同じホワイトリスト（メソッドが違えば 405、パスが無ければ 404）で確かめ、/v1/<X> にして転送する。
- ボディは GET・DELETE では読まない。16 KiB を超えたら 413。クエリは受け取った生の文字列のまま署名し、同じ文字列で転送する。
- 応答の扱いは index.php と同じ（接続できなければ 503、success を含む JSON でなければ 502、それ以外はステータスとボディをそのまま返す）。メッセージも同じ文言。
- フィクスチャ: gen_running_hmac.mjs（verify-hmac.ts と同じ式で期待値を作る Node のスクリプト）で、12 §3.1 の 5 つの組み合わせを作る。
- テスト: canonical と sign がフィクスチャと一致する。wiremock で、届いたヘッダ（X-Run-*）と、署名に使ったクエリと届いたクエリが同じことを確かめる。ホワイトリスト外で 404/405。未ログインで 401。413。上流が落ちていると 503。
完了の条件: node server/tests/fixtures/gen_running_hmac.mjs の出力が running_hmac.json と同じ。cd server && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test が通る。
```

### T17 フロントの切り替え（impl-standard）

```text
担当: T17 フロントの切り替え
読むもの: document/renewal/10_architecture.md の D4・D6（URL 対応表と「フロントの変更範囲」の段階 3 の行）。下の「変えてよいファイル」に挙げたファイル。
変えてよいファイル: frontend/src/App.jsx、frontend/src/components/SiteGate.jsx、frontend/src/components/Sidebar.jsx、frontend/src/pages/Login.jsx、frontend/src/pages/Register.jsx（削除）、frontend/src/pages/Profile.jsx、frontend/src/pages/ServerControl.jsx、frontend/src/lib/runningApi.js
やること:
- 「フロントの変更範囲」の段階 3 の行をすべてやる。呼ぶ URL は URL 対応表の新しいほう。
- SiteGate.jsx: GET /api/v1/site/status → 通っていなければ入力欄 → POST /api/v1/site/login。localStorage は使わない。起動時に古いキー（今のコードの SITE_TOKEN_KEY）を localStorage から消す。429 と 401 のときは返ってきた message を出す。
- ServerControl.jsx: GET /api/v1/servers と POST /api/v1/servers/{target}/start|stop（ボディなし）。
- Login.jsx: OTP の入力欄を消す。discord_error=not_member のときは「この Discord アカウントは、サーバーのメンバーではないためログインできません」を出す。
- App.jsx の /server を RequireLogin で包み、/register を消す。
- 状態を変える fetch（POST・DELETE）は、今のとおり同じオリジンに credentials: 'include' で送る（Origin はブラウザが付ける）。
完了の条件: cd frontend && npm run build が通る。grep -rn "\.php" frontend/src が何も返さない。
```

### T19 PHP のコードと設定を消す（impl-light）

```text
担当: T19 PHP のコードと設定を消す
読むもの: document/renewal/12_migration_plan.md の「段階ごとの確認リスト」の段階 4 の行。deploy/activate.sh、deploy/caddy/site.caddy、.github/workflows/deploy.yml、.github/workflows/ci.yml、frontend/vite.config.js。
変えてよいファイル: 下の「消す」に挙げたもの、deploy/activate.sh、deploy/caddy/site.caddy、deploy/setup.sh、.github/workflows/deploy.yml、.github/workflows/ci.yml、frontend/vite.config.js、.gitignore
やること:
- 消す（git rm、追跡されているものだけ）: api/、lib/、config.php.example、.htaccess
- activate.sh: PHP の設定へのシンボリックリンクを張る部分を消す。
- site.caddy: PHP のブロック（@php_private と handle /api/*）を消し、かわりに /api/* を respond 404 にする（/api/v1/* の handle より後ろに置く）。
- setup.sh: PHP-FPM のインストールとプール設定を消す。
- deploy.yml: リリースに api/ と lib/ を入れる部分を消す。ci.yml: php-lint ジョブを消す。
- vite.config.js: /api → 8080 のプロキシを消す（/api/v1 → 8081 は残す）。
- .gitignore: PHP の設定ファイルと aws.phar の行を消す。
完了の条件: git ls-files | grep -E "\.php$" が何も返さない。bash -n deploy/*.sh が通る。cd frontend && npm run build が通る。npx --yes js-yaml .github/workflows/deploy.yml > /dev/null と ci.yml も通る。
```

### T20 README と設計書を直す（impl-standard）

```text
担当: T20 README と設計書を新しい構成に合わせて直す
読むもの: README.md、document/renewal/README.md、document/renewal/10_architecture.md の §1・§2・§6.2、document/renewal/11_vps_operations.md の §6、deploy/README.md。document/ 直下のファイル一覧。
変えてよいファイル: README.md、document/renewal/README.md、document/arena_design.md・document/database_design.md（削除）、.claude/setting.json（PHP の設定ファイルの deny の行を消す）
やること:
- README.md を、今の構成（frontend/・games/・server/・aws/・deploy/）、開発のしかた（cargo run と npm run dev）、デプロイのしかた（main へのマージ、activate での戻し方）に書き直す。日本語で平易に。
- 捨てた機能の設計書（arena_design.md、database_design.md）を消す。
- document/renewal/README.md の先頭に「移行は完了した」ことと日付を書く。
完了の条件: README.md から PHP・ロリポップ・FTP の説明が無くなっている。リンク切れが無い。
```

### メインとユーザーのタスク（プロンプトなし）

| ID | 中身 |
|---|---|
| T03 | PR をユーザーがマージ → FTP で自動デプロイ → ユーザーがブラウザで 12 §4 の段階 0 の項目を確かめる（メインは確かめる手順を示す）。そのあとユーザーが AWS の画面で、Palworld・7 Days to Die のインスタンスが動いていないことを確かめ、起動テンプレート 2 つ、専用の AMI とスナップショット・セキュリティグループ・IAM ロール（あれば）を消す。S3 のワールドのバックアップは、残すか消すかをユーザーが決める。本番の `config.php` の 2 つの ID の行は、消しても残してもよい（もう読まれない） |
| T04 | ユーザー: ドメインを取る（Route 53 がおすすめ。10 §9）。Lightsail で東京・Ubuntu 24.04・512 MB（IPv4 付き）のインスタンスを作り、静的 IP を付け、ネットワークで 22/80/443 を開け、自動スナップショットを有効にする。DNS の A（と AAAA）レコードを静的 IP に向ける。SSH 鍵を手元に置く。メインは画面の手順を 1 つずつ案内する |
| T08 | メイン: ユーザーの許可を得て SSH で `deploy/setup.sh` を流す。ユーザー: `/etc/serversystem/env` と `/etc/serversystem/php/*` に秘密の値を自分で入れる（メインはひな形だけ用意する）。GitHub の Secrets を入れる。メイン: `cdk.json` の `siteOrigins` の先頭に新しいオリジンを足して PR（`cdk deploy` は main へのマージで流れる）。そのあとは 12 の「段階 1 の手順」のとおり |
| T11 | メイン: T10 のマージ後、12 §3.2 の PHP と Rust の突き合わせをする。手動スナップショットを撮ってもらってから |
| T15 | メイン: 11 の「AWS の IAM ユーザー」の表からポリシーの JSON を作り、`deploy/iam/serversystem-vps-policy.json` に置く。ユーザー: IAM ユーザーを作ってポリシーを付け、アクセスキーを `/etc/serversystem/env` に入れる。メイン: `--dry-run` の手順を示し、ユーザーが流した結果を見て直す |
| T18 | 12 の「段階 3 の手順」のとおり。curl での確認はメイン、ブラウザでのログインと仲間への連絡はユーザー |
| T21 | ユーザー: PHP-FPM を外す（`apt purge php8.3-*`）、古い AWS アクセスキーを消す、Discord の古い Redirect URI を消す、`/var/lib/serversystem/php/` と `/etc/serversystem/php/` を消す、ロリポップを解約する。メインは手順の一覧を出す |
