# ランニング記録 Discord ボット — AWS/Discord/GitHub 手動セットアップ手順書

AI（Claude Code）はブラウザのコンソール（AWS マネジメントコンソール、Discord Developer Portal、
GitHub の設定画面）を操作できない。そのため、環境構築のうち**人間が手で行う必要がある操作**
だけを本書に切り出してある。コード側の実装・IaC（`aws/`）・CI（`.github/`）は別途整備される
前提で、本書は上から順に実行すれば環境構築が完了する構成になっている。

## 前提とする構成

- インフラは AWS（Lambda + DynamoDB + S3）。IaC は AWS CDK（TypeScript）。リージョンは
  **すべて `ap-northeast-1`（東京）** で統一する。
- Discord ボットは **Interactions Endpoint 方式**。Discord Gateway への WebSocket 常時接続は
  行わず、API Gateway が Discord からの HTTPS POST を受けて Lambda を起動する。常駐プロセスは
  不要（ロリポップ ライトプランに SSH が無いのと同じ理由で、AWS 側もサーバーレスで完結させる）。
- Web 側（既存のロリポップ上の React SPA + PHP）は `api/running/index.php` が代理として
  AWS 側の API を叩く。ブラウザから直接 AWS を呼ぶことはしない。
- Discord サーバーは自分が管理する1つのみを対象とする。
- 月額コストは概算 30〜80円程度（無料枠内に収まることが多い想定）。

## 控える値の一覧チェックリスト

作業中に控える値をここにまとめておく。値そのものはこの表に書かず、各自の安全な場所
（パスワードマネージャー等）に控えること。「使う場所」の列は、その値をどの設定に
書き写すかを表している。

| # | 値の名前 | 控えた | 使う場所 |
|---|---|---|---|
| 1 | AWS アカウント ID | ☐ | `cdk bootstrap` のコマンド引数 |
| 2 | IAM 管理者ユーザーのアクセスキー ID / シークレットキー | ☐ | `aws configure --profile running` |
| 3 | Discord Application ID | ☐ | `aws/cdk.json` の `discordAppId` |
| 4 | Discord Public Key | ☐ | `aws/cdk.json` の `discordPublicKey` |
| 5 | Discord Bot Token | ☐ | SSM パラメータ `/running/discord-bot-token` |
| 6 | Discord Guild ID（サーバーID） | ☐ | `aws/cdk.json` の `discordGuildId` |
| 7 | `proxy-shared-secret`（自分で生成する乱数） | ☐ | SSM パラメータ `/running/proxy-shared-secret`、`api/running/config.php` の `shared_secret` |
| 8 | `HttpApiUrl`（CDK デプロイ出力） | ☐ | Discord の Interactions Endpoint URL、`api/running/config.php` の `api_base` |
| 9 | GitHub Actions 用 IAM ロール ARN（`RunningGithubOidc` の出力） | ☐ | GitHub リポジトリの Actions Variables `AWS_DEPLOY_ROLE_ARN` |
| 10 | 告知チャンネル ID | ☐ | Discord 上で `/run-admin channel-set` 実行時に選択（手控え不要、参考用） |

---

## A. AWS アカウントの初期設定（Phase 0・所要目安 30〜45分）

### A-1. AWS アカウント作成とルートユーザーの MFA 設定

1. まだ AWS アカウントが無ければ https://aws.amazon.com/jp/ の「今すぐ無料サインアップ」から作成する。
2. サインアップ直後にルートユーザー（サインアップ時のメールアドレス）で
   コンソールにログインし、右上のアカウント名メニュー →
   「セキュリティ認証情報」（名称が変わっている場合は「Security credentials」を探す）を開く。
3. 「多要素認証（MFA）」セクションで **MFA デバイスの割り当て** を行う。スマートフォンの
   認証アプリ（Google Authenticator、Authy 等）で QR コードを読み取り、連続する2つの
   ワンタイムコードを入力して有効化する。
   > **警告**: ルートユーザーは全権限を持つため、MFA 未設定のまま放置しない。乗っ取られると
   > 課金・データとも被害が甚大になる。

