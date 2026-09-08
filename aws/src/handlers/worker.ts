// InteractionsFn から `InvocationType: 'Event'` で非同期に invoke されるワーカー。
// Discord の3秒応答制限に縛られず、DynamoDB 書き込みなどの重い処理をここで行い、
// 完了したら followup（PATCH .../messages/@original）で本編の応答を返す。
//
// 受け取る event は、interactions.ts が署名検証を通した Discord Interaction オブジェクトそのもの
// （API Gateway のラップは無い。Lambda-to-Lambda invoke なので Payload がそのまま event になる）。
//
// 重要: このハンドラは絶対に例外を外へ投げてはいけない。
// 非同期 Lambda 呼び出しは失敗すると自動的にリトライされる仕組みになっており、
// 例えば createRecord が成功した「あと」に followup 送信が失敗して例外を投げてしまうと、
// Lambda が「処理全体が失敗した」と判断して worker を再実行し、記録が二重に作成されてしまう。
// そのため handler の最上位は必ず try/catch で全体を包み、失敗時もログに残すだけに留める。

import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/ddb';
import { type AggScope, parseRecordId, recordSk, userPk } from '../lib/keys';
import { monthKey, todayJst } from '../lib/jst';
import { getLeaderboard, getMyRank, pickNextThreshold, resolvePeriod } from '../lib/leaderboard';
import { createRecord, deleteRecord, getSummary, listRecords } from '../lib/records';
import { getSettings, updateSettings, type Threshold } from '../lib/settings';
import { hasAdminPermission, recalcAll, syncThresholdRole } from '../lib/roles';
import { validateCreateRecord } from '../lib/validate';
import { followup } from '../lib/discord-rest';
import {
  type DiscordInteraction,
  type DiscordInteractionOption,
  LIST_RECENT_LIMIT,
  RANK_DISPLAY_LIMIT,
  RUN_ADMIN_COMMAND_NAME,
  SUB_ADD,
  SUB_ADMIN_CHANNEL_SET,
  SUB_ADMIN_RECALC,
  SUB_ADMIN_SHOW,
  SUB_ADMIN_THRESHOLD_REMOVE,
  SUB_ADMIN_THRESHOLD_SET,
  SUB_ADMIN_TOP_ROLE_SET,
  SUB_DELETE,
  SUB_LIST,
  SUB_ME,
  SUB_RANK,
  SUB_WEB,
  OPT_CHANNEL,
  OPT_COURSE,
  OPT_DATE,
  OPT_DISTANCE,
  OPT_HR,
  OPT_KCAL,
  OPT_KM,
  OPT_MEMO,
  OPT_MONTH,
  OPT_PERIOD,
  OPT_RECORD,
  OPT_ROLE,
  OPT_SCOPE,
  OPT_TIME,
  OPT_WEATHER,
  findOption,
  formatClock,
  formatPace,
  getInteractionUserId,
  getInteractionUserName,
  getSubcommand,
  medalForRank,
  parseClockToSeconds,
  scopeLabel,
  weatherLabel,
} from '../lib/commands';

const SITE_ORIGIN = process.env.SITE_ORIGIN ?? '';

// Discord Embed のアクセントカラー（水色寄りの青）。特に意味はなく見た目の統一のためだけの定数。
const EMBED_COLOR = 0x2b6cb0;

function optionValue(options: DiscordInteractionOption[], name: string): string | number | boolean | undefined {
  return findOption(options, name)?.value;
}

async function replyText(interaction: DiscordInteraction, content: string): Promise<void> {
  await followup(interaction.application_id, interaction.token, { content });
}

