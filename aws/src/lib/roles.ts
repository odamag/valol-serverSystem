// Phase 3: Discord ロールの自動付与（閾値ロール・月間1位ロール）。
//
// 「今どのロールを持っているか」の真実は Discord ではなく DynamoDB の PROFILE アイテム
// （pk: U#<discordId>, sk: 'PROFILE', thresholdRoleId）に持たせる。
// 判定のたびに Discord へメンバー情報を問い合わせる設計にしなかった理由:
//   - レート制限にすぐ当たる（メンバー数十人規模でも記録の追加・削除は頻繁に起こる）
//   - メンバー一覧・ロール一覧の取得には GUILD_MEMBERS という特権インテント
//     （Discord Developer Portal での申請が必要）が絡み、運用のハードルが上がる
// このため「DynamoDB 側の記録を正として Discord 側へ一方的に反映する」方式にした。
// 何らかの理由（手動でのロール変更、過去のバグ等）で実際の付与状況とズレた場合は、
// /run-admin recalc（recalcAll）または月初のロールオーバー処理（applyMonthlyRollover）が
// 補正する。

import { GetCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { botFetch } from './discord-rest';
import { ddb, TABLE_NAME } from './ddb';
import { monthKey, todayJst } from './jst';
import { aggSk, userPk } from './keys';
import { getLeaderboard, type LeaderboardEntry } from './leaderboard';
import { getMonthlyAggregate } from './records';
import { getSettings, updateSettings } from './settings';

const GUILD_ID = process.env.DISCORD_GUILD_ID ?? '';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 一括処理（月初のロールオーバー・recalc）でロールを直列に付け外しする際の待機時間。
// 並列に叩くと数十人規模でもすぐ 429 (レート制限) に当たるため、必ず直列 + 間隔をあける。
const SEQUENTIAL_DELAY_MS = 250;

// ── 権限チェック（純粋関数） ─────────────────────────────────────────────

const ADMINISTRATOR_BIT = 0x8n;

/**
 * Discord Interaction の member.permissions（10進文字列）に ADMINISTRATOR ビットが
 * 立っているかを判定する。/run-admin は default_member_permissions で UI 上は
 * 非管理者から隠されるが、それはクライアント側の表示制御にすぎずサーバー側の保証にはならないため、
 * ハンドラ側（worker.ts）で必ずこの関数による検証を行う。
 *
 * permissions は数値としては JS の安全整数範囲を超えうるため BigInt で扱う。
 * 未定義（DM実行時など member 自体が無い場合）や BigInt に変換できない値は false 扱いにする。
 */
export function hasAdminPermission(permissions: string | undefined): boolean {
  if (permissions === undefined) return false;
  try {
    const bits = BigInt(permissions);
    return (bits & ADMINISTRATOR_BIT) === ADMINISTRATOR_BIT;
  } catch {
    return false;
  }
}

// ── 閾値ロールの選定（純粋関数） ─────────────────────────────────────────

/** 閾値ロールの計算に必要な最小限の形（settings.ts の Threshold と構造的に互換）。 */
export interface AchievableThreshold {
  km: number;
  roleId: string;
  roleName: string;
}

/**
 * 現在の距離（メートル）から、達成済みの閾値のうち最大のものを返す純粋関数。
 * thresholds は km 昇順である必要はない（内部でソートする）。
 * ちょうど閾値ぴったり（km === distanceKm）は達成扱いにする。
 * 未達（最小の閾値にも届いていない）、または thresholds が空なら null。
 */
export function pickAchievedThreshold(
  distanceM: number,
  thresholds: AchievableThreshold[],
): AchievableThreshold | null {
  const distanceKm = distanceM / 1000;
  const sorted = [...thresholds].sort((a, b) => a.km - b.km);

  let achieved: AchievableThreshold | null = null;
  for (const t of sorted) {
    if (t.km <= distanceKm) {
      achieved = t; // 昇順で見ているので、最後に代入されたものが「達成済みのうち最大」になる
    } else {
      break;
    }
  }
  return achieved;
}

// ── PROFILE アイテム（ロール付与状況の真実） ─────────────────────────────

interface ProfileItem {
  pk: string;
  sk: 'PROFILE';
  thresholdRoleId?: string | null;
}

async function getProfile(discordId: string): Promise<{ thresholdRoleId: string | null }> {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { pk: userPk(discordId), sk: 'PROFILE' } }),
  );
  const item = res.Item as ProfileItem | undefined;
  return { thresholdRoleId: item?.thresholdRoleId ?? null };
}

