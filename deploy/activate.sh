#!/usr/bin/env bash
# リリースを切り替えるスクリプト（/srv/serversystem/bin/activate として置く）。
# 使い方: /srv/serversystem/bin/activate <リリースのディレクトリ名>
# deploy ユーザーで流す。失敗したら前のリリースに戻して、失敗（終了コード 1）で終わる。
set -euo pipefail

ROOT=/srv/serversystem
KEEP=5
HEALTH_URL=http://127.0.0.1:8081/api/v1/health

if [ $# -ne 1 ]; then
  echo "使い方: $0 <リリースのディレクトリ名>（一覧: ls $ROOT/releases）" >&2
  exit 2
fi
ID="$1"
# パスの組み立てに使うので、ディレクトリ名以外（/ や .. など）は受け付けない
if ! [[ "$ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  echo "リリース名が正しくありません: $ID" >&2
  exit 2
fi
REL="$ROOT/releases/$ID"
if [ ! -d "$REL" ]; then
  echo "リリースがありません: $REL" >&2
  exit 2
fi

# 前のリリース（戻す先）。最初のデプロイでは無い
PREV=""
if [ -L "$ROOT/current" ]; then
  PREV="$(readlink -f "$ROOT/current")"
fi

# current を一瞬で入れ替える（一時リンクを作ってから rename するので、途中の状態が見えない）
point_current() {
  ln -sfn "$1" "$ROOT/current.tmp"
  mv -T "$ROOT/current.tmp" "$ROOT/current"
}

# 反映（restart は Rust のバイナリがあるときだけ。段階 1 では PHP と Caddy だけ）
# バイナリの無いリリース（段階 1 のもの）に戻したときは、Rust を止める。止めないと、
# systemd が無いファイルを 3 秒ごとに起動しようとして 203/EXEC を延々と繰り返す。
# 止められなくても切り替えそのものは失敗にしない（sudoers が古い VPS でも戻せるように）。
apply() {
  if [ -x "$ROOT/current/bin/serversystem" ]; then
    sudo systemctl restart serversystem
  else
    sudo -n systemctl stop serversystem \
      || echo "Rust のサービスを止められませんでした（sudoers を確かめてください）" >&2
  fi
  sudo systemctl reload caddy
}

# Rust が起きて応答するまで最大 10 秒待つ
wait_health() {
  local i
  for i in $(seq 1 10); do
    if curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

rollback() {
  echo "失敗しました。前のリリースに戻します: ${PREV:-（なし）}" >&2
  if [ -n "$PREV" ] && [ -d "$PREV" ]; then
    point_current "$PREV"
    apply || echo "戻したあとの反映にも失敗しました。手で確かめてください" >&2
  fi
  exit 1
}

# 1. PHP の設定ファイルへのシンボリックリンク（api/ があるリリースだけ。段階 4 で不要になる）
if [ -d "$REL/api" ]; then
  PHPCONF=/etc/serversystem/php
  ln -sfn "$PHPCONF/config.php"           "$REL/config.php"
  ln -sfn "$PHPCONF/site_config.php"      "$REL/api/site_config.php"
  ln -sfn "$PHPCONF/discord_config.php"   "$REL/api/auth/discord_config.php"
  ln -sfn "$PHPCONF/lol_config.php"       "$REL/api/lol/config.php"
  ln -sfn "$PHPCONF/running_config.php"   "$REL/api/running/config.php"
  ln -sfn "$PHPCONF/aws.phar"             "$REL/lib/aws.phar"
  # リリースに db-folder の実ディレクトリがあると、その中にリンクができてしまうので先に消す
  if [ -d "$REL/db-folder" ] && [ ! -L "$REL/db-folder" ]; then
    rm -rf "$REL/db-folder"
  fi
  ln -sfn /var/lib/serversystem/php/db-folder "$REL/db-folder"
fi

# 2. current を切り替える
point_current "$REL"

# 3〜4. Rust の restart（バイナリがあるときだけ）と Caddy の reload
apply || rollback

# 5〜6. health の確認（Rust があるときだけ）。通らなければ戻して失敗で終わる
if [ -x "$REL/bin/serversystem" ]; then
  wait_health || rollback
fi

# 7. 古いリリースを消して、直近 KEEP 個だけ残す（今のものと戻し先は必ず残す）
cd "$ROOT/releases"
n=0
# 新しい順に並べる。rsync -a は元の更新時刻を引き継ぐので、時刻ではなく名前（日時-コミット）で並べる
while IFS= read -r d; do
  n=$((n + 1))
  [ "$n" -le "$KEEP" ] && continue
  full="$ROOT/releases/$d"
  [ "$full" = "$REL" ] && continue
  [ "$full" = "$PREV" ] && continue
  rm -rf "$full"
done < <(ls -1 | sort -r)

echo "切り替えました: $ID"
