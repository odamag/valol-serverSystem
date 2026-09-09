// Discord スラッシュコマンド `/run` の定義と、それに付随する共有ユーティリティを1箇所に集約する。
//
// register-commands.ts（コマンド登録）と interactions.ts / worker.ts（コマンド処理）の
// 両方からこのファイルを import することで、「登録したオプション名」と「処理側が読むオプション名」が
// 別々の場所で個別にタイポして食い違う、という事故を防ぐ。
//
// discord-api-types 等の外部パッケージには依存せず、このボットが実際に使うフィールドだけを
// 手書きの最小限の型として定義する（package.json に依存を増やさないため）。

import type { AggScope } from './keys';
import type { Weather } from './validate';

// ── Discord Application Command の型（register-commands.ts が PUT するJSONの形） ──────────
//
// ApplicationCommandOptionType（Discord API）:
//   1 = SUB_COMMAND, 3 = STRING, 4 = INTEGER, 7 = CHANNEL, 8 = ROLE, 10 = NUMBER, 11 = ATTACHMENT

export interface CommandChoice<T extends string = string> {
  name: string;
  value: T;
}

export interface ApplicationCommandOption {
  type: number;
  name: string;
  description: string;
  required?: boolean;
  autocomplete?: boolean;
  min_value?: number;
  max_value?: number;
  choices?: CommandChoice[];
  options?: ApplicationCommandOption[];
}

export interface ApplicationCommand {
  name: string;
  description: string;
  type: number; // 1 = CHAT_INPUT
  options?: ApplicationCommandOption[];
  // Phase 3: '/run-admin' 用。ADMINISTRATOR ビット（0x8）を渡すと、Discord のUI上は
  // 非管理者にコマンド自体が表示されなくなる。ただし、これはあくまでクライアント側の表示制御に
  // すぎず、サーバー側で権限を保証するものではないため、ハンドラ側（worker.ts）でも
  // interaction.member.permissions を必ず検証すること（hasAdminPermission 参照）。
  default_member_permissions?: string;
}

// ── コマンド名・サブコマンド名・オプション名の定数 ──────────────────────────────
// interactions.ts / worker.ts が生の文字列を書き散らさず、ここを import して参照する。

export const RUN_COMMAND_NAME = 'run';

export const SUB_ADD = 'add';
export const SUB_LIST = 'list';
export const SUB_DELETE = 'delete';
export const SUB_WEB = 'web';
export const SUB_RANK = 'rank';
export const SUB_ME = 'me';

export const OPT_DISTANCE = 'distance';
export const OPT_TIME = 'time';
export const OPT_DATE = 'date';
export const OPT_COURSE = 'course';
export const OPT_WEATHER = 'weather';
export const OPT_HR = 'hr';
export const OPT_KCAL = 'kcal';
export const OPT_MEMO = 'memo';
export const OPT_PHOTO = 'photo';
export const OPT_RECORD = 'record';
export const OPT_SCOPE = 'scope';
export const OPT_PERIOD = 'period';
export const OPT_MONTH = 'month';
export const OPT_PRIVATE = 'private';

// ── /run-admin（Phase 3: ロール自動付与の管理コマンド） ──────────────────────────

export const RUN_ADMIN_COMMAND_NAME = 'run-admin';

export const SUB_ADMIN_THRESHOLD_SET = 'threshold-set';
export const SUB_ADMIN_THRESHOLD_REMOVE = 'threshold-remove';
export const SUB_ADMIN_TOP_ROLE_SET = 'top-role-set';
export const SUB_ADMIN_CHANNEL_SET = 'channel-set';
export const SUB_ADMIN_SHOW = 'show';
export const SUB_ADMIN_RECALC = 'recalc';

export const OPT_KM = 'km';
export const OPT_ROLE = 'role';
export const OPT_CHANNEL = 'channel';

/** 天気の選択肢（表示は日本語、値は validate.ts の Weather と一致させる）。 */
export const WEATHER_CHOICES: CommandChoice<Weather>[] = [
  { name: '晴れ', value: 'sunny' },
  { name: '曇り', value: 'cloudy' },
  { name: '雨', value: 'rain' },
  { name: '雪', value: 'snow' },
  { name: '風強い', value: 'windy' },
  { name: '室内', value: 'indoor' },
];

