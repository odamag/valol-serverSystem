# 11. VPS の構成と運用

[10_architecture.md](10_architecture.md) の続き。VPS の上で何をどう動かし、どうデプロイし、どう守るか。
方針は「**手でやることを減らす。困ったらすぐ前の状態に戻せる**」。

---

<a id="vps"></a>
## 1. サーバー

| 項目 | 決定 | 理由 |
|---|---|---|
| OS | **Ubuntu 24.04 LTS** | 2029 年まで更新が出る。GitHub Actions の `ubuntu-24.04` と同じ glibc なので、CI でビルドしたバイナリがそのまま動く |
| 大きさ | 1 vCPU・メモリ 1〜2 GB・SSD 20 GB 以上、国内リージョン | Rust のプロセスは数十 MB。ビルドは CI でするので、VPS でコンパイルしない |
| リバースプロキシ | **Caddy**（公式の apt リポジトリから入れる） | TLS 証明書の取得と更新を自動でやってくれる。設定が短い。静的ファイルの配信・SPA のフォールバック・PHP-FPM への中継が 1 つの設定ファイルで書ける |
| プロセス管理 | **systemd** | OS に最初から入っている。再起動・ログ（journald）・サンドボックス・タイマーが全部ある |
| TLS | Caddy の自動 HTTPS（Let's Encrypt） | 何もしなくてよい。HTTP → HTTPS のリダイレクトも自動 |
| コンテナ | **使わない** | バイナリ 1 つと静的ファイルだけなので、Docker を入れると管理するものが増えるだけ |
| ファイアウォール | `ufw` で 22・80・443 だけ開ける | |
| SSH | 鍵だけ（`PasswordAuthentication no`、`PermitRootLogin no`） | |
| OS の更新 | `unattended-upgrades` でセキュリティ更新を自動で入れる | |
| 時刻 | `systemd-timesyncd`（標準で有効） | ランニングの HMAC は時刻のずれが 300 秒を超えると通らないため |

### ユーザーとディレクトリ

| ユーザー | 役割 |
|---|---|
| `serversystem` | Rust のプロセスを動かす。ログインできない（`/usr/sbin/nologin`） |
| `deploy` | GitHub Actions が SSH で入る。`/srv/serversystem` に書き込めて、sudo で使えるのは決まったコマンドだけ |
| `www-data` | PHP-FPM（移行中だけ） |

```
/srv/serversystem/
├─ releases/
│  ├─ 20261201-1530-ab12cd3/       # 1 回のデプロイ = 1 ディレクトリ（日時-コミット）
│  │  ├─ bin/serversystem          # Rust のバイナリ（段階 2 から）
│  │  ├─ dist/                     # フロントのビルド結果
│  │  ├─ games/                    # ゲーム（tests/・dev/・package.json は除く）
│  │  ├─ deploy/caddy/site.caddy   # このリリース用の Caddy の設定
│  │  └─ api/ ・lib/               # PHP（段階 4 で無くなる）
│  └─ ...（直近 5 つを残す）
├─ current -> releases/20261201-1530-ab12cd3
└─ bin/activate                    # リリースを切り替えるスクリプト（リポジトリの deploy/activate.sh を置く）

/var/lib/serversystem/
├─ app.db (+ -wal, -shm)           # Rust の DB。serversystem だけが書ける
└─ php/db-folder/                  # 移行中の PHP の SQLite（段階 4 で消す）

/etc/serversystem/
├─ env                             # Rust のシークレット（root:root 0600）
└─ php/                            # 移行中の PHP の設定ファイル（root:www-data 0640）
   ├─ config.php
   ├─ site_config.php
   ├─ discord_config.php
   ├─ lol_config.php
   ├─ running_config.php
   └─ aws.phar
```

PHP はリポジトリの中の決まった場所（`config.php`・`api/site_config.php` など）から設定を読む。
そのため移行中は、`activate` がリリースの中にシンボリックリンクを張る（例：`releases/<id>/config.php -> /etc/serversystem/php/config.php`、`releases/<id>/db-folder -> /var/lib/serversystem/php/db-folder`）。
PHP のコードは直さずに済む。