### A-2. IAM 管理者ユーザーの作成とアクセスキー発行

CDK の初回デプロイ（ブートストラップ含む）と、後述 E で `RunningGithubOidc` スタックを
ローカルからデプロイする際に使う。以降の通常デプロイは GitHub Actions が OIDC で
一時認証情報を使うため、長期のアクセスキーは他に必要ない。

1. コンソール上部の検索ボックスで「IAM」を開く（IAM ダッシュボード）。
2. 左メニュー「ユーザー」→「ユーザーを作成」。ユーザー名は任意（例: `running-admin`）。
3. 権限の設定で「ポリシーを直接アタッチする」を選び、`AdministratorAccess` を付与する。
   > 個人プロジェクトの初期構築用なので `AdministratorAccess` で問題ないが、恒久的な運用鍵として
   > 使い続けるものではない点に注意。
4. 作成後、そのユーザーの詳細画面 →「セキュリティ認証情報」タブ →
   「アクセスキーを作成」。用途は「コマンドラインインターフェイス (CLI)」を選択。
5. 表示された **アクセスキー ID** と **シークレットアクセスキー** を控える（チェックリスト #2）。
   > **警告**: シークレットアクセスキーはこの画面を離れると二度と表示されない。
   > 必ずその場でパスワードマネージャー等に保存すること。

### A-3. AWS CLI のインストール（Windows）と `aws configure`

Windows 環境なので、winget かインストーラのどちらかで入れる。

**winget を使う場合（PowerShell）:**
```powershell
winget install -e --id Amazon.AWSCLI
```

**MSI インストーラを使う場合:**
1. https://awscli.amazonaws.com/AWSCLIV2.msi をダウンロードして実行する。
2. ウィザードの指示に従いインストールする（既定設定のままでよい）。

インストール後、新しいターミナル（PowerShell か Git Bash）で確認する。
```bash
aws --version
```

プロファイルを作成する。
```bash
aws configure --profile running
```
対話式で以下を入力する。
```
AWS Access Key ID [None]: <A-2で控えたアクセスキーID>
AWS Secret Access Key [None]: <A-2で控えたシークレットアクセスキー>
Default region name [None]: ap-northeast-1
Default output format [None]: json
```
以降、AWS CLI・CDK のコマンドはすべて `--profile running` を付けて実行する。

### A-4. AWS アカウント ID を控える

```bash
aws sts get-caller-identity --profile running --query Account --output text
```
表示された12桁の数字がアカウント ID（チェックリスト #1）。

### A-5. CDK Bootstrap

```bash
cd aws
npm ci
npx cdk bootstrap aws://<アカウントID>/ap-northeast-1 --profile running
```
`<アカウントID>` は A-4 で控えた値に置き換える。CDK が管理用の S3 バケットや IAM ロールを
初回だけ作成する処理で、以後のデプロイでは実行不要。

### A-6. Budgets で $5 のアラートを作成

> **これは Phase 0 のうちにやる。** Lambda や DynamoDB の設定ミス・無限リトライ・
> 意図しない大量呼び出しなどで課金が暴走した場合の最後の砦になる。IaC が整う前の
> 検証段階が一番事故りやすいので、後回しにせず最初にやっておく。

1. コンソール右上のアカウント名メニュー →「請求とコスト管理」（名称が変わっている場合は
   「Billing and Cost Management」を探す）を開く。
2. 左メニューの「Budgets」（予算）→「予算を作成」。
3. 予算の種類は「費用予算」（Cost budget）を選択。
4. 予算金額に `5`（USD）を入力し、期間は「月次」のままにする。
5. アラートのしきい値を追加（例: 実績コストが予算の80%に達したら通知）。
6. 通知の送信先メールアドレスに自分のメールアドレスを入力する。
7. 「予算を作成」で確定する。