/** WEATHER_CHOICES から値→日本語ラベルを逆引きする（Embed 表示用）。見つからなければ undefined。 */
export function weatherLabel(value: string | null | undefined): string | undefined {
  return WEATHER_CHOICES.find((c) => c.value === value)?.name;
}

/** ランキングの対象範囲の選択肢（表示は日本語、値は keys.ts の AggScope と一致させる）。 */
export const SCOPE_CHOICES: CommandChoice<AggScope>[] = [
  { name: '月間', value: 'month' },
  { name: '週間', value: 'week' },
  { name: '通算', value: 'total' },
];

/** SCOPE_CHOICES から値→日本語ラベルを逆引きする（Embed 表示用）。見つからなければ scope をそのまま返す。 */
export function scopeLabel(scope: AggScope): string {
  return SCOPE_CHOICES.find((c) => c.value === scope)?.name ?? scope;
}

/** `/run rank` の表示件数（上位何件を Embed に表示するか）。 */
export const RANK_DISPLAY_LIMIT = 10;

/** 1〜3位に付けるメダル絵文字。4位以降は空文字（呼び出し側で "順位." のような表記にフォールバックする）。 */
export function medalForRank(rank: number): string {
  switch (rank) {
    case 1:
      return '🥇';
    case 2:
      return '🥈';
    case 3:
      return '🥉';
    default:
      return '';
  }
}

// `/run list` に `page` オプションを設けない理由:
// listRecords（records.ts）はカーソル方式のページネーションであり、カーソルは
// 「直前のクエリの LastEvaluatedKey」を base64url 化しただけの不透明な値で、どこにも永続化されない。
// スラッシュコマンドの呼び出しは毎回ステートレスなので、「2ページ目」というリクエストが来ても
// 対応するカーソルをサーバー側が持っておらず、結局1ページ目しか返せない。
// 中途半端に page オプションだけ用意して実質機能しない実装にするより、コマンド定義自体から
// page を外し、常に直近 LIST_RECENT_LIMIT 件を返すだけのシンプルな実装にする方が利用者に誠実。
// より多くの記録を確認したい場合は `/run web` で Web 版を案内する。
export const LIST_RECENT_LIMIT = 10;

/** `/run` コマンドの全体定義（register-commands.ts が PUT するJSONの中身）。 */
export const RUN_COMMAND: ApplicationCommand = {
  name: RUN_COMMAND_NAME,
  description: 'ランニング記録を操作します',
  type: 1,
  options: [
    {
      type: 1, // SUB_COMMAND
      name: SUB_ADD,
      description: 'ランニング記録を追加します',
      options: [
        {
          type: 10, // NUMBER
          name: OPT_DISTANCE,
          description: '距離(km) 例: 5.2',
          required: true,
          min_value: 0.1,
          max_value: 300,
        },
        {
          type: 3, // STRING
          name: OPT_TIME,
          description: '時間 例: 26:30 / 1:05:12',
          required: true,
        },
        {
          type: 3,
          name: OPT_DATE,
          description: '日付 YYYY-MM-DD（既定: 今日）',
          autocomplete: true,
        },
        {
          type: 3,
          name: OPT_COURSE,
          description: 'コース名',
        },
        {
          type: 3,
          name: OPT_WEATHER,
          description: '天気',
          choices: WEATHER_CHOICES,
        },
        {
          type: 4, // INTEGER
          name: OPT_HR,
          description: '平均心拍数(bpm)',
          min_value: 30,
          max_value: 250,
        },
        {
          type: 4,
          name: OPT_KCAL,
          description: '消費カロリー',
          min_value: 1,
          max_value: 10000,
        },
        {
          type: 3,
          name: OPT_MEMO,
          description: 'メモ',
        },
        {
          type: 11, // ATTACHMENT
          name: OPT_PHOTO,
          description: '写真（PNG/JPEG/WebP, 8MBまで）',
        },
        {
          type: 5, // BOOLEAN
          name: OPT_PRIVATE,
          description: '自分にだけ表示する（既定: チャンネルに公開）',
        },
      ],
    },
    {
      type: 1,
      name: SUB_LIST,
      description: `直近${LIST_RECENT_LIMIT}件のランニング記録を表示します`,
      // page オプションを設けない理由は LIST_RECENT_LIMIT のコメントを参照。
      options: [],
    },
    {
      type: 1,
      name: SUB_DELETE,
      description: 'ランニング記録を削除します',
      options: [
        {
          type: 3,
          name: OPT_RECORD,
          description: '削除する記録',
          required: true,
          autocomplete: true,
        },
      ],
    },
    {
      type: 1,
      name: SUB_WEB,
      description: 'Web版のランニング記録ページを開きます',
      options: [],
    },
    {
      type: 1,
      name: SUB_RANK,
      description: 'ランキングを表示します',
      options: [
        {
          type: 3, // STRING
          name: OPT_SCOPE,
          description: '対象範囲（既定: 月間）',
          choices: SCOPE_CHOICES,
        },
        {
          type: 3,
          name: OPT_PERIOD,
          description: '対象期間 例: 2026-09（省略時は今期）',
        },
        {
          type: 5, // BOOLEAN
          name: OPT_PRIVATE,
          description: '自分にだけ表示する（既定: チャンネルに公開）',
        },
      ],
    },
    {
      type: 1,
      name: SUB_ME,
      description: '自分の集計・順位を表示します',
      options: [
        {
          type: 3,
          name: OPT_MONTH,
          description: '対象月 YYYY-MM（省略時は今月）',
        },
      ],
    },
  ],
};