PHP のバージョン: Ubuntu 24.04 の標準は PHP 8.3（今は 8.5）。PHP は移行中にしか使わないので、**標準の `php8.3-fpm`・`php8.3-sqlite3`・`php8.3-curl` を使う**。
段階 1 の前に、手元か CI で残す PHP ファイルを 8.3 で `php -l` し、実際に動かして確かめる。
8.5 にしか無い書き方で動かないところがあれば、そのときだけ ondrej/php の PPA で 8.5 を入れる。

---

<a id="caddy"></a>
## 2. Caddy の設定

`/etc/caddy/Caddyfile` は 1 回だけ手で置き、中身はリリースに入っている設定を読み込むだけにする。
こうすると、**Caddy の設定もリリースと一緒に切り替わり、一緒に戻る**。

```caddy
# /etc/caddy/Caddyfile（手で置く。変えない）
import /srv/serversystem/current/deploy/caddy/site.caddy
```

`deploy/caddy/site.caddy`（リポジトリで管理。移行中の形）:

```caddy
example.com {
	encode zstd gzip

	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
		X-Frame-Options "SAMEORIGIN"
		-Server
	}

	# Rust（新しい API）
	handle /api/v1/* {
		reverse_proxy 127.0.0.1:8081
	}

	# PHP（移行中だけ。段階 4 でこのブロックを消す）
	@php_private path /api/*config.php /api/*/lib/* /api/common.php
	handle @php_private {
		respond 404
	}
	handle /api/* {
		root * /srv/serversystem/current
		php_fastcgi unix//run/php/php8.3-fpm.sock
	}

	# ゲーム（静的ファイル）
	handle /games/* {
		root * /srv/serversystem/current
		file_server
	}

	# SPA
	handle {
		root * /srv/serversystem/current/dist
		try_files {path} /index.html
		file_server
	}

	log {
		output stdout
	}
}
```

- ドメイン名は実際の値に置き換える（「まだ決まっていないこと」の DNS の確認と一緒に決める）。
- `db-folder/`・`lib/`・`config.php` はドキュメントルート（`dist/`）の外なので、そもそも配信されない。
- PHP のフロントコントローラ（`api/running/index.php`）は `?path=` で動くので、リライトの設定は要らない。
- `/api/v1/*` は段階 1 では行き先（Rust）がまだ無く、502 になるだけ。フロントはまだ呼ばないので問題ない。
- Caddy は `reverse_proxy` で `X-Forwarded-For` を付ける。Rust は 127.0.0.1 でしか待ち受けないので、**`X-Forwarded-For` の一番右の値**を利用者の IP として信じてよい（合言葉の回数制限で使う）。

---

<a id="systemd"></a>
## 3. systemd

`deploy/systemd/` に置き、構築のときに `/etc/systemd/system/` へ写す。

```ini
# serversystem.service
[Unit]
Description=serverSystem API (Rust)
After=network-online.target
Wants=network-online.target

[Service]
User=serversystem
Group=serversystem
EnvironmentFile=/etc/serversystem/env
ExecStart=/srv/serversystem/current/bin/serversystem serve
Restart=on-failure
RestartSec=3

# サンドボックス
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/var/lib/serversystem
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
LockPersonality=yes

[Install]
WantedBy=multi-user.target
```

```ini
# serversystem-backup.service
[Unit]
Description=serverSystem DB backup

[Service]
Type=oneshot
User=serversystem
EnvironmentFile=/etc/serversystem/env
ExecStart=/srv/serversystem/current/bin/serversystem backup
# 上と同じサンドボックスの設定を入れる
```

```ini
# serversystem-backup.timer
[Timer]
OnCalendar=*-*-* 04:00:00 Asia/Tokyo
RandomizedDelaySec=10m
Persistent=true

[Install]
WantedBy=timers.target
```

- `EnvironmentFile` は systemd（root）が読んでから権限を落とすので、ファイルは `root:root 0600` でよい。`serversystem` ユーザーにはファイルそのものは読めない。
- ログは `journalctl -u serversystem` で見る。journald の保存量は `SystemMaxUse=500M` くらいにしておく。

---

