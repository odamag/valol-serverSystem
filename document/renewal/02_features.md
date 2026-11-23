# 02. 機能の棚卸し

「残す／捨てる」を決めるための一覧。**判断** 欄は空けてあるので、`残す` / `捨てる` / `作り直す` / `保留` などを書き込んで使う。
「ログイン」はサイト内ログイン（OTP か Discord）のこと。「合言葉」はサイト全体の入口パスワード（SiteGate）。

## 一覧

| # | 機能 | 画面 | API | 外部依存 | 必要なログイン | 判断 |
|---|---|---|---|---|---|---|
| 1 | サイト合言葉（SiteGate） | 全画面の前 | `api/auth/site_*.php` | なし | — | |
| 2 | OTP ログイン・新規登録 | `/login` `/register` | `api/auth/login.php` `register.php` | api.qrserver.com | — | |
| 3 | Discord ログイン | `/login` | `api/auth/discord_*.php` | Discord OAuth | — | |
| 4 | プロフィール（アカウント削除） | `/profile` | `api/auth/profile.php` | なし | 要 | |
| 5 | ゲームサーバー起動／停止 | `/server` | `api/server/*.php` | AWS EC2 | **なし（穴）** | |
| 6 | ミニゲーム集 | `/games` → `/games/*` | なし | PeerJS, CDN | 不要 | |
| 7 | 情報リンク | `/info` | なし | Notion へのリンク 1 件 | 不要 | |
| 8 | LoL チャンピオン情報 | `/lol` | なし（ブラウザ → Data Dragon） | Data Dragon | 不要 | |
| 9 | LoL チャンピオン AI 質問 | `/lol` のモーダル | `api/lol/champion-bot.php` | Anthropic API | 要 | |
| 10 | LoL 戦績（連勝・ランク） | `/lol-streak` | `api/lol/streak.php` | Riot API | 不要 | |
| 11 | LoL 試合予想 | `/lol-predict` | `api/lol/predict.php` | LoL Esports API | 投票は要 | |
| 12 | VALORANT 試合予想 | `/val-predict` | `api/valorant/predict.php` | PandaScore | 投票・手動登録は要 | |
| 13 | バンピック & ランキング（Arena） | `/arena/*` | `api/arena/` | なし | 要 | |
| 14 | ランニング記録（Web） | `/running/*` | `api/running/` → AWS | AWS | 要（Discord ログイン限定） | |
| 15 | ランニング記録（Discord Bot） | Discord | AWS のみ | Discord, AWS | Discord | |
| 16 | API 疎通確認（デバッグ） | なし | `api/debug/api_check.php` | LoL Esports, PandaScore | 要 | |

---

## 1. サイト合言葉（SiteGate）

- サイトを開くと最初に合言葉を聞く。正しければ PHP セッションに `site_auth=true`、さらに **デバイストークン**（64 桁 hex）を発行して `localStorage` に保存。
- 次回からはトークンで自動通過。30 日使われないトークンは削除。
- **API 側では一切チェックしていない**（`requireSiteAuth()` は定義だけで未使用）。画面の目隠しにしかなっていない。
- ハッシュは `api/site_config.php` の `SITE_PASSWORD_HASH`（bcrypt）。

## 2. OTP ログイン・新規登録

- ID と表示名を入れると TOTP シークレット（Base32 16 文字）を発行。QR を表示して認証アプリに登録させる。
- ログインは ID + 6 桁コード（SHA1 / 30 秒 / 前後 1 窓許容）。TOTP は自前実装。
- セッションは 30 分無操作でタイムアウト（`status.php` を呼んだ時に判定）。
- QR 画像は **外部サービス api.qrserver.com に otpauth URI（＝シークレット）を渡して生成している**。
- `lib/qrlib.php` は中身がプレースホルダで、どこからも使われていない。

## 3. Discord ログイン

- OAuth2（`prompt=none`、state で CSRF 対策、10 分期限）。
- 初回は `users` に `discord_<id>` というユーザーを作り、`discord_users` で紐付ける。表示名は Discord 側に追従して更新。
- ログイン後は `/server` へ戻り、SPA 側が `sessionStorage` に控えた元のページへ移動する。
- ランニング機能は Discord ログインした人しか使えない（Discord ID で記録を引くため）。

## 4. プロフィール

- 表示名の確認とアカウント削除（`DELETE`）。削除しても Arena・予想などの他 DB の行は残る。

## 5. ゲームサーバー起動／停止

- Minecraft / Palworld / 7 Days to Die の 3 種。EC2 起動テンプレートから **スポットインスタンス（one-time, 中断時 terminate）** を起動、停止は terminate。
- `Name` タグで既存インスタンスを探す。`GameStatus` タグが `Online` なら「準備完了」、それ以外は「読み込み中」と表示（タグはサーバー側のスクリプトが書き換える想定）。
- 二重起動防止に `starting_<target>.lock` ファイル（120 秒）。
- 画面は 5 秒ごとに状態をポーリング。
- **API・画面とも認証なし。** 長期の AWS アクセスキーを PHP が持っている。
- サーバー側のセットアップスクリプト（`setup.bash` / `setup_palworld.bash`）はこのリポジトリには入っていない。

