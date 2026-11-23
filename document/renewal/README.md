# リニューアル用 現状まとめ

ロリポップ（レンタルサーバ）から VPS へ移し、API を Rust で作り直すための下調べ。
**今のサイトに何があって、何で動いているか** を、コードから読み取って書き出したもの。
（2026-11-21 時点の `main` 相当 = ブランチ `claude/php-8-5` の内容で調査）

## ファイル

| ファイル | 中身 |
|---|---|
| [01_current_environment.md](01_current_environment.md) | ホスティング・言語・デプロイ・CI・設定ファイル・外部サービス・AWS |
| [02_features.md](02_features.md) | 機能ごとの棚卸し。**残す／捨てるを決めるためのチェック欄つき** |
| [03_api_endpoints.md](03_api_endpoints.md) | PHP API の全エンドポイント一覧（Rust で作り直すときの範囲） |
| [04_data_stores.md](04_data_stores.md) | SQLite 4ファイル・DynamoDB・S3・ファイル／ブラウザに置いている状態 |
| [05_migration_notes.md](05_migration_notes.md) | 移行で変わること、ロリポップ制約のための回避策、今あるセキュリティ上の穴 |

既存の設計書（機能の詳しい仕様）は `document/` 直下にある:
`arena_design.md` / `running_api.md` / `aws_setup_guide.md` / `gungi_design.md` / `database_design.md`

## ひと目でわかる全体像

```
ブラウザ
 ├─ React SPA (Vite ビルド → dist/)          … 画面はほぼこれ
 ├─ /games/*  素の HTML/JS ゲーム (PeerJS P2P)
 │
 ▼
ロリポップ (Apache + PHP 8.5, .htaccess でルーティング)
 ├─ api/auth      サイト合言葉・OTPログイン・Discordログイン
 ├─ api/server    AWS EC2 ゲームサーバーの起動／停止   ──▶ AWS EC2 (スポット)
 ├─ api/lol       LoL 戦績・試合予想・チャンピオンAI ──▶ Riot API / LoL Esports API / Anthropic API
 ├─ api/valorant  VALORANT 試合予想                  ──▶ PandaScore API
 ├─ api/arena     バンピック & Elo ランキング (REST)
 ├─ api/running   AWS への HMAC 署名つき中継だけ      ──▶ API Gateway + Lambda (ランニング記録)
 └─ db-folder/*.db  SQLite 4ファイル

AWS (CDK で管理, GitHub Actions からデプロイ)
 └─ ランニング記録: Discord Bot (スラッシュコマンド) + Web API + DynamoDB + S3 + 月次バッチ
```

## 規模

| 部分 | 行数（おおよそ） |
|---|---|
| PHP API (`api/`) | 約 5,700 行 / 39 ファイル |
| React SPA (`frontend/src/`) | 約 9,000 行 / 19 ページ |
| ブラウザゲーム (`games/`) | 約 3,800 行 / 4 本 |
| AWS (`aws/src` + `aws/lib`) | 約 4,600 行 (TypeScript) |

## 先に知っておくべきこと（詳しくは 05）

- **ゲームサーバー起動 API (`api/server/*.php`) に認証がかかっていない。** URL に POST すれば誰でも EC2 を起動できる。
  サイト合言葉（SiteGate）は画面に出しているだけで、どの API も `requireSiteAuth()` を呼んでいない。
- ランニング記録だけは既に AWS (TypeScript/Lambda) に出ており、PHP は中継しかしていない。
  Rust 化の対象にするか、AWS のまま残すかは最初に決めたほうがいい。
- 「WebSocket が使えない」「常駐プロセスが置けない」「SSH が無い」というロリポップの制約に合わせた工夫が
  あちこちにある（ポーリング、遅延評価、P2P、最初に叩いた人を管理者にする 等）。VPS ならやめられる。
