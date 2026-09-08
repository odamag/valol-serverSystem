// GSI1（gsi1pk / distanceM）を使ったランキング取得。
// DynamoDB を直接叩く部分と、並べ替え・除外・閾値計算などの純粋なロジックを分離してあるのは、
// 後者を DynamoDB なしでユニットテストできるようにするため（aws/test/leaderboard.test.ts）。

import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb';
import { monthKey, todayJst, weekKey } from './jst';
import { type AggScope, lbPk } from './keys';

/** document/running_api.md §4 の GET /v1/ranking のエントリ形 */
export interface LeaderboardEntry {
  rank: number;
  discordId: string;
  userName: string;
  distanceKm: number;
  durationS: number;
  runs: number;
}

// GSI1 Query が返す集計アイテムのうち、ランキングに必要な属性だけを見る。
// ProjectionType.ALL なので実際には他の属性（sk, gsi1pk, updatedAt 等）も乗ってくるが、
// このモジュールが使わないので型には含めない。
interface RawAggItem {
  pk: string;
  distanceM?: number;
  durationS?: number;
  runs?: number;
  userName?: string;
}

// keys.ts の userPk(discordId) は "U#<discordId>" を作る。ここではその逆変換だけを行う
// （userPk 自体・aggSk・lbPk は再実装せず keys.ts のものをそのまま使う）。
function discordIdFromPk(pk: string): string {
  return pk.startsWith('U#') ? pk.slice(2) : pk;
}

/**
 * GSI1 の降順 Query 結果（複数ユーザーの集計アイテム）から、同じ distanceM の中だけを
 * 「runs が少ないほう（＝1回あたりの距離が長いほう）が上位」という規則で並べ替える。
 *
 * distanceM を主キー（降順）・runs を副キー（昇順）にした安定ソートを配列全体に掛けている。
 * これは一見「GSI の降順結果をコード側で並べ替えない」という方針に反するように見えるが、
 * 入力は既に distanceM 降順（DynamoDB 側でソート済み）なので、同じ基準で安定ソートしても
 * 異なる distanceM 同士の相対順序は変化しない。つまり実質的には「同じ distanceM のグループ内だけ」
 * 並べ替えているのと同じ結果になる。DynamoDB は同じソートキー値を持つ複数アイテム間の順序を
 * 保証しないため、この並べ替えをしないと tie-break が不定になってしまう。
 */
export function applyTieBreak<T extends { distanceM: number; runs: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => (b.distanceM !== a.distanceM ? b.distanceM - a.distanceM : a.runs - b.runs));
}

/**
 * GSI1 Query の生の結果からランキングエントリ配列を組み立てる純粋関数。
 * - runs === 0 の項目（記録を全削除した後に残る残骸。distanceM も 0 のまま）を除外する
 * - applyTieBreak で同距離の tie-break を適用する
 * - 1位から順に rank を振る
 * DynamoDB を一切呼ばないので、そのままユニットテストできる。
 */
export function buildLeaderboardEntries(items: RawAggItem[]): LeaderboardEntry[] {
  const alive = items.filter((i) => (i.runs ?? 0) > 0);

  const sorted = applyTieBreak(
    alive.map((i) => ({
      discordId: discordIdFromPk(i.pk),
      userName: i.userName ?? i.pk,
      distanceM: i.distanceM ?? 0,
      durationS: i.durationS ?? 0,
      runs: i.runs ?? 0,
    })),
  );

  return sorted.map((e, idx) => ({
    rank: idx + 1,
    discordId: e.discordId,
    userName: e.userName,
    // 保存はメートル整数、APIの入出力は km の小数（document/running_api.md §3）
    distanceKm: e.distanceM / 1000,
    durationS: e.durationS,
    runs: e.runs,
  }));
}

// 順位算出のためにパーティション全体を取得する際の上限件数。
// メンバー数十人規模のコミュニティを想定しており、無限にページングして
// Lambda のタイムアウトやレイテンシ悪化を招かないためのフェイルセーフ。
// この上限に達した場合、上限を超えた順位のユーザーは getMyRank から null（順位不明）として
// 扱われる（実用上、数百〜千人規模を超えるアクティブユーザーが同一期間に記録を持つことは
// 想定していない）。
const RANK_QUERY_CAP = 1000;