<a id="secrets"></a>
## 4. シークレットの置き方

| 置き場所 | 中身 | 誰が読めるか |
|---|---|---|
| `/etc/serversystem/env` | Rust の設定とシークレットすべて（[10 の §6.5](10_architecture.md#d9)） | root だけ（systemd が渡す） |
| `/etc/serversystem/php/*` | 移行中の PHP の設定ファイル | root と www-data |
| GitHub Secrets | `VPS_HOST`・`VPS_SSH_KEY`（`deploy` ユーザーの秘密鍵）・`VPS_KNOWN_HOSTS`（ホスト鍵を固定する） | GitHub Actions |
| AWS SSM `/running/*` | ランニングの Bot Token・HMAC 共有シークレット（今のまま） | Lambda |

- リポジトリには `server/.env.example`（ダミー値）だけを置く。本物の値はどこにもコミットしない。
- 値を変えたら `sudo systemctl restart serversystem`。
- `env` のひな形と、各値の取り方（Discord の開発者画面のどこを見るか、など）は構築手順書（`deploy/README.md`、P2）に書く。
- ランニングの共有シークレットは、PHP（`api/running/config.php`）と Rust（`RUNNING_SHARED_SECRET`）で同じ値を使う。段階 3 で変える必要はない。

<a id="iam"></a>
### AWS の IAM ユーザー

VPS は AWS の外にあるので、EC2 のインスタンスロールは使えない。IAM Roles Anywhere は証明書局を自分で用意する必要があり、この規模には大げさ。
そこで、**専用の IAM ユーザー `serversystem-vps` を作り、必要な権限だけを付ける**。キーは `/etc/serversystem/env` に置く。

付ける権限（考え方。正確なポリシーの JSON は P7 で作り、`aws ec2 run-instances --dry-run` などで確かめる）:

| 操作 | 範囲 |
|---|---|
| `ec2:DescribeInstances` | すべて（この操作はリソースで絞れない） |
| `ec2:RunInstances` | 3 つの起動テンプレートを使う場合だけ（`ec2:LaunchTemplate` の条件） |
| `ec2:CreateTags` | 起動するときだけ（`ec2:CreateAction = RunInstances` の条件） |
| `ec2:TerminateInstances` | `Name` タグが `minecraft`・`palworld`・`7days` のインスタンスだけ（`ec2:ResourceTag/Name` の条件） |
| `iam:PassRole` | 起動テンプレートにインスタンスプロファイルが付いているときだけ、そのロールに限る |
| `s3:PutObject` | バックアップ用バケットの `app-db/` と `legacy/` の下だけ。**消す・読む権限は付けない**（VPS が乗っ取られても、バックアップを消されないように） |

今の PHP が使っているアクセスキーは、段階 4 で PHP を消したあとに無効にし、消す。

---

<a id="backup"></a>
## 5. バックアップ

| 対象 | 方法 | 頻度・保持 |
|---|---|---|
| `app.db` | `serversystem backup`：`VACUUM INTO` で一貫したコピーを作る → gzip → S3 の `app-db/YYYY/MM/DD.db.gz` に置く | 毎晩 4:00。S3 のライフサイクルで 90 日後に消す |
| 旧 DB（`auth.db`・`arena.db`・`lol_predict.db`・`valorant_predict.db`） | 段階 0 で 1 回だけ S3 の `legacy/` に置く（[12](12_migration_plan.md#legacy)） | 消さない（ライフサイクルの対象外） |
| ランニング（DynamoDB・S3） | AWS 側のまま。今と同じ | — |
| VPS 全体 | 業者のスナップショットが安く使えるなら、週 1 回 | 任意 |

- バックアップ用のバケットは、バージョニングを有効にし、パブリックアクセスを全部ブロックする。
- `backup` が失敗したら、終了コードを 0 以外にする。`systemctl list-timers` と `journalctl -u serversystem-backup` で見られる。失敗の通知は最初は作らない（「まだ決まっていないこと」の死活監視と一緒に考える）。
- **なぜ Rust のサブコマンドにするか**: VPS に `sqlite3` や AWS CLI を入れなくて済む。バイナリと同じ設定（`env`）・同じ認証情報で動き、テストも書ける。
- **戻し方**（手順書に書く）: S3 から落とす → `gunzip` → `systemctl stop serversystem` → `app.db` を置き換える（`-wal`・`-shm` は消す） → `systemctl start serversystem`。
  データはユーザー表とセッションだけなので、最悪 1 日分戻っても困るのは「その日に初めてログインした人がもう 1 回ログインする」くらい。

---

<a id="deploy"></a>
## 6. デプロイ

### 流れ（`main` に push したとき）

```
GitHub Actions (ubuntu-24.04)
 1. フロントをビルド          npm ci && npm run build        → dist/
 2. Rust をビルド              cargo build --release --locked → server/target/release/serversystem
 3. リリースを組み立てる       release/{bin,dist,games,deploy,api,lib}
 4. rsync over SSH             → deploy@VPS:/srv/serversystem/releases/<日時-sha>/
 5. ssh deploy@VPS /srv/serversystem/bin/activate <日時-sha>
```

`activate` がすること（`deploy/activate.sh`）:

1. リリースの中に PHP の設定ファイルへのシンボリックリンクを張る（移行中だけ）。
2. `current` を新しいリリースに向ける（`ln -sfn` で、一瞬で入れ替わる）。
3. `sudo systemctl restart serversystem`（マイグレーションは起動のときに流れる）。
4. `sudo systemctl reload caddy`。
5. `curl -fsS http://127.0.0.1:8081/api/v1/health` を最大 10 秒待つ。
6. 失敗したら `current` を前のリリースに戻し、もう一度 restart・reload して、**失敗で終わる**（Actions が赤くなる）。
7. 古いリリースを消して、直近 5 つだけ残す。

`deploy` ユーザーの sudo は、次の 2 つだけに絞る（`/etc/sudoers.d/deploy`）:

```
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart serversystem, /usr/bin/systemctl reload caddy
```

### 戻し方

- **手で戻す**: `ssh deploy@VPS /srv/serversystem/bin/activate <前のリリースのディレクトリ名>`。`ls /srv/serversystem/releases` で一覧が見られる。
- **Actions から戻す**: `deploy.yml` に `workflow_dispatch` の入力 `release` を作り、それを指定すると、ビルドせずに `activate` だけを流す。
- DB のマイグレーションは戻さない（前に進むだけ）。そのかわり [10 の §6.4](10_architecture.md#schema) の約束（列の削除や名前の変更は、それを使うコードの変更と別のリリースにする）を守り、古いバイナリが新しいスキーマで動くようにしておく。

### 段階ごとの違い

| 段階 | リリースに入るもの |
|---|---|
| 1 | dist・games・api・lib・deploy（Rust はまだ無い。`activate` は Rust の restart と health の確認を飛ばす） |
| 2〜3 | 上に bin を足す |
| 4 以降 | bin・dist・games・deploy（api・lib が無くなる） |

段階 1 より前（ロリポップの間）は、今の FTP の `deploy.yml` をそのまま使う。段階 1 で DNS を切り替えた日に、`deploy.yml` を rsync 版に入れ替える（P3）。

---

<a id="ci"></a>
## 7. CI（プルリクエストのとき）

今の `ci.yml` にジョブを足し、段階が進んだら消す。

| ジョブ | 中身 | いつまで |
|---|---|---|
| フロントのビルド | 今のまま | ずっと |
| ゲームのテスト | 今のまま（`games/_shared`・`games/race`） | ずっと |
| **Rust**（新規） | `cargo fmt --check` → `cargo clippy --all-targets -- -D warnings` → `cargo test --locked`。`Swatinem/rust-cache` でキャッシュ | 段階 2 から |
| PHP の構文チェック | PHP の版を 8.5 → **8.3** に変える（VPS と揃える） | 段階 4 で消す |
| AWS（CDK） | 今のまま。加えて `npm test` を流す（今は型チェックと synth だけ） | ずっと（D1） |

- Rust のテストは外部のサービスを呼ばない（wiremock と trait で置き換える）ので、CI にシークレットは要らない。
- `cdk.yml`（AWS へのデプロイ）は今のまま変えない。
