// DynamoDB の単一テーブル設計におけるキー生成ユーティリティ。
// `aws/lib/running-data-stack.ts` のテーブル定義（pk/sk + GSI1(gsi1pk, distanceM)）に対応する。
//
// このテーブルには次の3種類のアイテムが同居する（pk/sk のプレフィックスで区別する）:
//   - 記録アイテム: pk = U#<discordId>, sk = R#<runDate>#<recordIdHex>
//   - 集計アイテム: pk = U#<discordId>, sk = AGG#M#<ym> / AGG#W#<yw> / AGG#TOTAL
//     （gsi1pk に LB#... を持たせることで GSI1 経由のランキング集計にも使う。スパースGSI）
//   - nonce アイテム: pk = NONCE#<nonce>, sk = NONCE（verify-hmac.ts が使う。ttl で自動削除）

/** ユーザーの記録・集計アイテムが属するパーティションキー */
export function userPk(discordId: string): string {
  return `U#${discordId}`;
}

/** 記録アイテムのソートキー */
export function recordSk(runDate: string, recordIdHex: string): string {
  return `R#${runDate}#${recordIdHex}`;
}

/** 外部公開用の記録ID（API のレスポンス・PATCH/DELETE のパスに使う） */
export function recordId(runDate: string, recordIdHex: string): string {
  return `${runDate}_${recordIdHex}`;
}

const RECORD_ID_RE = /^(\d{4}-\d{2}-\d{2})_([0-9a-f]{32})$/;

/**
 * 外部公開用の記録ID "<YYYY-MM-DD>_<32桁hex>" を runDate と recordIdHex に分解する。
 * 形式が不正なら null を返す（パス上の値をそのまま信用しないため、呼び出し側は
 * null を「見つからない」扱いにすること）。
 */
export function parseRecordId(id: string): { runDate: string; recordIdHex: string } | null {
  const m = RECORD_ID_RE.exec(id);
  if (!m) return null;
  return { runDate: m[1], recordIdHex: m[2] };
}

export type AggScope = 'month' | 'week' | 'total';

/**
 * 集計アイテムのソートキー。
 * @param period scope が 'total' の場合は不要（無視される）
 */
export function aggSk(scope: AggScope, period?: string): string {
  switch (scope) {
    case 'month':
      return `AGG#M#${period}`;
    case 'week':
      return `AGG#W#${period}`;
    case 'total':
      return 'AGG#TOTAL';
  }
}

/**
 * 集計アイテムの GSI1 パーティションキー（ランキング用。Phase 2 で GSI1 を使って読む）。
 * @param period scope が 'total' の場合は不要（無視される）
 */
export function lbPk(scope: AggScope, period?: string): string {
  switch (scope) {
    case 'month':
      return `LB#M#${period}`;
    case 'week':
      return `LB#W#${period}`;
    case 'total':
      return 'LB#TOTAL';
  }
}