---

## B. Discord アプリケーション / Bot の作成（Phase 0・所要目安 15〜20分）

### B-1. アプリケーション作成

1. https://discord.com/developers/applications を開き、Discord アカウントでログインする。
2. 「New Application」（新しいアプリケーション）をクリックし、名前を入力して作成する
   （例: `ランニング記録Bot`）。

### B-2. Application ID と Public Key を控える

作成直後の「General Information」（一般情報）タブに表示される。

- **APPLICATION ID** → チェックリスト #3（→ `aws/cdk.json` の `discordAppId`）
- **PUBLIC KEY** → チェックリスト #4（→ `aws/cdk.json` の `discordPublicKey`）

> これらは秘密情報ではないので `aws/cdk.json` のコンテキストにそのまま書いてよい
> （Bot Token とは違いリポジトリにコミットされても問題ない）。

### B-3. Bot Token の発行

1. 左メニュー「Bot」タブを開く（無い場合は「Settings」配下を探す）。
2. まだ Bot が作成されていなければ「Add Bot」（または既に自動作成されている）。
3. 「Reset Token」（または「Token」欄の「Copy」）で Bot Token を表示・発行する。

> **警告: Bot Token はこの画面でしか表示されない（一度リセットすると前の値は無効になる）。**
> 必ずその場でパスワードマネージャー等に保存すること（チェックリスト #5）。
> 忘れて画面を閉じた場合は「Reset Token」で再発行すればよいが、再発行すると古いトークンは
> 即座に無効になる点に注意。

このトークンは C 章で SSM パラメータ `/running/discord-bot-token` に登録する。

### B-4. Bot をサーバーに招待

1. 左メニュー「OAuth2」→「URL Generator」を開く。
2. 「SCOPES」で `bot` と `applications.commands` の両方にチェックを入れる。
3. 下に表示される「BOT PERMISSIONS」で **`Manage Roles`（ロールの管理）** にチェックを入れる。
   ランニング実績のロール自動付与に必要。
4. 画面下部に生成された URL をコピーし、ブラウザで開いて自分の Discord サーバーを選び、
   「認証」（Authorize）する。

URL を手で組み立てる場合は以下（`<APP_ID>` を B-2 の Application ID に置き換える）:
```
https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot%20applications.commands&permissions=268435456
```

### B-5. Discord クライアントで開発者モードを ON にする

1. Discord クライアント（デスクトップアプリ or ブラウザ）で「設定」（歯車アイコン）を開く。
2. 「詳細設定」（Advanced）→「開発者モード」を ON にする。
   名称が変わっている場合は「Developer Mode」を探す。
3. これでサーバー名・チャンネル名・ロール名などを右クリックすると「IDをコピー」が
   出るようになる。

### B-6. Guild ID（サーバーID）を控える

サーバー名（左のサーバーアイコン）を右クリック →「サーバーIDをコピー」。
チェックリスト #6（→ `aws/cdk.json` の `discordGuildId`）。

### B-7. 特権インテントについて

Bot タブの「Privileged Gateway Intents」にある **SERVER MEMBERS INTENT** は
**当面 OFF のままでよい**。将来的に Phase 5 などで `GET /guilds/{id}/members`
（メンバー一覧の取得）を使う実装を入れる場合のみ ON にする。現状の
Interactions Endpoint 方式（スラッシュコマンド応答・ロール付与）では不要。

---

## C. SSM Parameter Store への秘密情報の投入（Phase 0・所要目安 10分）

Discord Bot Token と、ロリポップ PHP ↔ AWS 間のリクエストを検証するための共有シークレット
（`proxy-shared-secret`）を SSM Parameter Store に登録する。

