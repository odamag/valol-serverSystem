// Discord Bot API 呼び出しの共通ヘルパー。
//
// Bot Token は Lambda の環境変数には置かない（running-app-stack.ts のコメント参照: 環境変数は
// lambda:GetFunctionConfiguration 権限さえあれば平文で読めてしまうため）。SSM Parameter Store の
// SecureString から実行時に取得する。

import { getRunningParameter } from './ssm';

const DISCORD_API_BASE = 'https://discord.com/api/v10';

/** Bot Token を SSM から取得する（getRunningParameter 側でプロセス内キャッシュされる）。 */
function getBotToken(): Promise<string> {
  return getRunningParameter('discord-bot-token');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 429 レスポンスのボディから retry_after（秒）を読み取る。取れなければ 1 秒とみなす。 */
async function readRetryAfterSeconds(res: Response): Promise<number> {
  try {
    const body = (await res.clone().json()) as { retry_after?: number };
    if (typeof body.retry_after === 'number' && body.retry_after > 0) {
      return body.retry_after;
    }
  } catch {
    // ボディが JSON でない/読めない場合はデフォルト値にフォールバックする。
  }
  return 1;
}

/**
 * Interaction への follow-up メッセージ送信・更新（deferred 応答の本編を埋める）。
 * PATCH /webhooks/{application_id}/{interaction_token}/messages/@original
 *
 * 重要: Interaction Token 自体が認可情報を兼ねるため、Bot Token（Authorizationヘッダ）は不要。
 * ここに Authorization を付けてしまうと逆に Discord 側で不正なリクエストとして扱われるため、
 * 絶対に付けないこと。
 */
export async function followup(
  applicationId: string,
  interactionToken: string,
  payload: unknown,
): Promise<void> {
  const url = `${DISCORD_API_BASE}/webhooks/${applicationId}/${interactionToken}/messages/@original`;

  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    // Discord のエラー詳細はレスポンスボディに入っているため、ここで拾っておかないとデバッグできない。
    const bodyText = await res.text().catch(() => '');
    console.error(`[discord-rest] followup failed: ${res.status} ${bodyText}`);
  }
}

/**
 * Bot Token 付きの Discord API 汎用呼び出し。Phase 3（ロール付与など）で使う想定で今のうちに用意する。
 * 429 (レート制限) を受けたら retry_after 秒待って最大3回までリトライする。
 */
export async function botFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getBotToken();
  const url = path.startsWith('http') ? path : `${DISCORD_API_BASE}${path}`;
  const maxRetries = 3;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        authorization: `Bot ${token}`,
        'content-type': 'application/json',
      },
    });

    if (res.status === 429 && attempt < maxRetries) {
      const retryAfterS = await readRetryAfterSeconds(res);
      await sleep(retryAfterS * 1000);
      continue;
    }

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      console.error(`[discord-rest] botFetch failed: ${res.status} ${path} ${bodyText}`);
    }

    return res;
  }

  // ループは必ず return するが、TypeScript には分からないため型合わせ用に到達しないパスを明示する。
  throw new Error('unreachable');
}