/**
 * `/run-admin` コマンドの全体定義（Phase 3: 閾値ロール・月間1位ロールなどの管理用）。
 * default_member_permissions で ADMINISTRATOR を要求するが、これは表示制御のみなので
 * worker.ts 側でも hasAdminPermission による検証を必ず行う（ApplicationCommand のコメント参照）。
 */
export const RUN_ADMIN_COMMAND: ApplicationCommand = {
  name: RUN_ADMIN_COMMAND_NAME,
  description: 'ランニング記録ロールの管理コマンド（管理者用）',
  type: 1,
  default_member_permissions: '8', // ADMINISTRATOR ビット
  options: [
    {
      type: 1,
      name: SUB_ADMIN_THRESHOLD_SET,
      description: '距離達成ロールを設定します',
      options: [
        {
          type: 4, // INTEGER
          name: OPT_KM,
          description: '達成距離(km)',
          required: true,
          min_value: 1,
        },
        {
          type: 8, // ROLE
          name: OPT_ROLE,
          description: '付与するロール',
          required: true,
        },
      ],
    },
    {
      type: 1,
      name: SUB_ADMIN_THRESHOLD_REMOVE,
      description: '距離達成ロールの設定を削除します',
      options: [
        {
          type: 4,
          name: OPT_KM,
          description: '削除する達成距離(km)',
          required: true,
          min_value: 1,
        },
      ],
    },
    {
      type: 1,
      name: SUB_ADMIN_TOP_ROLE_SET,
      description: '月間1位ロールを設定します',
      options: [
        {
          type: 8, // ROLE
          name: OPT_ROLE,
          description: '月間1位に付与するロール',
          required: true,
        },
      ],
    },
    {
      type: 1,
      name: SUB_ADMIN_CHANNEL_SET,
      description: 'ロール達成の告知チャンネルを設定します',
      options: [
        {
          type: 7, // CHANNEL
          name: OPT_CHANNEL,
          description: '告知先チャンネル',
          required: true,
        },
      ],
    },
    {
      type: 1,
      name: SUB_ADMIN_SHOW,
      description: '現在のロール設定を表示します',
      options: [],
    },
    {
      type: 1,
      name: SUB_ADMIN_RECALC,
      description: '集計とロールを再計算して整合させます',
      options: [],
    },
  ],
};

// ── 時間・ペースのフォーマット / パース ────────────────────────────────────
// worker.ts（記録の登録・表示）と interactions.ts（削除候補のオートコンプリート表示）の
// 両方から使うため、ここに集約する。

