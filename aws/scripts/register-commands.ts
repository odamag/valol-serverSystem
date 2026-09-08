// Discord スラッシュコマンドを登録するスクリプト。
//
// PUT https://discord.com/api/v10/applications/{APP_ID}/guilds/{GUILD_ID}/commands
// で登録済みコマンドを一括上書きする。差分管理はしない（このリクエストに含まれないコマンドは
// Discord 側で自動的に削除される）ので、commands.ts のコマンド定義を唯一の正として運用できる。
// 逆に言うと、ここに並べ忘れたコマンドは Discord から消える（あるいは最初から出てこない）。
// commands.ts にコマンドを足したら、必ず COMMANDS にも足すこと。
//
// 実行方法: `npm run register`（aws/.env に DISCORD_APP_ID / DISCORD_GUILD_ID / DISCORD_BOT_TOKEN を
// 用意しておくこと。aws/.env.example を参照）。

import { RUN_COMMAND, RUN_ADMIN_COMMAND } from '../src/lib/commands';

// 登録するコマンドの全量。PUT は一括上書きなので、この配列に無いものは Discord から消える。
const COMMANDS = [RUN_COMMAND, RUN_ADMIN_COMMAND];

async function main(): Promise<void> {
  const appId = process.env.DISCORD_APP_ID;
  const guildId = process.env.DISCORD_GUILD_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;

  if (!appId || !guildId || !botToken) {
    console.error(
      'DISCORD_APP_ID / DISCORD_GUILD_ID / DISCORD_BOT_TOKEN が未設定です。aws/.env.example を参考に aws/.env を用意してください。',
    );
    process.exit(1);
    return;
  }

  const url = `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      authorization: `Bot ${botToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(COMMANDS),
  });

  const bodyText = await res.text();

  if (!res.ok) {
    // Discord のエラー詳細（どのフィールドが不正かなど）はレスポンスボディに入っているため必ず出す。
    console.error(`コマンド登録に失敗しました: ${res.status} ${res.statusText}`);
    console.error(bodyText);
    process.exit(1);
    return;
  }

  console.log(`コマンド登録に成功しました: ${res.status}`);
  console.log(bodyText);
}

main().catch((err) => {
  console.error('予期しないエラーが発生しました', err);
  process.exit(1);
});