async function queryAggregates(scope: AggScope, period?: string): Promise<RawAggItem[]> {
  const items: RawAggItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI1',
        KeyConditionExpression: 'gsi1pk = :p',
        ExpressionAttributeValues: { ':p': lbPk(scope, period) },
        // distanceM（GSI1のソートキー）を降順で読む。distanceM は Number 型なので、
        // コード側で並べ替えなくてもこの時点で距離順になっている（tie-break だけ後段で行う）。
        ScanIndexForward: false,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(...((res.Items ?? []) as RawAggItem[]));
    exclusiveStartKey = res.LastEvaluatedKey;
  } while (exclusiveStartKey && items.length < RANK_QUERY_CAP);

  return items.slice(0, RANK_QUERY_CAP);
}

/** GET /v1/ranking の entries。上位 limit 件を返す。 */
export async function getLeaderboard(
  scope: AggScope,
  period: string | undefined,
  limit: number,
): Promise<LeaderboardEntry[]> {
  const items = await queryAggregates(scope, period);
  return buildLeaderboardEntries(items).slice(0, limit);
}

/** GET /v1/ranking の me。ランキングに乗っていない（runs=0 または上限超過）場合は null。 */
export async function getMyRank(
  scope: AggScope,
  period: string | undefined,
  discordId: string,
): Promise<{ rank: number; distanceKm: number } | null> {
  const items = await queryAggregates(scope, period);
  const entries = buildLeaderboardEntries(items);
  const mine = entries.find((e) => e.discordId === discordId);
  return mine ? { rank: mine.rank, distanceKm: mine.distanceKm } : null;
}

// ── period のバリデーション ────────────────────────────────────────────

const MONTH_RE = /^\d{4}-(\d{2})$/;
const WEEK_RE = /^\d{4}-W(\d{2})$/;

/**
 * scope に対して period の形式が実在しうる値かどうかを検証する（純粋関数）。
 * 月は 01〜12、週は 01〜53 の範囲チェックのみ行う（暦・ISO週の年間週数との厳密な整合は見ない）。
 * scope = 'total' では period は無視されるため常に true を返す。
 */
export function isValidPeriod(scope: AggScope, period: string): boolean {
  if (scope === 'total') return true;

  if (scope === 'month') {
    const m = MONTH_RE.exec(period);
    if (!m) return false;
    const mo = Number(m[1]);
    return mo >= 1 && mo <= 12;
  }

  const w = WEEK_RE.exec(period);
  if (!w) return false;
  const wn = Number(w[1]);
  return wn >= 1 && wn <= 53;
}

export type ResolvePeriodResult = { ok: true; period: string | null } | { ok: false; message: string };

/**
 * クエリ/コマンド引数の period を解決する。
 * - scope = 'total' のときは period を無視して null を返す
 * - 省略時は JST の「今期」（当月 / 今週）を使う
 * - 指定時は isValidPeriod で形式を検証し、不正なら日本語エラーメッセージを返す
 * @param now テスト用にエポックミリ秒を注入できる（省略時は Date.now()）
 */
export function resolvePeriod(
  scope: AggScope,
  periodParam: string | undefined,
  now: number = Date.now(),
): ResolvePeriodResult {
  if (scope === 'total') {
    return { ok: true, period: null };
  }

  if (periodParam === undefined) {
    const today = todayJst(now);
    return { ok: true, period: scope === 'month' ? monthKey(today) : weekKey(today) };
  }

  if (!isValidPeriod(scope, periodParam)) {
    const example = scope === 'month' ? 'YYYY-MM' : 'YYYY-Www';
    return { ok: false, message: `period は ${example} 形式で指定してください` };
  }

  return { ok: true, period: periodParam };
}

// ── 閾値ロール（次の目標）の計算 ────────────────────────────────────────

export interface ThresholdLike {
  km: number;
  roleName: string;
}

export interface NextThreshold {
  km: number;
  remainingKm: number;
  roleName: string;
}

/**
 * 現在の距離（メートル）から、まだ達成していない最小の閾値を返す純粋関数。
 * thresholds は km 昇順である必要はない（内部でソートする）。
 * 全て達成済み、または thresholds が空なら null。
 */
export function pickNextThreshold(distanceM: number, thresholds: ThresholdLike[]): NextThreshold | null {
  const distanceKm = distanceM / 1000;
  const sorted = [...thresholds].sort((a, b) => a.km - b.km);

  for (const t of sorted) {
    if (t.km > distanceKm) {
      return {
        km: t.km,
        // 浮動小数点誤差対策として小数点2桁に丸める（distanceKm 自体も同様の丸めがない前提の値）。
        remainingKm: Math.round((t.km - distanceKm) * 100) / 100,
        roleName: t.roleName,
      };
    }
  }

  return null;
}