/** `/run add`: 距離・時間などを検証して記録を作成し、結果を Embed で返す。 */
async function handleAdd(
  interaction: DiscordInteraction,
  discordId: string,
  userName: string,
  options: DiscordInteractionOption[],
): Promise<void> {
  const distance = optionValue(options, OPT_DISTANCE);
  const time = optionValue(options, OPT_TIME);

  if (typeof time !== 'string') {
    await replyText(interaction, '時間を指定してください（例: 26:30 / 1:05:12）');
    return;
  }

  const durationS = parseClockToSeconds(time);
  if (durationS === null) {
    await replyText(
      interaction,
      '時間の形式が正しくありません。mm:ss または h:mm:ss の形式で入力してください（例: 26:30 / 1:05:12）',
    );
    return;
  }

  // Web（handlers/api.ts）と同じバリデーション関数に、Web API と同じ形のボディを渡す。
  // こうすることで丸め・上限・エラーメッセージの規約を二重実装せずに揃えられる
  // （document/running_api.md §6）。
  const body: Record<string, unknown> = { distanceKm: distance, durationS };

  const date = optionValue(options, OPT_DATE);
  if (typeof date === 'string') body.runDate = date;

  const course = optionValue(options, OPT_COURSE);
  if (typeof course === 'string') body.course = course;

  const weather = optionValue(options, OPT_WEATHER);
  if (typeof weather === 'string') body.weather = weather;

  const hr = optionValue(options, OPT_HR);
  if (typeof hr === 'number') body.heartRate = hr;

  const kcal = optionValue(options, OPT_KCAL);
  if (typeof kcal === 'number') body.calories = kcal;

  const memo = optionValue(options, OPT_MEMO);
  if (typeof memo === 'string') body.memo = memo;

  const result = validateCreateRecord(body);
  if (!result.ok) {
    await replyText(interaction, result.message);
    return;
  }

  const record = await createRecord(discordId, userName, 'discord', result.value);

  // ロール同期はベストエフォート: 記録は既に DynamoDB へコミット済みのため、
  // ここで失敗しても記録の保存自体を巻き戻してはいけない。ログにだけ残し、
  // ユーザーへの応答（followup）は通常どおり成功として返す。
  try {
    await syncThresholdRole(discordId, record.runDate);
  } catch (err) {
    console.error('[worker] syncThresholdRole failed after createRecord', err);
  }

  const fields: { name: string; value: string; inline?: boolean }[] = [
    { name: '距離', value: `${record.distanceKm}km`, inline: true },
    { name: '時間', value: formatClock(record.durationS), inline: true },
    { name: 'ペース', value: formatPace(record.paceSPerKm), inline: true },
    { name: '日付', value: record.runDate, inline: true },
  ];
  if (record.course) fields.push({ name: 'コース', value: record.course, inline: true });
  const wLabel = weatherLabel(record.weather);
  if (wLabel) fields.push({ name: '天気', value: wLabel, inline: true });
  if (record.heartRate !== null) fields.push({ name: '心拍数', value: `${record.heartRate}bpm`, inline: true });
  if (record.calories !== null) fields.push({ name: '消費カロリー', value: `${record.calories}kcal`, inline: true });
  if (record.memo) fields.push({ name: 'メモ', value: record.memo });

  await followup(interaction.application_id, interaction.token, {
    embeds: [{ title: '記録を追加しました', color: EMBED_COLOR, fields }],
  });
}

/** `/run list`: 直近 LIST_RECENT_LIMIT 件を新しい順に返す（page を実装しない理由は commands.ts 参照）。 */
async function handleList(interaction: DiscordInteraction, discordId: string): Promise<void> {
  const { records } = await listRecords(discordId, LIST_RECENT_LIMIT, null);

  if (records.length === 0) {
    await replyText(interaction, 'まだ記録がありません。`/run add` で記録を追加しましょう！');
    return;
  }

  const lines = records.map((r) => {
    const mmdd = r.runDate.slice(5).replace('-', '/');
    const course = r.course ? ` ${r.course}` : '';
    return `${mmdd} ${r.distanceKm}km ${formatClock(r.durationS)}（${formatPace(r.paceSPerKm)}）${course}`;
  });

  await followup(interaction.application_id, interaction.token, {
    embeds: [
      {
        title: `直近の記録（最大${LIST_RECENT_LIMIT}件）`,
        color: EMBED_COLOR,
        description: lines.join('\n'),
      },
    ],
  });
}