> **なぜ Secrets Manager ではなく Parameter Store（SecureString）なのか**:
> Secrets Manager は1シークレットあたり月 $0.40 かかり、この構成の想定総コスト
> （月30〜80円）を単独で上回ってしまう。Parameter Store の Standard 階層 SecureString は
> 無料（KMS の暗号化キー自体も `alias/aws/ssm` という AWS 管理キーを使えば追加コストなし）。

### C-1. CLI で投入する場合（Git Bash を推奨）

> **`openssl` は Git for Windows に同梱されているが、PowerShell の PATH には通っていない。**
> 下の Git Bash 用コマンドを PowerShell にそのまま貼ると、こうなる:
>
> 1. `openssl : 用語 'openssl' は ... 認識されません`（PATH に無い）
> 2. 続けて `argument --value: expected one argument`（1 が失敗して `$(...)` が空になった巻き添え）
>
> エラーは2つ出るが原因は1つ目だけ。Git Bash（Git for Windows 同梱）で実行するのが一番簡単で、
> PowerShell のまま進めたい場合は後述の代替コマンドを使う。

**Git Bash の場合:**
```bash
# Bot Token の登録（B-3 で控えたトークンに置き換える）
aws ssm put-parameter --profile running --region ap-northeast-1 \
  --name /running/discord-bot-token --type SecureString --value '<Bot Token>'

# proxy-shared-secret はここでランダム生成してそのまま登録する
aws ssm put-parameter --profile running --region ap-northeast-1 \
  --name /running/proxy-shared-secret --type SecureString --value "$(openssl rand -hex 32)"
```

生成した `proxy-shared-secret` の値を後で `api/running/config.php` に書き写す必要があるので、
登録後に控えておく（登録前に一旦控えてから登録する方が確実）。
```bash
openssl rand -hex 32
# 表示された値をコピーして控える（チェックリスト #7）→ 次に put-parameter の --value に貼り付け
```

**PowerShell の場合（`openssl` が無い環境向けの代替の乱数生成）:**
```powershell
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$secret = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
$secret
```

> `RandomNumberGenerator::Fill()` は .NET Core 2.1 以降のメソッドで、**Windows PowerShell 5.1
> （.NET Framework 上で動作）には存在しない**（`does not contain a method named 'Fill'` になる）。
> 上記の `Create().GetBytes()` は PowerShell 5.1 / 7 のどちらでも動く。
> `Get-Random` は暗号学的に安全な乱数ではないので、共有シークレットの生成には使わないこと。

表示された64文字の16進文字列を控えたうえで、`aws ssm put-parameter` の `--value` に
そのまま渡す（PowerShell でも `aws` コマンド自体は動く）。
```powershell
aws ssm put-parameter --profile running --region ap-northeast-1 `
  --name /running/proxy-shared-secret --type SecureString --value $secret
```

> **`proxy-shared-secret` の値は控えておくこと。** ただし控え忘れても再生成は不要で、
> `--with-decryption` を付ければ平文で読み返せる。
>
> ```powershell
> aws ssm get-parameter --profile running --region ap-northeast-1 `
>   --name /running/proxy-shared-secret --with-decryption --query Parameter.Value --output text
> ```
>
> 値を変更したい場合は新しい値で `put-parameter` を再実行（上書き）し、
> **`api/running/config.php` 側も必ず同じ値に書き換える**こと。片方だけ変えると
> Lambda 側の署名検証が通らず、Web からの操作が一律 401 になる。

### C-2. コンソールから投入する場合

1. コンソールで「Systems Manager」を検索して開く。
2. 左メニュー「パラメータストア」（Parameter Store）→「パラメータの作成」。
3. 「名前」に `/running/discord-bot-token`（または `/running/proxy-shared-secret`）を入力。
4. 「タイプ」で **「安全な文字列」（SecureString）** を選択。
5. 「KMS キーソース」は既定の `alias/aws/ssm` のままでよい（追加コストなし）。
6. 「値」に Bot Token（または生成した乱数）を貼り付けて「パラメータの作成」。

