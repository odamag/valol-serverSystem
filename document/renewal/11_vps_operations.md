# 11. VPS の構成と運用

[10_architecture.md](10_architecture.md) の続き。VPS の上で何をどう動かし、どうデプロイし、どう守るか。
方針は「**手でやることを減らす。困ったらすぐ前の状態に戻せる**」。

---

<a id="vps"></a>
## 1. サーバー

| 項目 | 決定 | 理由 |
|---|---|---|
| 置き場所 | **AWS Lightsail**、東京リージョン（`ap-northeast-1`）、**512 MB プラン（パブリック IPv4 付き）** | ユーザーの決定。ゲームサーバーの EC2・ランニングと同じ AWS アカウント・同じリージョンにまとまる。IPv6 だけのプランは、GitHub Actions から SSH できない・IPv4 しか持たない利用者が見られないので選ばない |
| IP アドレス | **静的 IP** を作ってインスタンスに付ける | インスタンスを作り直しても（スナップショットから戻しても）IP が変わらないようにするため。付けている間は無料 |
| OS | **Ubuntu 24.04 LTS**（Lightsail の OS イメージ） | 2029 年まで更新が出る。GitHub Actions の `ubuntu-24.04` と同じ glibc なので、CI でビルドしたバイナリがそのまま動く |
| メモリ対策 | **1 GB のスワップファイル**を作る。PHP-FPM は `pm = ondemand`・`pm.max_children = 3` | 512 MB は、Caddy・Rust（数十 MB）・PHP-FPM（移行中だけ）・OS を載せるには足りるが、余裕は小さい。`apt upgrade` の最中などに足りなくならないようにする。ビルドは CI でするので、VPS ではコンパイルしない |
| リバースプロキシ | **Caddy**（公式の apt リポジトリから入れる） | TLS 証明書の取得と更新を自動でやってくれる。設定が短い。静的ファイルの配信・SPA のフォールバック・PHP-FPM への中継が 1 つの設定ファイルで書ける。メモリも軽い |
| プロセス管理 | **systemd** | OS に最初から入っている。再起動・ログ（journald）・サンドボックスが全部ある |
| TLS | Caddy の自動 HTTPS（Let's Encrypt） | 何もしなくてよい。HTTP → HTTPS のリダイレクトも自動。**ドメインが要る**（D21） |
| コンテナ | **使わない** | バイナリ 1 つと静的ファイルだけなので、Docker を入れると管理するものとメモリの消費が増えるだけ |
| ファイアウォール | **Lightsail のネットワーク設定**で 22・80・443 だけ開ける（IPv4・IPv6 とも）。`ufw` は使わない | 開けるポートを 1 か所（Lightsail の画面）で管理するため |
| SSH | 鍵だけ（`PasswordAuthentication no`、`PermitRootLogin no`）。Lightsail の初期ユーザー `ubuntu` は構築にだけ使う | |
| OS の更新 | `unattended-upgrades` でセキュリティ更新を自動で入れる（Ubuntu のイメージで最初から有効） | |
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
{$SITE_DOMAIN} {
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

- ドメインは `{$SITE_DOMAIN}`（環境変数）にして、リポジトリには書かない。値は Caddy の systemd の override（`Environment=SITE_DOMAIN=...`）で渡す。`deploy/setup.sh` がドメインを引数に受け取って書く（T05。D21）。
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
- `env` のひな形と、各値の取り方（Discord の開発者画面のどこを見るか、など）は構築手順書（`deploy/README.md`、T05）に書く。
- ランニングの共有シークレットは、PHP（`api/running/config.php`）と Rust（`RUNNING_SHARED_SECRET`）で同じ値を使う。段階 3 で変える必要はない。

<a id="iam"></a>
### AWS の IAM ユーザー

Lightsail のインスタンスには、EC2 のような IAM ロール（インスタンスプロファイル）を付けられない。IAM Roles Anywhere は証明書局を自分で用意する必要があり、この規模には大げさ。
そこで、**専用の IAM ユーザー `serversystem-vps` を作り、必要な権限だけを付ける**。キーは `/etc/serversystem/env` に置く。

付ける権限（考え方。正確なポリシーの JSON は T15 でメインが作り、`aws ec2 run-instances --dry-run` などで確かめる）:

| 操作 | 範囲 |
|---|---|
| `ec2:DescribeInstances` | すべて（この操作はリソースで絞れない） |
| `ec2:RunInstances` | 3 つの起動テンプレートを使う場合だけ（`ec2:LaunchTemplate` の条件） |
| `ec2:CreateTags` | 起動するときだけ（`ec2:CreateAction = RunInstances` の条件） |
| `ec2:TerminateInstances` | `Name` タグが `minecraft`・`palworld`・`7days` のインスタンスだけ（`ec2:ResourceTag/Name` の条件） |
| `iam:PassRole` | 起動テンプレートにインスタンスプロファイルが付いているときだけ、そのロールに限る |

Lightsail そのものを操作する権限は付けない（スナップショットや再起動は、ユーザーが Lightsail の画面でやる）。
今の PHP が使っているアクセスキーは、段階 4 で PHP を消したあとに無効にし、消す。

---

<a id="backup"></a>
## 5. バックアップ

| 対象 | 方法 | 頻度・保持 |
|---|---|---|
| VPS 全体（`app.db` を含む） | **Lightsail の自動スナップショット** | 毎日（時刻は 4:00 JST ごろに設定）、直近 7 つを Lightsail が残す |
| 切り替えの直前 | **手動スナップショット**（Lightsail の画面で「スナップショットの作成」） | 各段階の切り替えの前に 1 つ。段階が落ち着いたら消す |
| ランニング（DynamoDB・S3） | AWS 側のまま。今と同じ | — |

- **なぜスナップショットだけにするか**: DB に入っているのはユーザー表とセッションだけで、1 日分戻っても困るのは「その日に初めてログインした人が、もう 1 回ログインする」くらい。DB だけを S3 に送る仕組み（バケット・権限・タイマー・復旧の手順）を作るより、Lightsail の設定 1 つで済むほうが手間が少ない。スナップショットにはディスクがまるごと入るので、Caddy や `/etc/serversystem/env` の設定も一緒に戻せる。
- SQLite は WAL モードなので、スナップショットの瞬間の状態から、そのまま正しく開ける（電源が落ちたときと同じ扱いで、コミット済みのデータは失われない）。
- スナップショットは保存した容量の分だけ課金される（ディスク 20 GB の小さな VPS なので少額）。
- **戻し方**（手順書に書く）:
  1. Lightsail の画面で、スナップショットから新しいインスタンスを作る（同じプラン）。
  2. 静的 IP を、古いインスタンスから外して新しいインスタンスに付け替える（DNS は変えなくてよい）。
  3. 動作を確かめたら、古いインスタンスを消す。
- DB だけを戻したいとき: スナップショットから一時的なインスタンスを作り、`app.db` を `scp` で取り出して入れ替える（`systemctl stop serversystem` → 置き換え → `-wal`・`-shm` を消す → `start`）。

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

段階 1 より前（ロリポップの間）は、今の FTP の `deploy.yml` をそのまま使う。段階 1 で新しいドメインに移る日に、`deploy.yml` を rsync 版に入れ替える（T06）。

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
