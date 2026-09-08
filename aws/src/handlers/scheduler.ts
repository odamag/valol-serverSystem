// EventBridge Scheduler（MonthlyRollover）から毎月1日 0:05 (Asia/Tokyo) に起動される想定のバッチ。
// 月次の集計ロールオーバー処理などを行う。
//
// Phase 0 では中身は未実装（ログ出力のみ）のスタブ。
export const handler = async (event: unknown): Promise<void> => {
  console.log('[scheduler] invoked (Phase 0 stub)', JSON.stringify(event));
};