### C-3. 登録後の確認

```bash
aws ssm get-parameters --profile running --region ap-northeast-1 \
  --names /running/discord-bot-token /running/proxy-shared-secret --with-decryption \
  --query 'Parameters[].Name'
```
2件とも名前が返ってくれば登録成功（`--with-decryption` を付けなければ値は伏字表示になる）。

---

## D. Interactions Endpoint URL の設定（Phase 0・CDK デプロイ後・所要目安 10〜15分）

> この章は `RunningData` / `RunningApp` スタックが AWS 側にデプロイ済みであることが前提。
> デプロイ自体はコード側の作業（GitHub Actions または E-1 のようなローカル `cdk deploy`）で
> 行われる想定。ここでは**デプロイ済みの状態から先**の手動操作を扱う。

### D-1. `HttpApiUrl` を控える

デプロイ実行後、ターミナルの出力（CDK の Outputs）に `HttpApiUrl` が表示される。
```
Outputs:
RunningApp.HttpApiUrl = https://xxxxxxxxxx.execute-api.ap-northeast-1.amazonaws.com/
```
この値を控える（チェックリスト #8）。出力を見逃した／閉じてしまった場合は、
コンソールの API Gateway → 対象の HTTP API →「ステージ」から呼び出し URL を確認できる。

### D-2. Developer Portal に登録する

1. https://discord.com/developers/applications で対象アプリケーションを開く。
2. 「General Information」タブの「INTERACTIONS ENDPOINT URL」欄に、
   `<HttpApiUrl>discord/interactions` を貼り付ける。
   > `HttpApiUrl` の末尾に既にスラッシュが付いているので、二重スラッシュにならないよう
   > 貼り付け後に URL 全体を目視確認すること
   > （例: `https://xxxxxxxxxx.execute-api.ap-northeast-1.amazonaws.com/discord/interactions`）。
3. 「Save Changes」をクリックする。

### D-3. 保存が通ったことの意味

**保存が通れば署名検証（Ed25519）が正しく動いている証拠。** Discord は URL 保存時に、
正しい署名を付けたテストリクエストと、わざと不正な署名を付けたテストリクエストの両方を
送信してくる。エンドポイント側が「正しい署名は 200、不正な署名は 401」を正しく
返せないと、Discord は URL の登録自体を拒否する（保存ボタンを押すとエラーが表示される）。
つまりこの保存操作自体が Lambda 側の署名検証ロジックの動作確認になっている。

### D-4. 保存に失敗する場合の切り分け手順

1. **CloudWatch Logs を見る**: コンソール → CloudWatch → 左メニュー「ロググループ」→
   `/aws/lambda/RunningApp-Interactions...`（スタック名から始まるロググループを探す）を開き、
   最新のログストリームで例外・エラーメッセージを確認する。
2. **`DISCORD_PUBLIC_KEY` が正しいか確認**: Lambda コンソール → 対象関数 →
   「設定」タブ →「環境変数」を開き、B-2 で控えた Public Key と一致しているか目視で比較する。
   ずれている場合は `aws/cdk.json` の `discordPublicKey` を修正して再デプロイする。
3. **URL の末尾を再確認**: `<HttpApiUrl>` の末尾スラッシュと `discord/interactions` の
   先頭が重複して `//discord/interactions` のようになっていないか確認する。

---

## E. GitHub 側の設定（Phase 0・所要目安 10〜15分）

### E-1. `RunningGithubOidc` スタックをローカルからデプロイ

> **このスタックだけは GitHub Actions からデプロイできない。** GitHub Actions が AWS を
> 呼び出すための OIDC プロバイダ・IAM ロールを定義するスタック自身なので、
> 「そのロールが無いと Actions が動けないのに、そのロールを作るのが Actions 自身」という
> 鶏と卵の関係になってしまう。そのため、A で作った IAM 管理者ユーザーの認証情報を使って
> 自分のマシンから1回だけ手動デプロイする。

