#!/usr/bin/env bash
# VPS（Ubuntu 24.04 の Lightsail）の構築スクリプト。
# 使い方: sudo bash setup.sh <ドメイン>     （ubuntu ユーザーから 1 回流す）
# 何度流しても同じ結果になるように書いてある（途中で失敗したら、直して流し直してよい）。
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "root で流してください: sudo bash $0 <ドメイン>" >&2
  exit 1
fi
if [ $# -ne 1 ]; then
  echo "使い方: sudo bash $0 <ドメイン>（例: example.com）" >&2
  exit 1
fi
DOMAIN="$1"
# ドメインは systemd の設定ファイルに書くので、変な文字が入らないようにする
if ! [[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then
  echo "ドメインの形式が正しくありません: $DOMAIN" >&2
  exit 1
fi

# このスクリプトと同じ場所にある設定ファイルを写す（リポジトリの deploy/ を丸ごと置いた前提）
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for f in activate.sh systemd/serversystem.service sudoers/deploy php/pool-override.conf; do
  [ -f "$SRC/$f" ] || { echo "見つかりません: $SRC/$f（deploy/ を丸ごとコピーしてください）" >&2; exit 1; }
done

export DEBIAN_FRONTEND=noninteractive

echo "== 1. スワップ（1 GB） =="
# 512 MB のメモリでは apt upgrade などの最中に足りなくなることがあるため
if [ ! -f /swapfile ]; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
fi
if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
  swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab

echo "== 2. パッケージ（Caddy・PHP） =="
apt-get update
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gpg rsync
install -d -m 0755 /usr/share/keyrings
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  > /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy php8.3-fpm php8.3-sqlite3 php8.3-curl

echo "== 3. ユーザー =="
# serversystem: Rust を動かす（ログイン不可）。deploy: GitHub Actions が SSH で入る
id serversystem >/dev/null 2>&1 || useradd --system --home-dir /var/lib/serversystem --shell /usr/sbin/nologin serversystem
id deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/bash deploy
# 鍵の置き場（公開鍵は README の手順で人が入れる）
install -d -m 0700 -o deploy -g deploy /home/deploy/.ssh
touch /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys

echo "== 4. ディレクトリ =="
install -d -m 0755 -o deploy -g deploy /srv/serversystem /srv/serversystem/releases /srv/serversystem/bin
# DB は serversystem だけが書ける。PHP 用の下の階層に入れるよう、親は 0755 にする
install -d -m 0755 -o serversystem -g serversystem /var/lib/serversystem
install -d -m 0750 -o www-data -g www-data /var/lib/serversystem/php /var/lib/serversystem/php/db-folder
# env は root だけ。PHP の設定は root と www-data だけ
install -d -m 0755 -o root -g root /etc/serversystem
install -d -m 0750 -o root -g www-data /etc/serversystem/php
if [ ! -f /etc/serversystem/env ]; then
  install -m 0600 -o root -g root /dev/null /etc/serversystem/env
fi
chown root:root /etc/serversystem/env
chmod 0600 /etc/serversystem/env

# activate を所定の場所に置く（デプロイのたびに最新版へ置き換える運用はしない。変えたら setup.sh を流し直す）
install -m 0755 -o deploy -g deploy "$SRC/activate.sh" /srv/serversystem/bin/activate

echo "== 5. SSH（鍵だけ・root 不可） =="
# sshd は先に読んだ設定が勝つので 00- を付ける（cloud-init の 50- より前に読ませる）
cat > /etc/ssh/sshd_config.d/00-serversystem.conf <<'EOF'
PasswordAuthentication no
PermitRootLogin no
EOF
sshd -t
systemctl reload ssh

echo "== 6. sudoers =="
tmp="$(mktemp)"
cp "$SRC/sudoers/deploy" "$tmp"
# 文法が壊れた sudoers を置くと sudo が使えなくなるので、置く前に確かめる
visudo -c -f "$tmp"
install -m 0440 -o root -g root "$tmp" /etc/sudoers.d/deploy
rm -f "$tmp"
visudo -c

echo "== 7. Caddy =="
cat > /etc/caddy/Caddyfile <<'EOF'
# 手で置く。変えない（設定はリリースの中の site.caddy にある）
import /srv/serversystem/current/deploy/caddy/site.caddy
EOF
install -d -m 0755 /etc/systemd/system/caddy.service.d
cat > /etc/systemd/system/caddy.service.d/override.conf <<EOF
[Service]
Environment=SITE_DOMAIN=${DOMAIN}
EOF

echo "== 8. PHP-FPM =="
install -m 0644 "$SRC/php/pool-override.conf" /etc/php/8.3/fpm/pool.d/zz-override.conf
php-fpm8.3 -t
systemctl enable php8.3-fpm
systemctl restart php8.3-fpm
if ! php-fpm8.3 -tt 2>&1 | grep -q 'pm.max_children = 3'; then
  echo "警告: pm.max_children が 3 になっていません。README の「PHP-FPM の設定が効かないとき」を見てください" >&2
fi

echo "== 9. systemd（serversystem.service・journald） =="
install -m 0644 "$SRC/systemd/serversystem.service" /etc/systemd/system/serversystem.service
install -d -m 0755 /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/serversystem.conf <<'EOF'
[Journal]
SystemMaxUse=500M
EOF
systemctl restart systemd-journald
systemctl daemon-reload
# バイナリが無い間（段階 1）は enable しない。あると起動に失敗し続けるため
if [ -x /srv/serversystem/current/bin/serversystem ]; then
  systemctl enable serversystem
else
  echo "bin/serversystem がまだ無いので serversystem は enable しません（段階 2 以降に流し直す）"
fi

# SITE_DOMAIN は Caddy の「プロセスが起動したとき」の環境変数なので、reload では反映されない。
# そのためここで必ず 1 回 restart する。ただしリリースが無い間は import 先が無く起動に失敗するので、
# その間だけ空の Caddyfile で起動し、そのあとで import の 1 行に置き換える
# （deploy ユーザーの sudo は reload しか許さない。最初の activate の reload で本来の設定に切り替わる）。
systemctl enable caddy
if [ ! -f /srv/serversystem/current/deploy/caddy/site.caddy ]; then
  echo "# 最初のデプロイまでの仮の設定" > /etc/caddy/Caddyfile
  systemctl restart caddy
  echo "最初のデプロイがまだなので、Caddy は仮の設定で動かしています"
  cat > /etc/caddy/Caddyfile <<'EOF'
# 手で置く。変えない（設定はリリースの中の site.caddy にある）
import /srv/serversystem/current/deploy/caddy/site.caddy
EOF
else
  systemctl restart caddy
fi

echo "完了しました。次は README の手順 3 以降（env・PHP の設定・deploy の公開鍵）へ。"