async function setProfileThresholdRoleId(discordId: string, roleId: string | null): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk: userPk(discordId), sk: 'PROFILE' },
      UpdateExpression: 'SET thresholdRoleId = :r',
      ExpressionAttributeValues: { ':r': roleId },
    }),
  );
}

// ── Discord ロール操作 ──────────────────────────────────────────────────

async function modifyMemberRole(
  method: 'PUT' | 'DELETE',
  userId: string,
  roleId: string,
  reason: string,
): Promise<void> {
  if (!GUILD_ID) {
    console.error('[roles] DISCORD_GUILD_ID が未設定のためロール操作をスキップしました');
    return;
  }

  const res = await botFetch(`/guilds/${GUILD_ID}/members/${userId}/roles/${roleId}`, {
    method,
    headers: {
      // ヘッダ値は ASCII 以外を含められない（fetch の制約）ため、日本語の理由は必ず
      // encodeURIComponent してから渡す。
      'X-Audit-Log-Reason': encodeURIComponent(reason),
    },
  });

  if (res.status === 403) {
    // これが最も引っかかりやすい箇所: Bot に Administrator 権限があっても、
    // ロール階層（Botの最上位ロールが対象ロールより下）が原因で 403 になることがある。
    // これは Discord のロール階層という権限とは独立した制約であり、Administrator では回避できない。
    console.error(
      `[roles] 403 Forbidden (${method} .../roles/${roleId}, user=${userId}): ` +
        'Botのロールが対象ロールより下位にある可能性があります' +
        '（ロール階層は権限とは独立した制約で、Administratorでも回避できません）。' +
        'サーバー設定でBotのロールを対象ロールより上に移動してください。',
    );
  }
}

/** ロールを付与する。botFetch が 429 リトライを内部で処理するので、ここでは呼ぶだけでよい。 */
export function addRole(userId: string, roleId: string, reason: string): Promise<void> {
  return modifyMemberRole('PUT', userId, roleId, reason);
}

/** ロールを剥奪する。 */
export function removeRole(userId: string, roleId: string, reason: string): Promise<void> {
  return modifyMemberRole('DELETE', userId, roleId, reason);
}