デプロイの前に、`aws/cdk.json` の `context.githubRepo` が自分のリポジトリと
一致しているか確認する（既定値は `odamag/serverSystem`）。

```jsonc
"githubRepo": "odamag/serverSystem"
```

> この値は IAM ロールの信頼ポリシーに `repo:<owner>/<repo>:ref:refs/heads/main` として
> 埋め込まれ、「main ブランチからのデプロイだけを許可する」制限を AWS 側で強制するために使う。
> **ここが実際のリポジトリと違っていてもデプロイ自体は成功してしまい、後で GitHub Actions が
> AssumeRole に失敗して初めて発覚する**（`Not authorized to perform sts:AssumeRoleWithWebIdentity`）。
> 原因が分かりにくいので、先に確認しておくこと。

```bash
cd aws
npx cdk deploy RunningGithubOidc --profile running
```
デプロイ完了後の Outputs に表示されるロール ARN（例:
`arn:aws:iam::<アカウントID>:role/RunningGithubOidc-...`）を控える（チェックリスト #9）。

### E-2. GitHub リポジトリに Variables として登録

1. GitHub の対象リポジトリを開き、「Settings」タブ →
   左メニュー「Secrets and variables」→「Actions」を開く。
2. **「Variables」タブ**（「Secrets」タブではない点に注意）を選択し、
   「New repository variable」をクリック。
3. 「Name」に `AWS_DEPLOY_ROLE_ARN`、「Value」に E-1 で控えた ARN を入力して保存する。

> ARN 自体は秘密情報ではないので Secrets ではなく Variables でよい。IAM ロール側の
> 信頼ポリシー（trust policy）で GitHub の OIDC トークンの発行元・ブランチを条件指定して
> いるため、ARN の値そのものが漏れても、その信頼ポリシーの条件を満たさない第三者は
> このロールを引き受けられない。

### E-3. 動作確認

1. リポジトリの「Actions」タブを開く。
2. 左メニューから `Deploy AWS (CDK)` ワークフローを選択し、「Run workflow」で手動実行する。
3. 実行ログが緑（成功）で完走すれば、OIDC 経由の認証と `RunningData` / `RunningApp` の
   デプロイが疎通している。失敗する場合はログの `Configure AWS credentials (OIDC)` の
   ステップでエラーが出ていないか確認する（ロール ARN の入力ミス、信頼ポリシーの
   条件不一致などが典型的な原因）。

---

## F. ロリポップへの設定ファイル配置（Phase 1・所要目安 10分）

### F-1. `config.php` の作成

1. リポジトリの `api/running/config.php.example` をコピーして
   同じディレクトリに `api/running/config.php` を作る。
2. 中身を編集し、以下を書き込む。
   - `api_base` → D-1 で控えた `HttpApiUrl`
   - `shared_secret` → C-1/C-2 で登録した `proxy-shared-secret` の値
   （具体的なキー名・書式は `api/running/config.php.example` のコメントに従うこと。
   既存の `api/lol/config.php.example` と同様、PHP の連想配列を `return` する形式になっている
   想定。）

### F-2. FTP で本番へアップロード

`config.php` は Git にコミットされず、`.github/workflows/deploy.yml` の FTP ミラーからも
`--exclude-glob 'api/running/config.php'` で明示的に除外されている。つまり
**この配置作業は自動化されておらず、必ず人手でアップロードする必要がある。**

1. Cyberduck などの FTP クライアントでロリポップのサーバーに接続する
   （接続情報は既存の `config.php` / `discord_config.php` を配置したときと同じもの）。
2. `api/running/config.php` を本番の対応ディレクトリへアップロードする。

> **警告: この手順を飛ばすと本番で必ずエラーになる。** `deploy.yml` の自動デプロイは
> `config.php` を意図的に対象外にしているため、既存の `config.php` / `discord_config.php`
> と同じ運用（＝手動アップロードが唯一の反映経路）であることを忘れないこと。