/**
 * `/run delete`: deleteRecord は楽観ロック（updatedAt）を要求するため、削除前に対象を読んで
 * updatedAt を取得してから渡す。records.ts に単体の getRecord は無いため、
 * records.ts が内部でやっているのと同じ形（keys.ts でキーを組み立てて GetCommand）をここで行う。
 */
async function handleDelete(
  interaction: DiscordInteraction,
  discordId: string,
  options: DiscordInteractionOption[],
): Promise<void> {
  const recordIdValue = optionValue(options, OPT_RECORD);
  if (typeof recordIdValue !== 'string') {
    await replyText(interaction, '削除する記録を指定してください');
    return;
  }

  const parsed = parseRecordId(recordIdValue);
  if (!parsed) {
    await replyText(interaction, '記録が見つかりません（IDの形式が正しくありません）');
    return;
  }

  const pk = userPk(discordId);
  const sk = recordSk(parsed.runDate, parsed.recordIdHex);

  const got = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { pk, sk }, ConsistentRead: true }));
  const item = got.Item as { updatedAt: number; distanceM: number; durationS: number } | undefined;
  if (!item) {
    await replyText(interaction, '記録が見つかりません（既に削除された可能性があります）');
    return;
  }

  const result = await deleteRecord(discordId, recordIdValue, item.updatedAt);
  if (!result.ok) {
    if (result.reason === 'not_found') {
      await replyText(interaction, '記録が見つかりません（既に削除された可能性があります）');
    } else {
      await replyText(interaction, '他の操作と競合しました。もう一度お試しください');
    }
    return;
  }

  // ロール同期はベストエフォート（理由は handleAdd 参照）。記録の削除自体は既に完了している。
  try {
    await syncThresholdRole(discordId, parsed.runDate);
  } catch (err) {
    console.error('[worker] syncThresholdRole failed after deleteRecord', err);
  }

  const distanceKm = item.distanceM / 1000;
  await replyText(
    interaction,
    `記録を削除しました（${parsed.runDate} ${distanceKm}km ${formatClock(item.durationS)}）`,
  );
}

// ペース表示用のヘルパー。distanceKm が 0 のとき（記録なし）は割り算できないので null を返す。
// ペースはサーバー側で保存時に計算する規約（document/running_api.md §3）だが、集計値
// （PeriodSummary）は距離・時間の合計しか持たないため、表示のためにここで都度計算する。
function paceLabel(distanceKm: number, durationS: number): string | null {
  if (distanceKm <= 0) return null;
  return formatPace(Math.round(durationS / distanceKm));
}

/** `/run rank`: 指定 scope/period の上位 RANK_DISPLAY_LIMIT 件を Embed で表示する。 */
async function handleRank(
  interaction: DiscordInteraction,
  discordId: string,
  options: DiscordInteractionOption[],
): Promise<void> {
  const scopeValue = optionValue(options, OPT_SCOPE);
  const scope: AggScope = scopeValue === 'week' || scopeValue === 'total' ? scopeValue : 'month';

  const periodValue = optionValue(options, OPT_PERIOD);
  const periodParam = typeof periodValue === 'string' ? periodValue : undefined;

  const resolved = resolvePeriod(scope, periodParam);
  if (!resolved.ok) {
    await replyText(interaction, resolved.message);
    return;
  }
  const period = resolved.period ?? undefined;

  const [entries, me] = await Promise.all([
    getLeaderboard(scope, period, RANK_DISPLAY_LIMIT),
    getMyRank(scope, period, discordId),
  ]);

  if (entries.length === 0) {
    await replyText(interaction, 'この期間の記録はまだありません');
    return;
  }

  const lines = entries.map((e) => {
    const medal = medalForRank(e.rank);
    const label = medal || `${e.rank}.`;
    return `${label} ${e.userName} — ${e.distanceKm}km ${formatClock(e.durationS)}（${e.runs}回）`;
  });

  // 自分が上位 RANK_DISPLAY_LIMIT 件に入っていない（＝ランク外）なら、末尾に自分の順位を添える。
  if (me && !entries.some((e) => e.discordId === discordId)) {
    lines.push('…');
    lines.push(`${me.rank}. あなた — ${me.distanceKm}km`);
  }

  const periodLabel = resolved.period ? `（${resolved.period}）` : '';

  await followup(interaction.application_id, interaction.token, {
    embeds: [
      {
        title: `${scopeLabel(scope)}ランキング${periodLabel}`,
        color: EMBED_COLOR,
        description: lines.join('\n'),
      },
    ],
  });
}