async function announceThresholdAchievement(
  discordId: string,
  threshold: AchievableThreshold,
  announceChannelId: string | null,
): Promise<void> {
  if (!announceChannelId) return; // 未設定なら告知しない

  await botFetch(`/channels/${announceChannelId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      content: `🎉 <@${discordId}> さんが今月の累計 ${threshold.km}km を達成し、「${threshold.roleName}」を獲得しました！`,
    }),
  });
}

// ── 閾値ロールの同期（記録の追加/編集/削除の直後に呼ばれる） ────────────────

/**
 * 当月累計から達成済みの閾値ロールを算出し、実際の付与状況（PROFILE.thresholdRoleId）と
 * 差分があれば Discord 側へ反映する。runDate による「当月かどうか」のゲートは行わず、
 * 常に「今」の当月累計で判定する内部関数。syncThresholdRole と recalcAll の共通処理。
 */
async function syncThresholdRoleForCurrentMonth(discordId: string): Promise<void> {
  const ym = monthKey(todayJst());

  const [agg, settings, profile] = await Promise.all([
    getMonthlyAggregate(discordId, ym),
    getSettings(),
    getProfile(discordId),
  ]);

  // distanceKm から distanceM を復元する（distanceM はもともと整数メートルなので誤差なく戻る）。
  const distanceM = Math.round(agg.distanceKm * 1000);
  const achieved = pickAchievedThreshold(distanceM, settings.thresholds);

  const want = achieved?.roleId ?? null;
  const have = profile.thresholdRoleId;

  if (want === have) {
    // 変化なし。Discord API を1回も呼ばずに終了する（レート制限対策・無駄な監査ログ抑止）。
    return;
  }

  // 「新規達成」かどうか（＝ 上位の閾値に上がったのか）を判定する。
  // have に対応する旧閾値の km と比較することで、記録削除などで累計が減り
  // 閾値が下がったケース（ダウングレード）を「達成」として誤って祝ってしまわないようにする。
  const previousThreshold = have ? settings.thresholds.find((t) => t.roleId === have) ?? null : null;
  const isUpgrade = achieved !== null && (previousThreshold === null || achieved.km > previousThreshold.km);

  const reason = '月間走行距離の閾値ロール自動更新';
  if (have) {
    await removeRole(discordId, have, reason);
  }
  if (want) {
    await addRole(discordId, want, reason);
  }
  await setProfileThresholdRoleId(discordId, want);

  if (isUpgrade && achieved) {
    await announceThresholdAchievement(discordId, achieved, settings.announceChannelId);
  }
}

/**
 * 記録の追加/編集/削除の直後に呼ぶ想定の公開関数。
 * runDate が当月でなければ何もしない（過去月への追記・修正・削除で当月のロールを
 * 動かしてしまわないようにするため。当月のロールは「当月何km走ったか」だけで決まるべき）。
 */
export async function syncThresholdRole(discordId: string, runDate: string): Promise<void> {
  if (monthKey(runDate) !== monthKey(todayJst())) {
    return;
  }
  await syncThresholdRoleForCurrentMonth(discordId);
}

// ── 全ユーザーの再計算（/run-admin recalc） ──────────────────────────────

// pk は "U#<discordId>" 形式なので "U#" を取り除くだけで discordId が復元できる（keys.ts の逆変換）。
function discordIdFromPk(pk: string): string {
  return pk.startsWith('U#') ? pk.slice(2) : pk;
}

async function scanDiscordIdsBySk(sk: string): Promise<string[]> {
  const ids: string[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'sk = :sk',
        ExpressionAttributeValues: { ':sk': sk },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const item of (res.Items ?? []) as { pk: string }[]) {
      ids.push(discordIdFromPk(item.pk));
    }
    exclusiveStartKey = res.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return ids;
}

/**
 * 全ユーザーの当月集計から閾値ロールを再計算して整合させる（/run-admin recalc）。
 *
 * 対象ユーザーは次の2つの集合の和集合にする:
 *   - 当月の集計アイテム（AGG#M#<ym>）を持つユーザー（新規に閾値を達成した可能性がある）
 *   - PROFILE アイテムを持つユーザー（既にロールを持っており、記録削除等でズレて
 *     いる可能性がある。当月の記録が無くても剥奪の対象になりうる）
 * 数十人規模のコミュニティを想定しており、Scan で十分（インデックスは使わない）。
 */
export async function recalcAll(): Promise<void> {
  const ym = monthKey(todayJst());

  const [fromAgg, fromProfile] = await Promise.all([
    scanDiscordIdsBySk(aggSk('month', ym)),
    scanDiscordIdsBySk('PROFILE'),
  ]);
  const discordIds = [...new Set([...fromAgg, ...fromProfile])];

  // 一括剥奪と同じ理由（429対策）で直列 + 間隔をあけて実行する。
  for (const discordId of discordIds) {
    await syncThresholdRoleForCurrentMonth(discordId);
    await sleep(SEQUENTIAL_DELAY_MS);
  }
}

// ── 月次ロールオーバー（EventBridge Scheduler から月初 00:05 JST に呼ばれる） ────

// "YYYY-MM" の前月を計算する。jst.ts には「前月」のユーティリティが無く、
// このモジュールでしか使わないため、ここに閉じて実装する（UTC上の月計算だけで足りる。
// JST/UTC の違いは日付部分に影響しないため気にしなくてよい）。
function previousMonthKey(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  d.setUTCMonth(d.getUTCMonth() - 1);
  const py = d.getUTCFullYear();
  const pm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${py}-${pm}`;
}

async function announceMonthlyResults(
  prevYm: string,
  top5: LeaderboardEntry[],
  announceChannelId: string | null,
): Promise<void> {
  if (!announceChannelId || top5.length === 0) return;

  const fields = top5.map((e) => ({
    name: `${e.rank}位 ${e.userName}`,
    value: `${e.distanceKm}km（${e.runs}回）`,
  }));

  await botFetch(`/channels/${announceChannelId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      embeds: [{ title: `${prevYm} 月間ランキング結果`, fields }],
    }),
  });
}

/**
 * 月間1位ロールの確定した前月分への付け替え + 閾値ロールの月初リセット + 前月TOP5の告知。
 *
 * 月間1位を「リアルタイム1位」にしないのは意図的な設計判断: 月末に1位が入れ替わるたびに
 * ロールが行き来すると、その度に付与・剥奪の通知が Discord 上で乱発されてしまう。
 * そのため「月が確定した後の前月の1位」に翌月まるまる付与する方式にし、月に一度だけ
 * 入れ替わるようにしている。
 *
 * 冪等性: 手動再実行やスケジューラの重複起動があっても壊れないよう、
 * settings.topRoleMonth が既に前月と一致していれば1位の入れ替え自体はスキップする
 * （同じ月に2回呼ばれても、1位の付け替えは1回しか起こらない）。
 * 閾値ロールの一括剥奪は自然に冪等（既に null のものは対象にならない。scanDiscordIdsBySk
 * の PROFILE スキャン + syncThresholdRoleForCurrentMonth 相当の剥奪ロジックを参照）。
 */
export async function applyMonthlyRollover(): Promise<void> {
  const nowYm = monthKey(todayJst());
  const prevYm = previousMonthKey(nowYm);

  const settings = await getSettings();
  const top5 = await getLeaderboard('month', prevYm, 5);
  const newTop = top5.length > 0 && top5[0].runs > 0 ? top5[0] : null;

  // 1) 月間1位ロールの付け替え（冪等性: 既に前月分の処理が済んでいればスキップ）
  if (settings.topRoleMonth !== prevYm) {
    if (settings.topHolderDiscordId && settings.monthlyTopRoleId) {
      await removeRole(
        settings.topHolderDiscordId,
        settings.monthlyTopRoleId,
        `${prevYm}の月間1位ロールの月次更新`,
      );
    }
    if (newTop && settings.monthlyTopRoleId) {
      await addRole(newTop.discordId, settings.monthlyTopRoleId, `${prevYm}の月間1位`);
    }
    await updateSettings({
      topHolderDiscordId: newTop ? newTop.discordId : null,
      topRoleMonth: prevYm,
    });
  }

  // 2) 閾値ロールの一括剥奪（新しい月は0kmから始まるため、全員の当月ロールをリセットする）。
  await clearAllThresholdRoles();

  // 3) 前月TOP5の告知
  await announceMonthlyResults(prevYm, top5, settings.announceChannelId);
}

interface ProfileWithRole {
  discordId: string;
  thresholdRoleId: string;
}

/**
 * thresholdRoleId を持つ全 PROFILE を走査して取得する。
 * Scan の FilterExpression は 'sk = :p AND attribute_exists(thresholdRoleId)' で十分
 * （テーブル全体を舐めても、対象は数十アイテム規模のコミュニティを想定しているため）。
 * 剥奪済み（thresholdRoleId が既に null）のアイテムも attribute_exists は true になるため、
 * ここでは値が truthy なものだけを結果に含めることで、実際に操作が必要なものだけに絞る
 * （これにより、この関数を使う一括剥奪処理は自然に冪等になる）。
 */
async function scanProfilesWithThresholdRole(): Promise<ProfileWithRole[]> {
  const results: ProfileWithRole[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'sk = :p AND attribute_exists(thresholdRoleId)',
        ExpressionAttributeValues: { ':p': 'PROFILE' },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const item of (res.Items ?? []) as ProfileItem[]) {
      if (item.thresholdRoleId) {
        results.push({ discordId: discordIdFromPk(item.pk), thresholdRoleId: item.thresholdRoleId });
      }
    }
    exclusiveStartKey = res.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return results;
}

async function clearAllThresholdRoles(): Promise<void> {
  const profiles = await scanProfilesWithThresholdRole();

  // 一括剥奪は 429 を避けるため 250ms 間隔で直列実行する（並列で叩かない）。
  for (const p of profiles) {
    await removeRole(p.discordId, p.thresholdRoleId, '月初のリセット（今月の累計は0kmから再スタート）');
    await setProfileThresholdRoleId(p.discordId, null);
    await sleep(SEQUENTIAL_DELAY_MS);
  }
}