### F-3. 動作確認（アクセス制限）

ブラウザで `https://<本番ドメイン>/api/running/config.php` を直接開く。

**403 Forbidden が返ってくれば正常。** ルート `.htaccess` の
`<Files "config.php">deny from all</Files>` 相当の設定が効いており、設定ファイルへの
直接アクセスがブロックされていることの確認になる。200 が返る、あるいは PHP のコードが
そのまま表示される場合は設定漏れなので、`.htaccess` の適用範囲を見直す。

### F-4. Discord ログイン連携の前提

ランニング機能は Discord ID をユーザーの鍵として使っている。サイトにまだ一度も
Discord でログインしたことがないアカウントで動作確認する場合は、先に
「Discordでログイン」を1回通して `discord_users` テーブルに紐付けを作っておく必要がある
（このテーブルは既存の `api/auth/discord_callback.php` が作成・維持している）。
未連携のまま `X-Arena-Discord-Id` 相当のヘッダーを送っても 401 になる想定なので、
先にログインを済ませてから機能確認を行うこと。

---

## G. Discord ロールの準備（Phase 3・所要目安 15分）

### G-1. ロールの作成

1. サーバー設定（サーバー名を右クリック →「サーバー設定」）→ 左メニュー「ロール」を開く。
2. 「ロールを作成」で、達成基準に対応するロールを作る。例:
   - 「30km達成」
   - 「50km達成」
   - 「100km達成」
   - 「今月のトップランナー」
   （名前・段階は運用に合わせて自由に決めてよい。以降の手順は名前を問わない。）

### G-2. ロール階層の並び替え

> **【最重要・最も引っかかりやすい箇所】**
> **Bot のロールを、ロール一覧の中で管理対象ロール（G-1 で作ったもの）より
> 上へドラッグして配置すること。**
>
> これを忘れると、Bot がロールを付与しようとした際に **`403 Missing Permissions`** に
> なる。Discord のロール階層は「そのロールを操作できるか」を決める制約であり、
> 個々の権限（Permissions）とは完全に独立している。**Bot に `Administrator` 権限を
> 与えても、ロール階層が下にある限りこの制約は回避できない。** 何を試しても直らない
> `403` に遭遇したら、まずここを疑うこと。

1. サーバー設定 →「ロール」の一覧で、Bot のロール（アプリ作成時に自動生成される。
   通常はアプリ名と同じ名前）を見つける。
2. ドラッグして、G-1 で作った達成ロールすべてより**上**（リストの上のほうが権限上位）に
   移動する。
3. 保存は自動（ドラッグした時点で反映される想定。反映されない場合は明示的な
   「変更を保存」ボタンを探す）。

### G-3. 告知チャンネル ID の確認

1. 告知に使うチャンネルを右クリック →「チャンネルIDをコピー」。
2. この ID は次の G-4 でコマンドから選択する形でも設定できるため、手控えは必須ではない
   （チェックリスト #10 は参考用）。

### G-4. Discord 上でコマンドを実行して設定を投入

サーバー内で Bot に対し、以下のスラッシュコマンドを順に実行する
（実際のコマンド名・引数はボット実装に依存するが、想定は以下の通り）。

```
/run-admin threshold-set km:30 role:@30km達成
/run-admin threshold-set km:50 role:@50km達成
/run-admin threshold-set km:100 role:@100km達成
/run-admin top-role-set role:@今月のトップランナー
/run-admin channel-set channel:#お知らせ
```

**ロール ID や チャンネル ID を手で控えて入力する必要はない。** コマンドの
ロール選択・チャンネル選択オプション（Discord のスラッシュコマンド UI）から
候補一覧を選ぶだけでよい。

---

## H. S3 CORS の本番ドメイン設定（Phase 4・所要目安 5分）