/** `/run me`: 月間・週間・通算の集計と月間順位、次の閾値までの残りを表示する。 */
async function handleMe(
  interaction: DiscordInteraction,
  discordId: string,
  userName: string,
  options: DiscordInteractionOption[],
): Promise<void> {
  const monthValue = optionValue(options, OPT_MONTH);
  let month: string | undefined;
  if (typeof monthValue === 'string') {
    if (!/^\d{4}-\d{2}$/.test(monthValue)) {
      await replyText(interaction, 'month は YYYY-MM 形式で指定してください（例: 2026-09）');
      return;
    }
    month = monthValue;
  }

  const ym = month ?? monthKey(todayJst());

  const [summary, myRank, settings] = await Promise.all([
    getSummary(discordId, month),
    getMyRank('month', ym, discordId),
    getSettings(),
  ]);

  // distanceKm から distanceM を復元する（distanceM は元々整数メートルなので Math.round で誤差なく戻る）。
  const monthDistanceM = Math.round(summary.month.distanceKm * 1000);
  const nextThreshold = pickNextThreshold(monthDistanceM, settings.thresholds);

  const monthPace = paceLabel(summary.month.distanceKm, summary.month.durationS);
  const weekPace = paceLabel(summary.week.distanceKm, summary.week.durationS);
  const totalPace = paceLabel(summary.total.distanceKm, summary.total.durationS);

  const fields: { name: string; value: string; inline?: boolean }[] = [
    {
      name: `月間（${ym}）`,
      value: `${summary.month.distanceKm}km ${formatClock(summary.month.durationS)}${monthPace ? `（${monthPace}）` : ''} / ${summary.month.runs}回 / 順位: ${myRank ? `${myRank.rank}位` : '-'}`,
    },
    {
      name: '週間',
      value: `${summary.week.distanceKm}km ${formatClock(summary.week.durationS)}${weekPace ? `（${weekPace}）` : ''} / ${summary.week.runs}回`,
    },
    {
      name: '通算',
      value: `${summary.total.distanceKm}km ${formatClock(summary.total.durationS)}${totalPace ? `（${totalPace}）` : ''} / ${summary.total.runs}回`,
    },
  ];

  if (nextThreshold) {
    fields.push({
      name: '次の目標',
      value: `${nextThreshold.roleName}まであと${nextThreshold.remainingKm}km`,
    });
  }

  await followup(interaction.application_id, interaction.token, {
    embeds: [{ title: `${userName} さんの記録`, color: EMBED_COLOR, fields }],
  });
}

/** `/run web`: Web版へのリンクを返すだけ。 */
async function handleWeb(interaction: DiscordInteraction): Promise<void> {
  if (!SITE_ORIGIN) {
    await replyText(interaction, 'Web版のURLが未設定です。管理者に問い合わせてください。');
    return;
  }
  await replyText(interaction, `Web版のランニング記録はこちらから開けます:\n${SITE_ORIGIN}`);
}

// ── /run-admin（Phase 3: ロール自動付与の管理コマンド） ──────────────────────

/** `/run-admin threshold-set`: km→ロールの対応を1件追加/上書きする。 */
async function handleAdminThresholdSet(
  interaction: DiscordInteraction,
  options: DiscordInteractionOption[],
): Promise<void> {
  const km = optionValue(options, OPT_KM);
  const roleId = optionValue(options, OPT_ROLE);

  if (typeof km !== 'number' || !Number.isInteger(km) || km < 1) {
    await replyText(interaction, 'km は1以上の整数で指定してください');
    return;
  }
  if (typeof roleId !== 'string') {
    await replyText(interaction, 'role を指定してください');
    return;
  }

  // ROLE 型オプションの値は snowflake の ID のみなので、表示名は resolved から逆引きする
  // （/run-admin show が ID だけでは読めないため、roleName として保存しておく）。
  const roleName = interaction.data?.resolved?.roles?.[roleId]?.name ?? roleId;

  const settings = await getSettings();
  const nextThresholds: Threshold[] = [
    ...settings.thresholds.filter((t) => t.km !== km),
    { km, roleId, roleName },
  ];
  await updateSettings({ thresholds: nextThresholds });

  await replyText(interaction, `${km}km 達成ロールを「${roleName}」に設定しました`);
}

