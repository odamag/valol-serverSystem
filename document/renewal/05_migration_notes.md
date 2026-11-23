# 05. 移行メモ

## 今あるセキュリティ上の穴（移行を待たずに直す価値あり）

| # | 内容 | 場所 | 影響 |
|---|---|---|---|
| 1 | **ゲームサーバー起動/停止 API に認証が無い** | `api/server/control.php` `status.php` | URL を知っていれば誰でも EC2 スポットを起動・停止できる（課金が発生する） |
| 2 | サイト合言葉が API で効いていない | `requireSiteAuth()` が未使用 | 合言葉は画面を隠しているだけ。API は直接叩ける |
| 3 | OTP シークレット入りの URI を外部の QR 生成サービスに渡している | `frontend/src/pages/Register.jsx` | 第三者が TOTP シークレットを見られる。QR はブラウザ内で作るべき |
| 4 | VALORANT の手動結果確定がログインしていれば誰でもできる | `api/valorant/predict.php` `resolve` | 誰でも結果を決めてポイントを動かせる |
| 5 | AWS の長期アクセスキーを PHP が持っている | `config.php` | 漏れると EC2 を好きに使われる。VPS では IAM ロール相当（最小権限）に寄せたい |
| 6 | Arena の初代管理者が「最初に管理 API を叩いた人」 | `requireArenaAdmin()` | 管理者 0 人の状態になると誰でも乗っ取れる |
| 7 | 状態変更 API に CSRF 対策が無い | 全般（Cookie セッション + JSON） | `SameSite` 属性の設定次第。Rust 化時に明示的に入れる |

## ロリポップの制約のために入れた工夫（VPS なら外せる）

| 工夫 | 理由 | VPS での代わり |
|---|---|---|
| Arena のドラフトを 1 秒ポーリング + 304 | WebSocket 不可 | WebSocket / SSE |
| ターン制限時間・48 時間自動承認を「次に読まれた時に判定」 | cron / 常駐不可 | バックグラウンドタスク（tokio のタイマー）や cron |
| LoL/VAL 予想の同期を「誰かが一覧を開いた時」に実行 | cron 不可 | 定期ジョブ |
| ゲームを PeerJS（公開サーバ）で P2P | 常駐プロセス・WebSocket 不可 | 自前の WebSocket サーバ（ホスト依存・NAT 問題が無くなる）。ただし P2P のままでも動く |
| Arena 管理者の自己登録 | SSH が無い | CLI や初期設定で管理者を作る |
| 設定ファイルを FTP で手置き | SSH が無い | 環境変数 / systemd の EnvironmentFile / シークレット管理 |
| FTP（lftp）でデプロイ | SSH が無い | rsync / ssh、またはコンテナイメージ |
| `?path=` フォールバックのルーティング | `.htaccess` 依存 | Rust 側のルータで普通に処理 |
| SQLite を機能ごとに別ファイル | 特に無し（作った順） | 1 つの DB（SQLite でも PostgreSQL でも）にまとめて外部キーで結ぶ |
| ランニングを AWS に分離 | 常駐（Discord Bot の Webhook 受け）と DB の都合 | VPS で Bot ごと動かせる。**AWS に残すかは要判断** |

## Rust で作り直すときに決めること

1. **ランニング記録をどうするか**
   - (a) AWS のまま残し、Rust は今の PHP と同じ HMAC 中継をする（`document/running_api.md` の署名仕様をそのまま実装）。
   - (b) VPS に持ってくる（DynamoDB → RDB、S3 → ローカル or オブジェクトストレージ、Lambda の TypeScript を Rust に書き直し、Discord Interactions も受ける）。
   - 一番作り込まれていてテストもある部分なので、(a) で先に他を移すのが楽。
2. **ゲームサーバー起動を残すか**（残すなら AWS SDK for Rust で EC2 を叩く。認証必須にする）
3. **ログイン方式を絞るか** — OTP と Discord の 2 本立て。ランニングは Discord 必須。Discord だけにすると OTP・QR・`otp_secret` まわりを丸ごと消せる。
4. **サイト合言葉を残すか** — 残すなら API 側でも効かせる。Discord ログインに一本化するならサーバ参加者チェック（ギルド所属）で代わりにできる。
5. **DB** — SQLite 継続（バックアップが楽、身内規模なら十分）か PostgreSQL か。
6. **フロント** — React SPA はそのまま使える（API の URL と形を変えなければ）。`/api/*.php` という URL を残すか、`/api/v1/...` に揃えるか。
7. **セッション** — PHP セッションは引き継げないので、移行時は全員再ログイン。Cookie セッション（tower-sessions 等）か JWT か。

## 移植時に壊しやすいところ

- **TOTP**: SHA1・6 桁・30 秒・前後 1 窓。既存ユーザーの `otp_secret` をそのまま使うなら同じ計算にすること（`totp-rs` 等で互換）。
- **LoL/VAL のポイント計算**: `floor(100 × 総投票数 / 正解者数)`。整数の切り捨て。
- **Arena の Elo**: 初期 1200、K は対戦数で 40/28/20、3 スコープ、配置期間の表示ランク、シーズン引き継ぎ圧縮。履歴テーブルの UNIQUE で二重反映を防いでいる。自動選択は `sha1(series_id:seq)` を種にした決定的乱択。
  既存データを引き継ぐなら計算式を 1 ビットも変えないこと。PHP の float と Rust の f64 は同じ倍精度なので式の順番を揃えればよい。
- **Arena の 304 ポーリング**（`since=N` と `version`）はフロントの `useSeriesSync.js` が前提にしている。
- **ランニングの HMAC 署名**（a を選ぶ場合）: canonical string の順番・小文字 hex・GET は空ボディの sha256。

## 移行の順番の例

1. 穴 #1〜#4 を今の PHP で塞ぐ（すぐできる）。
2. 残す機能を `02_features.md` の判断欄で決める。
3. VPS を用意し、今の PHP をそのまま載せて動かす（環境だけ先に移す）。
4. Rust で機能ごとに置き換える。リバースプロキシ（Caddy / nginx）でパス単位に PHP と Rust を振り分ければ 1 機能ずつ切り替えられる。
5. 全部置き換わったら PHP を外す。