/** 秒数を "mm:ss"（1時間未満）または "h:mm:ss"（1時間以上）に整形する。 */
export function formatClock(durationS: number): string {
  const h = Math.floor(durationS / 3600);
  const m = Math.floor((durationS % 3600) / 60);
  const s = durationS % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/** 秒/km のペースを "m:ss/km" に整形する。 */
export function formatPace(paceSPerKm: number): string {
  const m = Math.floor(paceSPerKm / 60);
  const s = paceSPerKm % 60;
  return `${m}:${String(s).padStart(2, '0')}/km`;
}

// "mm:ss" または "h:mm:ss" 形式の入力を許容する。
// mm:ss の分部分は 60 以上（例: "90:00" = 1時間30分）も許容するが、
// h:mm:ss の分・秒部分はそれぞれ 0-59 でなければならない。
const TIME_RE_HMS = /^(\d{1,3}):([0-5]\d):([0-5]\d)$/;
const TIME_RE_MS = /^(\d{1,4}):([0-5]\d)$/;

/**
 * ユーザーが `/run add` の `time` に入力した文字列を秒数に変換する。
 * パースできない形式なら null を返す（呼び出し側で日本語のエラーメッセージに変換すること）。
 */
export function parseClockToSeconds(input: string): number | null {
  const trimmed = input.trim();

  const hms = TIME_RE_HMS.exec(trimmed);
  if (hms) {
    const h = Number(hms[1]);
    const m = Number(hms[2]);
    const s = Number(hms[3]);
    return h * 3600 + m * 60 + s;
  }

  const ms = TIME_RE_MS.exec(trimmed);
  if (ms) {
    const m = Number(ms[1]);
    const s = Number(ms[2]);
    return m * 60 + s;
  }

  return null;
}

/**
 * `/run delete` のオートコンプリート候補の表示名を組み立てる。
 * Discord の制約（choice の name は100文字以内）を必ず守るため、超過分は切り詰める。
 */
export function formatRecordChoiceName(r: {
  runDate: string;
  distanceKm: number;
  durationS: number;
  course: string | null;
}): string {
  const mmdd = r.runDate.slice(5).replace('-', '/'); // "YYYY-MM-DD" -> "MM/DD"
  const parts = [mmdd, `${r.distanceKm}km`, formatClock(r.durationS)];
  if (r.course) parts.push(r.course);
  const name = parts.join(' ');
  return name.length > 100 ? `${name.slice(0, 99)}…` : name;
}

// ── Discord Interaction の型（受信側。必要な最小限のみ） ────────────────────────

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
}

export interface DiscordMember {
  user: DiscordUser;
  nick?: string | null;
  // ギルド内での実行時委任権限のビットフラグ。10進文字列で来る（Discord の仕様。ビット数が
  // JS の number の安全整数範囲を超えうるため、扱う側は必ず BigInt に変換すること）。
  // Phase 3 の /run-admin 権限チェック（hasAdminPermission, roles.ts）で使う。
  permissions?: string;
}

/** interaction.data.resolved に含まれるロール/チャンネルの最小表現（表示名の逆引き用）。 */
export interface DiscordResolvedRole {
  id: string;
  name: string;
}

export interface DiscordResolvedChannel {
  id: string;
  name: string;
}

/**
 * ATTACHMENT 型オプション（OPT_PHOTO）の値は snowflake の添付ID しか渡ってこないため、
 * 実体（URL・ファイル名・Content-Type・サイズ）はここから引く。
 * content_type は Discord 側が判定できなかった場合に省略されることがあるため optional。
 */
export interface DiscordResolvedAttachment {
  id: string;
  filename: string;
  content_type?: string;
  size: number;
  url: string;
}

export interface DiscordInteractionOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: DiscordInteractionOption[];
  /** オートコンプリート要求時、いま入力中の欄にだけ true が立つ。 */
  focused?: boolean;
}

export interface DiscordInteractionData {
  name: string;
  options?: DiscordInteractionOption[];
  // ROLE/CHANNEL 型のオプション値は snowflake の ID しか渡ってこないため、表示名が必要な場合
  // （/run-admin threshold-set 等でロール名を保存したいとき）はここから逆引きする。
  resolved?: {
    roles?: Record<string, DiscordResolvedRole>;
    channels?: Record<string, DiscordResolvedChannel>;
    attachments?: Record<string, DiscordResolvedAttachment>;
  };
}