/** `/run-admin threshold-remove`: km→ロールの対応を1件削除する。 */
async function handleAdminThresholdRemove(
  interaction: DiscordInteraction,
  options: DiscordInteractionOption[],
): Promise<void> {
  const km = optionValue(options, OPT_KM);
  if (typeof km !== 'number') {
    await replyText(interaction, 'km を指定してください');
    return;
  }

  const settings = await getSettings();
  const nextThresholds = settings.thresholds.filter((t) => t.km !== km);
  if (nextThresholds.length === settings.thresholds.length) {
    await replyText(interaction, `${km}km の閾値は設定されていません`);
    return;
  }

  await updateSettings({ thresholds: nextThresholds });
  await replyText(interaction, `${km}km 達成ロールの設定を削除しました`);
}

/** `/run-admin top-role-set`: 月間1位ロールを設定する。 */
async function handleAdminTopRoleSet(
  interaction: DiscordInteraction,
  options: DiscordInteractionOption[],
): Promise<void> {
  const roleId = optionValue(options, OPT_ROLE);
  if (typeof roleId !== 'string') {
    await replyText(interaction, 'role を指定してください');
    return;
  }

  const roleName = interaction.data?.resolved?.roles?.[roleId]?.name ?? roleId;
  await updateSettings({ monthlyTopRoleId: roleId, monthlyTopRoleName: roleName });

  await replyText(interaction, `月間1位ロールを「${roleName}」に設定しました`);
}

/**
 * `/run-admin channel-set`: 告知チャンネルを設定する。
 * settings.ts にはチャンネル名を保存するフィールドが無いため（roleName/monthlyTopRoleName
 * のような専用フィールドを増やすのは今回のスコープ外）、表示には Discord のチャンネルメンション
 * `<#id>` を使う。メンションはクライアント側でチャンネル名として自動的にレンダリングされるため、
 * ID を保存するだけで /run-admin show でも人が読める表示にできる。
 */
async function handleAdminChannelSet(
  interaction: DiscordInteraction,
  options: DiscordInteractionOption[],
): Promise<void> {
  const channelId = optionValue(options, OPT_CHANNEL);
  if (typeof channelId !== 'string') {
    await replyText(interaction, 'channel を指定してください');
    return;
  }

  await updateSettings({ announceChannelId: channelId });
  await replyText(interaction, `告知チャンネルを <#${channelId}> に設定しました`);
}

/** `/run-admin show`: 現在の設定を表示する。 */
async function handleAdminShow(interaction: DiscordInteraction): Promise<void> {
  const settings = await getSettings();

  const thresholdValue =
    settings.thresholds.length > 0
      ? settings.thresholds.map((t) => `${t.km}km → ${t.roleName}`).join('\n')
      : '（未設定）';

  let topRoleValue = '（未設定）';
  if (settings.monthlyTopRoleId) {
    topRoleValue = settings.monthlyTopRoleName ?? settings.monthlyTopRoleId;
    if (settings.topHolderDiscordId) {
      topRoleValue += `\n現在の保持者: <@${settings.topHolderDiscordId}>（${settings.topRoleMonth ?? '-'}分）`;
    }
  }

  const channelValue = settings.announceChannelId ? `<#${settings.announceChannelId}>` : '（未設定）';

  await followup(interaction.application_id, interaction.token, {
    embeds: [
      {
        title: 'ランニング記録ロール設定',
        color: EMBED_COLOR,
        fields: [
          { name: '閾値ロール', value: thresholdValue },
          { name: '月間1位ロール', value: topRoleValue },
          { name: '告知チャンネル', value: channelValue },
        ],
      },
    ],
  });
}

