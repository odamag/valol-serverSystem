# VPS 構築手順書

Lightsail（Ubuntu 24.04・東京・512 MB・静的 IP 付き）に、サイトを動かす環境を作る手順。
設計は [document/renewal/11_vps_operations.md](../document/renewal/11_vps_operations.md)、段階 1 の流れは [12_migration_plan.md](../document/renewal/12_migration_plan.md#stage1) を見る。

前提（T04 で済んでいる）: Lightsail のインスタンスができていて、静的 IP が付いている。ドメインの A レコード（と AAAA）が静的 IP を向いている。Lightsail のネットワーク設定で 22・80・443 が開いている。

| 置くもの | 中身 |
|---|---|
| `setup.sh` | 構築スクリプト（1 回流す。流し直してもよい） |
| `activate.sh` | リリースの切り替えスクリプト（`setup.sh` が `/srv/serversystem/bin/activate` に置く） |
| `caddy/site.caddy` | Caddy の設定（リリースに入る） |
| `systemd/serversystem.service` | Rust のサービス |
| `sudoers/deploy` | deploy ユーザーに許す sudo |
| `php/pool-override.conf` | PHP-FPM のプール設定 |
| `env.example` | `/etc/serversystem/env` のひな形 |

## 1. SSH で入る

Lightsail の画面でインスタンスの「SSH キーをダウンロード」（アカウントの既定のキー `.pem`）を取り、手元から入る。

```bash
chmod 600 LightsailDefaultKey-ap-northeast-1.pem
ssh -i LightsailDefaultKey-ap-northeast-1.pem ubuntu@<静的 IP>
```

## 2. setup.sh を流す

手元で、リポジトリの `deploy/` をまるごと VPS に送り、`ubuntu` ユーザーから sudo で流す。**ドメインは引数で渡す**（リポジトリには書かない）。

```bash
# 手元（リポジトリのルートで）
scp -i <pem> -r deploy ubuntu@<静的 IP>:/tmp/deploy

# VPS 上
sudo bash /tmp/deploy/setup.sh <ドメイン>     # 例: sudo bash /tmp/deploy/setup.sh example.com
```

やること: 1 GB のスワップ、Caddy（公式 apt）、PHP 8.3-fpm（sqlite3・curl）、ユーザー `serversystem`（ログイン不可）と `deploy`、ディレクトリと権限、SSH を鍵だけ・root 不可にする設定、`/etc/sudoers.d/deploy`、Caddyfile（import の 1 行）と `SITE_DOMAIN` の override、PHP-FPM のプール（`ondemand`・最大 3）、`serversystem.service`、journald の上限 500 MB。

- 何度流しても同じ結果になる。途中で失敗したら、直して流し直す。
- SSH の設定を変えるので、**流す前に今の SSH 接続（`ubuntu`）を閉じない**。別の画面から入れることを確かめてから閉じる。
- `bin/serversystem` が無い間は `serversystem` を enable しない。段階 2 で Rust を載せたら、もう 1 回流し直す（enable される）。

## 3. deploy ユーザーの公開鍵を置く

GitHub Actions が使う専用の鍵を、手元で作る（パスフレーズなし）。

```bash
ssh-keygen -t ed25519 -N "" -C "serversystem-deploy" -f ./serversystem_deploy
```

公開鍵（`serversystem_deploy.pub`）を VPS の deploy に登録する。

```bash
# VPS 上（ubuntu）
echo '<serversystem_deploy.pub の中身 1 行>' | sudo tee -a /home/deploy/.ssh/authorized_keys
```

手元から `ssh -i ./serversystem_deploy deploy@<静的 IP>` で入れることを確かめる。

## 4. /etc/serversystem/env（Rust の設定）

ひな形は [`env.example`](env.example)。**値は自分で入れる**（本物をリポジトリに入れない）。段階 1 の間は Rust が動かないので、段階 2 の前までに入れればよい。

```bash
sudo cp /tmp/deploy/env.example /etc/serversystem/env
sudo chown root:root /etc/serversystem/env && sudo chmod 600 /etc/serversystem/env
sudo nano /etc/serversystem/env
```

| 変数 | どこで取るか |
|---|---|
| `APP_PUBLIC_ORIGIN` | 新しいサイトの URL（`https://<ドメイン>`）。末尾に `/` を付けない |
| `APP_SITE_GATE_ENABLED` | 段階 2〜3 の途中までは `false` |
| `SITE_PASSWORD_HASH` | 今の `site_config.php` の bcrypt ハッシュ（`$2y$...`）と同じ値 |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | Discord Developer Portal → アプリ → OAuth2（Client Secret は「Reset Secret」で表示）。今の `discord_config.php` と同じ値 |
| `DISCORD_REDIRECT_URI` | `https://<ドメイン>/api/v1/auth/discord/callback`。同じものを Developer Portal の OAuth2 → Redirects にも足す |
| `DISCORD_GUILD_ID` | Discord のユーザー設定で「開発者モード」を ON → サーバー名を右クリック → 「サーバー ID をコピー」 |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | IAM ユーザー `serversystem-vps` のアクセスキー（IAM → ユーザー → セキュリティ認証情報 → アクセスキーを作成。権限は 11 の §4 の IAM の節） |
| `AWS_REGION` | `ap-northeast-1` |
| `EC2_LT_MINECRAFT` | EC2 → 起動テンプレート → Minecraft のテンプレート ID（`lt-...`） |
| `RIOT_API_KEY` | Riot Developer Portal → 自分のアプリのキー（今の `lol_config.php` と同じ） |
| `LOL_MEMBERS` | 戦績を出すメンバー。`名前#タグ` をカンマ区切り |
| `RUNNING_API_BASE` | ランニングの API Gateway の URL。CDK のデプロイ出力、または AWS コンソールの API Gateway → ステージの「URL を呼び出す」 |
| `RUNNING_SHARED_SECRET` | AWS SSM パラメータストアの `/running/proxy-shared-secret` と同じ値（今の `api/running/config.php` にも同じ値がある） |

値を変えたら `sudo systemctl restart serversystem`。

## 5. /etc/serversystem/php/*（移行中の PHP の設定）

PHP が読む設定ファイルを置く。中身は、今のロリポップに置いてある同名のファイルをもとに、**新しいドメインに直したもの**にする。

| 置くファイル | ロリポップ上の元 | 直すところ |
|---|---|---|
| `config.php` | `/config.php` | 必要なら（DB のパスなど）。DB は `db-folder` の中にある |
| `site_config.php` | `/api/site_config.php` | なし |
| `discord_config.php` | `/api/auth/discord_config.php` | `redirect_uri` を `https://<ドメイン>/api/auth/discord_callback.php` に。Developer Portal の Redirects にも**足す**（古いものは消さない） |
| `lol_config.php` | `/api/lol/config.php` | なし |
| `running_config.php` | `/api/running/config.php` | なし |
| `aws.phar` | `/lib/aws.phar` | なし |

```bash
# 手元から VPS の /tmp へ送り、ubuntu で所定の場所へ
scp -i <pem> config.php site_config.php discord_config.php lol_config.php running_config.php aws.phar ubuntu@<静的 IP>:/tmp/
# VPS 上
cd /tmp
sudo install -m 0640 -o root -g www-data config.php site_config.php discord_config.php lol_config.php running_config.php aws.phar /etc/serversystem/php/
rm -f config.php site_config.php discord_config.php lol_config.php running_config.php aws.phar
```

`activate` が、リリースの中のそれぞれの場所に、ここへのシンボリックリンクを張る。PHP のコードは直さない。

## 6. auth.db の置き方

ロリポップの `auth.db`（`db-folder/` の中）を FTP で落として、VPS に置く。**切り替えの日**（12 の段階 1 の 6）に、本番の最新のものでもう一度やる。

```bash
scp -i <pem> auth.db ubuntu@<静的 IP>:/tmp/auth.db
# VPS 上
sudo install -m 0640 -o www-data -g www-data /tmp/auth.db /var/lib/serversystem/php/db-folder/auth.db
rm -f /tmp/auth.db
```

`arena.db`・`lol_predict.db`・`valorant_predict.db` は写さない（D18）。

## 7. GitHub の Secrets

リポジトリの Settings → Secrets and variables → Actions → New repository secret で 3 つ作る。

| 名前 | 値の作り方 |
|---|---|
| `VPS_HOST` | 静的 IP（またはドメイン） |
| `VPS_SSH_KEY` | 手順 3 で作った**秘密鍵**（`serversystem_deploy`）の中身を、`-----BEGIN` から `END-----` まで全部 |
| `VPS_KNOWN_HOSTS` | ホスト鍵を固定する。手元で `ssh-keyscan -t ed25519 <静的 IP>` を流した出力の 1 行（流したときの回線が信用できる所で。心配なら VPS 上で `cat /etc/ssh/ssh_host_ed25519_key.pub` を見て、`<静的 IP> ssh-ed25519 AAAA...` の形に自分で組む） |

作ったあと、手元の秘密鍵ファイルは消す（`shred -u serversystem_deploy` か、パスワード管理ツールに入れて削除）。

## 8. 動作確認

最初のデプロイ（`main` を push、または T06 の `deploy.yml` を手動実行）のあとで確かめる。デプロイ前に手で試すときは、リリースを `rsync` で `releases/<名前>/` に置いて `activate` を流す（手順 9）。

```bash
# VPS 上
systemctl is-active caddy php8.3-fpm        # どちらも active
ls -l /srv/serversystem/current             # releases/<最新> を指している
sudo ss -ltnp | grep -E ':(80|443) '        # caddy が待ち受けている
free -m                                     # Swap が 1023 くらいあること
journalctl -u caddy --no-pager -n 30        # 証明書の取得が通ったか
```

手元から:

```bash
curl -I https://<ドメイン>/                 # 200（SPA）、証明書エラーが出ない
curl -I https://<ドメイン>/api/config.php   # 404（秘密のファイルは出ない）
curl -I http://<ドメイン>/                  # https へリダイレクト
```

ブラウザで、合言葉・ログイン・Minecraft・LoL・ランニング・ゲームを確かめる（12 の段階 1 の 5）。
段階 2 以降は、加えて `curl -fsS http://127.0.0.1:8081/api/v1/health`（VPS 上）が通ること、`journalctl -u serversystem -n 50` にエラーが無いことを見る。

証明書が取れないときは、DNS が静的 IP を向いているか（`dig +short <ドメイン>`）、80 と 443 が Lightsail のネットワーク設定で開いているかを見る。

## 9. activate での戻し方

リリースは `/srv/serversystem/releases/` に直近 5 つ残る。前のリリースへ戻すには、deploy で（または `ubuntu` から `sudo -u deploy`）次を流す。

```bash
ls /srv/serversystem/releases                          # 一覧（名前は 日時-コミット）
ssh deploy@<静的 IP> /srv/serversystem/bin/activate <前のリリースのディレクトリ名>
```

`activate` は、`current` の切り替え → Rust の restart（`bin/serversystem` があるときだけ）→ Caddy の reload → health の確認（Rust があるときだけ）をする。失敗したら自動で前のリリースに戻して、失敗で終わる。
GitHub Actions からは、`deploy.yml` の `workflow_dispatch` の入力 `release` に名前を入れる（T06）。
DB のマイグレーションは戻らない（前に進むだけ）。

`activate.sh` を直したときは、`setup.sh` を流し直す（`/srv/serversystem/bin/activate` を置き換える）。

## 10. スナップショットからの戻し方

VPS ごと壊れたとき、または切り替えに失敗してやり直したいとき。切り替えの前には、Lightsail の画面で手動スナップショットを 1 つ撮っておく（自動スナップショットは毎日 4:00 JST ごろ、直近 7 つ）。

1. Lightsail の画面で、スナップショットから新しいインスタンスを作る（同じプラン・同じリージョン）。
2. 静的 IP を、古いインスタンスから外して、新しいインスタンスに付け替える（DNS は変えなくてよい）。
3. 動作を確かめる（手順 8）。うまくいったら、古いインスタンスを消す。

`app.db` だけを戻したいとき: スナップショットから一時的なインスタンスを作り、`app.db` を `scp` で取り出す。本番で `sudo systemctl stop serversystem` → `app.db` を置き換える → `app.db-wal`・`app.db-shm` を消す → `sudo systemctl start serversystem`。確かめたら一時インスタンスを消す。

## PHP-FPM の設定が効かないとき

`setup.sh` が「`pm.max_children` が 3 になっていません」と警告したら、`/etc/php/8.3/fpm/pool.d/zz-override.conf` が読まれていない。`php-fpm8.3 -tt 2>&1 | grep -E 'pm|include'` で確かめ、`/etc/php/8.3/fpm/pool.d/www.conf` の `pm`・`pm.max_children` を直接 `ondemand`・`3` に書き換えて `sudo systemctl restart php8.3-fpm` する。
