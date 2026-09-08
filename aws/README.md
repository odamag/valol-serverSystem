# running/aws — ランニング記録 Discord ボットの AWS 基盤

CDK v2（TypeScript）で構築する AWS 基盤。現時点は **Phase 0（足場のみ）** で、
ハンドラの中身はほぼスタブです。

## スタック構成

- `RunningData` — DynamoDB テーブル（`running`）と写真用 S3 バケット
- `RunningApp` — Lambda 4本（Interactions / Worker / Api / Scheduler）+ API Gateway (HTTP API) + EventBridge Scheduler
- `RunningGithubOidc` — GitHub Actions から OIDC でデプロイするための IAM ロール

## セットアップ

```bash
cd aws
npm install
```

## よく使うコマンド

```bash
npm run build   # tsc --noEmit（型チェックのみ、出力なし）
npm run synth   # cdk synth
npm run deploy  # cdk deploy（要 AWS 認証情報）
```

## デプロイ前に設定するもの

`cdk.json` の `context` に以下のプレースホルダがあります。実際の値に差し替えてください。

- `discordAppId` / `discordPublicKey` / `discordGuildId` — Discord Developer Portal から取得
- `siteOrigin` — フロントエンドの本番オリジン（S3 バケットの CORS 許可オリジン。未確定なら localhost のままで OK）
- `githubRepo` — GitHub Actions OIDC の `sub` 条件に使うリポジトリ名（既定: `odamag/serverSystem`）

**Discord Bot Token は `cdk.json` にも環境変数にも書かないこと。**
Lambda の環境変数は `lambda:GetFunctionConfiguration` 権限だけで平文が読めてしまうため、
Bot Token は SSM Parameter Store（`SecureString`、`/running/` 配下）に手動で登録し、
各 Lambda が実行時に取得する運用にしています（Phase 0 時点では取得処理自体は未実装）。

```bash
aws ssm put-parameter \
  --name /running/discord-bot-token \
  --type SecureString \
  --value "<Bot Token>"
```

## デプロイ後

`RunningApp` スタックの Output `HttpApiUrl` が出力する URL の
`/discord/interactions` を Discord Developer Portal の
**Interactions Endpoint URL** に設定してください。

例: `https://xxxxxxxxxx.execute-api.ap-northeast-1.amazonaws.com/discord/interactions`

## GitHub Actions からのデプロイ（OIDC）

`RunningGithubOidc` スタックの Output `GithubDeployRoleArn` を
GitHub Actions のワークフローで `aws-actions/configure-aws-credentials` の
`role-to-assume` に指定してください（`main` ブランチからの実行のみ引き受け可能）。

## なぜ ts-node ではなく tsx なのか

`typescript` は最新安定版（7.x、ネイティブコンパイラへの移行版）をピン留めしている。
`ts-node` は TypeScript のコンパイラ内部 API に依存しており、TypeScript 7 では
その内部構造が変わったため `cdk synth` 実行時にクラッシュする（`ts-node/dist/configuration.js` で
`fileExists` を読めずに例外）。そのため CDK アプリの実行（`cdk.json` の `app`）には
esbuild ベースで型チェックをせずにトランスパイルだけ行う `tsx` を使っている。
型チェック自体は `npm run build`（`tsc --noEmit`）で別途行う。

## 構成上の注意点（落とし穴）

- **GSI1 はスパースGSI**: `gsi1pk` を持つのは集計アイテムだけ。記録アイテムは `distanceM` を持つが
  `gsi1pk` を持たないため GSI1 には載らない。集計値は `ADD` で加算更新すればソートキーも自動追随する。
- **署名検証は生ボディで行う**: `JSON.parse` → `JSON.stringify` で作り直したボディでは検証が通らない。
- **署名検証失敗時は必ず 401 を返す**: Discord は Endpoint URL 登録時にわざと不正な署名を送って
  401 が返ることを確認するため。
- **Bot Token は Lambda の環境変数に置かない**: 上記の SSM Parameter Store 運用を参照。
- **autocomplete は defer できない**: そのため InteractionsFn だけは DynamoDB の読み取り権限を持つ。

## Phase 1 以降でやること（未着手）

- `src/lib/jst.ts`（JST日付処理）、`src/lib/records.ts`、`src/lib/leaderboard.ts` などのドメインロジック
- スラッシュコマンド登録スクリプト（`npm run register` は現状プレースホルダ）
- Worker / Api / Scheduler の実処理実装
- SSM から Bot Token を取得する処理
