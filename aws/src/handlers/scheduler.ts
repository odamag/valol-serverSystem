// EventBridge Scheduler（MonthlyRollover）から毎月1日 0:05 (Asia/Tokyo) に起動される想定のバッチ。
// 月次の集計ロールオーバー処理などを行う。
//
// running-app-stack.ts の CfnSchedule が渡す input は { job: 'monthly-rollover' } 固定。
// event.job で分岐する形にしておくのは、将来別のジョブを同じ関数に相乗りさせたくなったときに
// EventBridge 側のスケジュール定義を増やすだけで済むようにするため。

import { applyMonthlyRollover } from '../lib/roles';

interface SchedulerEvent {
  job?: string;
}

export const handler = async (event: SchedulerEvent): Promise<void> => {
  if (event?.job === 'monthly-rollover') {
    await applyMonthlyRollover();
    return;
  }

  // 未知の job は誤設定で意図しない処理が走らないよう、何もせずログだけ残す。
  console.error('[scheduler] unknown job', JSON.stringify(event));
};
