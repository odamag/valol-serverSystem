// JST（日本標準時、UTC+9固定）の日付・月キー・週キーを計算するユーティリティ。
//
// なぜ Intl.DateTimeFormat や tz データベース（"Asia/Tokyo"）を使わないのか:
// Lambda の実行環境（Node ランタイム）に同梱される ICU データが将来のランタイム更新で
// 変わったり、コンテナイメージによって tz データベースの有無・バージョンが揺れたりすると、
// 日付計算の挙動が環境ごとに変わってしまうおそれがある。JST は夏時間が存在せず
// 常に UTC+9 固定なので、Intl や tz データベースに頼らず「UTC からの +9時間オフセット」を
// 単純な数値計算するだけで正確かつ環境非依存に求められる。

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 現在時刻（エポックミリ秒）から JST の "YYYY-MM-DD" を返す。
 * @param now エポックミリ秒。省略時は Date.now()
 */
export function todayJst(now: number = Date.now()): string {
  const d = new Date(now + JST_OFFSET_MS);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * "YYYY-MM-DD" から "YYYY-MM" を取り出す。
 * 入力は既に JST の日付文字列である前提（先頭7文字を切り出すだけ）。
 */
export function monthKey(d: string): string {
  return d.slice(0, 7);
}

/**
 * "YYYY-MM-DD" から ISO 8601 の週番号（月曜始まり）"YYYY-Www" を計算する。
 *
 * 入力の d は既に JST 換算済みの日付文字列なので、ここでも UTC 上の日付計算だけで
 * 完結させる（タイムゾーン変換は不要。d を「そのままの暦日」として扱うだけでよい）。
 *
 * ISO 週の定義: その週の木曜日が属する年が、その週の年（isoYear）になる。
 * 第1週は 1/4 を含む週。この性質を使うと Intl 抜きで年またぎの週番号を正しく求められる。
 */
export function weekKey(d: string): string {
  const [y, m, day] = d.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, day));

  // getUTCDay() は日曜=0, 月曜=1, ... 土曜=6。月曜始まりの 0-6 (月=0, 日=6) に変換する。
  const dayNum = (date.getUTCDay() + 6) % 7;
  // その週の木曜日に移動する（Date の setUTCDate は月またぎ・年またぎを自動で正しく繰り上げる）。
  date.setUTCDate(date.getUTCDate() - dayNum + 3);

  const isoYear = date.getUTCFullYear();

  // isoYear の第1週の木曜日（= isoYear の 1/4 を含む週の木曜日）を求める。
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);

  const weekNum = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * DAY_MS));

  return `${isoYear}-W${String(weekNum).padStart(2, '0')}`;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * "YYYY-MM-DD" が形式として正しく、かつ実在する日付かどうかを検証する
 * （"2026-02-30" のような存在しない日付を弾く）。
 *
 * 未来日は JST の「明日」まで許容する。ランナーが深夜に走り終えて記録するときに、
 * クライアント側の時計や通信の遅延で JST の日付境界をわずかに超えてしまうケースの
 * 救済措置（それ以上未来の日付は誤入力とみなして拒否する）。
 */
export function isValidRunDate(d: string): boolean {
  const m = DATE_RE.exec(d);
  if (!m) return false;

  const y = Number(m[1]);
  const mo = Number(m[2]);
  const day = Number(m[3]);

  const date = new Date(Date.UTC(y, mo - 1, day));
  // Date は月末を超えた日（例: 2/30）を自動的に翌月へ繰り上げてしまうため、
  // 繰り上げ後の年月日が入力と一致するかどうかで実在性を検証する。
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== mo - 1 ||
    date.getUTCDate() !== day
  ) {
    return false;
  }

  const tomorrow = todayJst(Date.now() + DAY_MS);
  if (d > tomorrow) {
    return false;
  }

  return true;
}