1. リポジトリの `aws/cdk.json` のコンテキスト `siteOrigin` を、既定値
   `http://localhost:5173` から本番ドメイン（例: `https://example.com`）に変更する。
2. 変更後、`cdk deploy`（GitHub Actions 経由、または手動で `npx cdk deploy RunningApp
   --profile running`）を実行して反映する。S3 バケットの CORS 設定に反映され、
   本番ドメインからの直接アクセス（署名付き URL 経由のアップロード等）が許可される。

**ローカル開発で一時的に試したい場合**は、`siteOrigin` を配列にできるなら
`http://localhost:5173` を残したまま本番ドメインを追加する（CDK 側の実装が単一文字列
前提の場合は、開発時だけ一時的に `localhost:5173` に戻して `cdk deploy` し、
確認が終わったら本番ドメインに戻して再度 `cdk deploy` する）。恒常的にローカルの
オリジンを許可し続けると、第三者のローカル環境からのアクセスを技術的に区別できなく
なるため、開発が終わったら必ず本番ドメインのみに戻すこと。

---

## I. トラブルシューティング（全フェーズ共通）

### CloudWatch Logs でログを見る

- コンソール: CloudWatch → 左メニュー「ロググループ」→ `/aws/lambda/<関数名>` →
  最新のログストリームを開く。
- CLI（Git Bash 推奨）:
  ```bash
  aws logs tail /aws/lambda/<関数名> --follow --profile running
  ```

### DynamoDB のアイテムを直接確認する

- コンソール: DynamoDB → 左メニュー「テーブル」→ `running` を選択 →
  「項目を探索」（Explore items）でフィルタしながら確認する。
- CLI:
  ```bash
  aws dynamodb get-item --table-name running \
    --key '{"pk":{"S":"U#<discordId>"},"sk":{"S":"AGG#M#2026-09"}}' \
    --profile running
  ```
  `<discordId>` と年月部分は確認したい対象に置き換える。

### Lambda を手動実行する

- CLI:
  ```bash
  aws lambda invoke --function-name <関数名> \
    --payload '{"job":"monthly-rollover"}' out.json --profile running
  cat out.json
  ```
- コンソール: Lambda → 対象関数 →「テスト」タブ →「新しいイベントを作成」で
  同じ JSON（例: `{"job":"monthly-rollover"}`）を貼り付けて「テスト」を実行する。

### スラッシュコマンドが Discord に出てこない

以下の順で確認する。

1. `npm run register`（コマンド登録スクリプト）が正常終了したか、エラーが出ていないか。
2. **ギルドコマンドとして登録されているか。** グローバルコマンドとして登録した場合、
   Discord 側への反映に最大1時間かかることがある。ギルド限定登録（Guild ID を指定した
   登録）ならほぼ即時反映されるはずなので、急ぐ場合はギルド登録になっているか確認する。
3. Discord クライアントを `Ctrl+R` で再読み込みする（クライアント側のコマンドキャッシュが
   古いままのことがある）。
4. Bot が対象のサーバーに実際に参加しているか（B-4 の招待がうまくいっているか）を
   メンバー一覧で確認する。

### ロール付与が 403 Missing Permissions になる

**まず G-2 のロール階層を疑うこと。** 権限（Permissions）の設定ミスではなく、
Bot のロールが管理対象ロールより下に配置されていることが原因であるケースが大半。

### 一度作った環境を消したいとき

```bash
cd aws
npx cdk destroy RunningApp --profile running
```

`RunningData`（DynamoDB テーブル・S3 バケットを含むスタック）は
`RemovalPolicy.RETAIN` が設定されているため、`RunningApp` を `cdk destroy` しても
テーブルとバケットは削除されず残る。これは意図的な設計（誤操作でデータが消えるのを
防ぐため）で、本当にデータごと削除したい場合は DynamoDB / S3 のコンソールから
個別に手動削除する必要がある。