export interface DiscordInteraction {
  id: string;
  application_id: string;
  type: number;
  token: string;
  guild_id?: string;
  channel_id?: string;
  /** ギルド内での実行時にセットされる。 */
  member?: DiscordMember;
  /** DM での実行時にセットされる（member とは排他）。 */
  user?: DiscordUser;
  data?: DiscordInteractionData;
}

/** data.options からトップレベルのサブコマンド名とそのオプション一覧を取り出す。 */
export function getSubcommand(
  data: DiscordInteractionData | undefined,
): { name: string; options: DiscordInteractionOption[] } | null {
  const sub = data?.options?.[0];
  if (!sub || sub.type !== 1) return null; // 1 = SUB_COMMAND
  return { name: sub.name, options: sub.options ?? [] };
}

export function findOption(
  options: DiscordInteractionOption[],
  name: string,
): DiscordInteractionOption | undefined {
  return options.find((o) => o.name === name);
}

/**
 * Interaction を発行したユーザーの discordId を取得する。
 * ギルド内なら member.user.id、DM なら user.id（document/running_api.md の想定どおり両対応する）。
 */
export function getInteractionUserId(interaction: DiscordInteraction): string | null {
  return interaction.member?.user.id ?? interaction.user?.id ?? null;
}

/**
 * Interaction を発行したユーザーの表示名を取得する。
 * ニックネーム > グローバル表示名 > ユーザー名 の優先順位（ギルド内）。
 * DM の場合は member が無いのでニックネームの概念が無く、グローバル表示名 > ユーザー名。
 */
export function getInteractionUserName(interaction: DiscordInteraction): string | null {
  if (interaction.member) {
    const u = interaction.member.user;
    return interaction.member.nick ?? u.global_name ?? u.username;
  }
  if (interaction.user) {
    return interaction.user.global_name ?? interaction.user.username;
  }
  return null;
}

/**
 * この interaction への応答を ephemeral（本人にのみ見える）にすべきかどうかを判定する。
 *
 * 重要な制約: ephemeral かどうかは interactions.ts が defer 応答（type=5）を返した時点で
 * 確定し、後から worker.ts の followup で変更することはできない（Discord の仕様）。
 * そのため、まだ DynamoDB を読んでいない・バリデーションもしていないこの時点、
 * つまり interactions.ts 側で「コマンド名とオプションだけ」を見て判断する必要がある。
 *
 * この判断の結果、`/run add` `/run rank` は private:true 以外では常に公開される。
 * つまりバリデーションエラー（例:「時間の形式が正しくありません」）も公開チャンネルに
 * 流れることになるが、エラーメッセージは短く自己説明的で、他人の個人情報を含まないため
 * 許容する方針とする（詳細は document/running_api.md §6）。
 *
 * `/run add` `/run rank` 以外の全コマンド（`/run list` `/run me` `/run delete` `/run web`、
 * `/run-admin` の全サブコマンド）は元から「本人のみで固定」であり、private オプション自体を
 * 持たない。また、未知のコマンド名や想定外の構造（data や options が欠けている等）が来た場合も
 * 必ず ephemeral（true）にフォールバックする。「公開すべきかどうか判断できないときは
 * 公開しない」方が安全側であり、誤って他人の記録やエラー内容をチャンネルに晒す事故を防げる。
 */
export function shouldBeEphemeral(interaction: DiscordInteraction): boolean {
  const sub = getSubcommand(interaction.data);
  if (!sub) return true; // data/options が無い、またはサブコマンド構造でない → 安全側で本人のみ

  if (interaction.data?.name !== RUN_COMMAND_NAME) return true; // /run-admin 等は常に本人のみ

  if (sub.name !== SUB_ADD && sub.name !== SUB_RANK) return true; // list/delete/web/me は常に本人のみ

  const privateOption = findOption(sub.options, OPT_PRIVATE);
  return privateOption?.value === true; // 省略時・false は公開、true のときだけ本人のみ
}