## 6. ミニゲーム集

| ゲーム | 内容 | 通信 |
|---|---|---|
| Auto Battle RPG | 眺めるだけのオートバトル RPG | なし |
| Pong (P2P) | 2 人対戦ポン | PeerJS |
| ライン通過ゲーム | 障害物を避けるアクション | なし |
| 軍儀 (Gungi) | 駒を積むボードゲーム。P2P 対戦と CPU 対戦。詳しくは `document/gungi_design.md` | PeerJS |

- サーバー側の処理は一切なし。ホストのブラウザがサーバー役。
- 未マージの MG01 Race（Three.js、最大 8 人）が別ブランチにある。

## 7. 情報リンク

- Notion の「Minecraft サーバー情報」へのリンク 1 件だけ。

## 8. LoL チャンピオン情報

- ブラウザから Data Dragon を直接取得して、チャンピオン一覧・詳細（スキル・ステータス）を表示。サーバー処理なし。

## 9. LoL チャンピオン AI 質問

- チャンピオン詳細から質問すると、そのチャンピオンの情報を文脈に付けて Anthropic API（Claude Haiku 4.5）へ投げる。
- 1 ユーザー 1 時間 20 回まで（`auth.db` の `bot_requests` で数える）。

## 10. LoL 戦績

- `api/lol/config.php` に書いたメンバーの Riot ID → PUUID → ソロ/フレックスのランク、直近ランク戦 20 件から連勝・連敗数と直近試合を出す。
- 結果は一時ディレクトリに 5 分キャッシュ。
- メンバーは設定ファイル直書き。画面から追加はできない。

## 11. LoL 試合予想

- LoL Esports API から ±7 日の試合を同期（LCK / LCP / First Stand / MSI / Worlds のみ、Challengers 等は除外）。
- 試合前にどちらが勝つか投票。結果も API から自動で確定。
- ポイント = `floor(100 × 総投票数 / 正解者数)`。少数派が当てるほど高い。
- リーダーボードあり。同期は `matches` を誰かが開いた時に走る（cron なし）。

## 12. VALORANT 試合予想

- LoL 予想と同じ仕組みで、データ元が PandaScore。
- 自動取得できない試合を **手動で登録・結果確定** できる。ただし権限チェックは「ログインしているか」だけ（誰でも確定できる）。
- `reset_sync` で同期をやり直せる（デバッグ用、ログインしていれば誰でも）。

## 13. バンピック & ランキング（Arena）

詳しくは `document/arena_design.md`。この機能が一番大きい（PHP の約半分）。

- 9 つのゲームタイトルから交互に BAN/PICK して 5 番勝負の組み合わせを決める。
- 先手後手はレート差が小さければルーレット、大きければ低いほうが選ぶ。
- ローカル（1 画面）とオンライン（1 秒ポーリング、304 で差分なし）の 2 モード。ターン制限時間は遅延評価。
- 勝敗は申告 → 相手が承認。48 時間放置で自動承認（遅延評価）。
- Elo をタイトル別・総合・シリーズ別の 3 種で持つ。シーズンと配置期間（表示ランクを抑える）あり。
- ランキング、プレイヤー詳細、対戦成績（head-to-head）、タイトル別統計。
- 所持ゲームの登録。
- 管理画面: ゲームタイトル・ドラフト書式・シーズン・設定・API キー・管理者の管理。
- API キー（Bearer、scope 付き）で外部（Discord Bot など）から読み書き可能。ただし今それを使っている Bot はこのリポジトリにはない。
- 管理者が 0 人のときは、最初に管理 API を叩いたログインユーザーが管理者になる（SSH が無いため）。

## 14. ランニング記録（Web）

詳しくは `document/running_api.md`。

- 記録の追加・編集・削除（距離・時間・日付・コース・天気・心拍・カロリー・メモ・公開/非公開）、写真 1 枚。
- 今月の累計、直近の記録、月間・週間・通算ランキング。
- PHP は **HMAC 署名を付けて AWS API Gateway へ中継するだけ**。パスはホワイトリスト。ロジックはすべて Lambda (TypeScript)。
- 写真は S3 へ署名付き URL で直接アップロード。

## 15. ランニング記録（Discord Bot）

- `/run add|list|delete|web|rank|me` … 記録の追加（写真添付可）・一覧・削除・Web ページへのリンク・ランキング・自分の集計。
- `/run-admin threshold-set|threshold-remove|top-role-set|channel-set|show|recalc` … 累計距離に応じたロール付与、月間 1 位ロール、投稿チャンネルの設定。
- 毎月 1 日 0:05 に月間 1 位ロールを付け替えるバッチ。
- 既定ではチャンネルに公開して投稿。

## 16. API 疎通確認

- LoL Esports と PandaScore に実際に問い合わせて、応答時間と中身の件数を JSON で返すデバッグ用。画面なし。
