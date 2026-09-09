// CONFIG#SETTINGS アイテム（テーブル内に1件だけ存在する全体設定）の読み書き。
//
// Phase 2 では GET /v1/settings（閾値の一覧表示）でしか使わないが、Phase 3 のロール付与
// （閾値達成ロール・月間トップロールの自動付与）でも同じ設定を読み書きすることになるため、
// 閾値だけでなくロールID・月間トップ関連のフィールドもここで持てるようにしておく。

import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb';

const SETTINGS_PK = 'CONFIG#SETTINGS';
const SETTINGS_SK = 'CONFIG#SETTINGS';

/** 距離の閾値と、達成時に付与する Discord ロール。 */
export interface Threshold {
  km: number;
  roleId: string;
  roleName: string;
}

export interface RunningSettings {
  thresholds: Threshold[];
  /** 月間1位に付与するロール（Phase 3）。未設定なら null。 */
  monthlyTopRoleId: string | null;
  monthlyTopRoleName: string | null;
  /** 月間1位が確定した際の告知先チャンネル（Phase 3）。未設定なら null。 */
  announceChannelId: string | null;
  /** 現在、月間トップロールを保持している discordId（Phase 3 が付け替えの判定に使う）。 */
  topHolderDiscordId: string | null;
  /** topHolderDiscordId が「どの月」の集計に基づくものかを示す YYYY-MM。 */
  topRoleMonth: string | null;
}

const DEFAULT_SETTINGS: RunningSettings = {
  thresholds: [],
  monthlyTopRoleId: null,
  monthlyTopRoleName: null,
  announceChannelId: null,
  topHolderDiscordId: null,
  topRoleMonth: null,
};

/** thresholds を常に km の昇順にして返す（呼び出し側が毎回ソートしなくて済むようにするため）。 */
export function sortThresholds(thresholds: Threshold[]): Threshold[] {
  return [...thresholds].sort((a, b) => a.km - b.km);
}

// DynamoDB 上の設定アイテムの内部表現（存在しない場合もある）。
interface SettingsItem extends Partial<RunningSettings> {
  pk: string;
  sk: string;
}

// Lambda はコールドスタートをまたいでモジュールを使い回すため、設定値をモジュールスコープに
// 60秒 TTL でキャッシュする。設定は /run-admin（Phase 3）でしか更新されない、つまり
// 「滅多に変わらない値」なのに毎リクエスト DynamoDB へ Get しに行くのは無駄なため。
// 注意: このキャッシュがある以上、/run-admin で設定を更新した直後（最大60秒）は、
// 同じ実行環境が処理する別のリクエストに更新前の値が返ることがありうる。
// 更新系の関数（updateSettings）は必ず invalidateSettingsCache() でキャッシュを飛ばすこと。
const CACHE_TTL_MS = 60_000;
let cache: { value: RunningSettings; expiresAt: number } | null = null;

function normalize(item: SettingsItem | undefined): RunningSettings {
  return {
    thresholds: sortThresholds(item?.thresholds ?? DEFAULT_SETTINGS.thresholds),
    monthlyTopRoleId: item?.monthlyTopRoleId ?? DEFAULT_SETTINGS.monthlyTopRoleId,
    monthlyTopRoleName: item?.monthlyTopRoleName ?? DEFAULT_SETTINGS.monthlyTopRoleName,
    announceChannelId: item?.announceChannelId ?? DEFAULT_SETTINGS.announceChannelId,
    topHolderDiscordId: item?.topHolderDiscordId ?? DEFAULT_SETTINGS.topHolderDiscordId,
    topRoleMonth: item?.topRoleMonth ?? DEFAULT_SETTINGS.topRoleMonth,
  };
}

/**
 * 設定アイテムを取得する。アイテムがまだ作成されていなくてもエラーにはせず、
 * 全て空の既定値を返す（/run-admin で一度も設定していないサーバーでも動くようにするため）。
 */
export async function getSettings(now: number = Date.now()): Promise<RunningSettings> {
  if (cache && cache.expiresAt > now) {
    return cache.value;
  }

  const res = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { pk: SETTINGS_PK, sk: SETTINGS_SK } }),
  );
  const value = normalize(res.Item as SettingsItem | undefined);

  cache = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

/** 設定キャッシュを無効化する。設定を更新した経路（Phase 3 の /run-admin 等）は必ず呼ぶこと。 */
export function invalidateSettingsCache(): void {
  cache = null;
}

/**
 * 設定を部分更新する（Phase 3 の /run-admin から使う想定）。
 * thresholds を渡す場合は丸ごと置き換える（差分マージはしない）。
 */
export async function updateSettings(patch: Partial<RunningSettings>): Promise<RunningSettings> {
  const current = await getSettings();
  const merged: RunningSettings = {
    ...current,
    ...patch,
    thresholds: sortThresholds(patch.thresholds ?? current.thresholds),
  };

  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { pk: SETTINGS_PK, sk: SETTINGS_SK, ...merged },
    }),
  );

  // 書き込み直後にキャッシュへ merged を積んでもよいが、
  // 「更新経路は必ずキャッシュを無効化する」という単純なルールにしておいたほうが事故りにくいため、
  // ここでも invalidate だけ行い、次回 getSettings() で読み直させる。
  invalidateSettingsCache();
  return merged;
}