/** `/run-admin recalc`: 全ユーザーの当月集計から閾値ロールを再計算する。 */
async function handleAdminRecalc(interaction: DiscordInteraction): Promise<void> {
  await recalcAll();
  await replyText(interaction, '集計とロールの再計算が完了しました');
}

/**
 * `/run-admin` のディスパッチ。
 * default_member_permissions（commands.ts）は Discord UI 上の表示制御にすぎないため、
 * ここで member.permissions のビットを検証して初めて権限保証になる。
 * DM 実行時は member 自体が無い（permissions が undefined）ので、常に拒否される。
 */
async function dispatchAdmin(interaction: DiscordInteraction): Promise<void> {
  if (!hasAdminPermission(interaction.member?.permissions)) {
    await replyText(interaction, 'このコマンドは管理者のみ使用できます');
    return;
  }

  const sub = getSubcommand(interaction.data);
  if (!sub) {
    await replyText(interaction, 'エラーが発生しました');
    return;
  }

  switch (sub.name) {
    case SUB_ADMIN_THRESHOLD_SET:
      await handleAdminThresholdSet(interaction, sub.options);
      return;
    case SUB_ADMIN_THRESHOLD_REMOVE:
      await handleAdminThresholdRemove(interaction, sub.options);
      return;
    case SUB_ADMIN_TOP_ROLE_SET:
      await handleAdminTopRoleSet(interaction, sub.options);
      return;
    case SUB_ADMIN_CHANNEL_SET:
      await handleAdminChannelSet(interaction, sub.options);
      return;
    case SUB_ADMIN_SHOW:
      await handleAdminShow(interaction);
      return;
    case SUB_ADMIN_RECALC:
      await handleAdminRecalc(interaction);
      return;
    default:
      await replyText(interaction, '未対応のコマンドです');
  }
}

async function dispatch(interaction: DiscordInteraction): Promise<void> {
  const discordId = getInteractionUserId(interaction);
  const userName = getInteractionUserName(interaction);

  if (!discordId || !userName) {
    // member/user のどちらも無いのは Discord 側の仕様上ほぼ起こらないはずだが、
    // 万一に備えてスタックトレース等は出さずに日本語エラーだけ返す。
    console.error('[worker] interaction has neither member nor user', JSON.stringify(interaction));
    await replyText(interaction, 'エラーが発生しました');
    return;
  }

  // `/run-admin` はトップレベルの別コマンド（サブコマンド名が /run と重複しないよう
  // commands.ts で管理しているが、コマンド名自体で明示的に分岐させておいたほうが安全）。
  if (interaction.data?.name === RUN_ADMIN_COMMAND_NAME) {
    await dispatchAdmin(interaction);
    return;
  }

  const sub = getSubcommand(interaction.data);
  if (!sub) {
    await replyText(interaction, 'エラーが発生しました');
    return;
  }

  switch (sub.name) {
    case SUB_ADD:
      await handleAdd(interaction, discordId, userName, sub.options);
      return;
    case SUB_LIST:
      await handleList(interaction, discordId);
      return;
    case SUB_DELETE:
      await handleDelete(interaction, discordId, sub.options);
      return;
    case SUB_WEB:
      await handleWeb(interaction);
      return;
    case SUB_RANK:
      await handleRank(interaction, discordId, sub.options);
      return;
    case SUB_ME:
      await handleMe(interaction, discordId, userName, sub.options);
      return;
    default:
      await replyText(interaction, '未対応のコマンドです');
  }
}

export const handler = async (event: DiscordInteraction): Promise<void> => {
  try {
    await dispatch(event);
  } catch (err) {
    // 想定外の例外はログにだけ残し、スタックトレース等はユーザーに返さない。
    console.error('[worker] unhandled error', err);
    try {
      await followup(event.application_id, event.token, { content: 'エラーが発生しました' });
    } catch (followupErr) {
      console.error('[worker] failed to send error followup', followupErr);
    }
  }
};
