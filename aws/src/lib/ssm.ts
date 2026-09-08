import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

// SSM クライアントもモジュールスコープで1つだけ生成する（ddb.ts と同じ理由）。
const client = new SSMClient({});

// パラメータ名 → 取得結果の Promise をキャッシュするマップ。
// Lambda の実行環境はコールドスタートをまたいでモジュールを使い回すため、
// ここでメモ化しておけば「同じコンテナが処理するリクエスト」については
// SSM への問い合わせが最初の1回だけで済み、レイテンシとAPIコストの両方を抑えられる。
// Promise 自体をキャッシュしているので、同時に複数リクエストが飛んできても
// 二重に GetParameter を呼ぶことはない。
const cache = new Map<string, Promise<string>>();

/**
 * `SSM_PREFIX`（例: `/running/`）配下の SecureString パラメータを取得する。
 * @param suffix パラメータ名の prefix 以降の部分（例: 'proxy-shared-secret'）
 */
export function getRunningParameter(suffix: string): Promise<string> {
  const prefix = process.env.SSM_PREFIX ?? '/running/';
  const name = prefix + suffix;

  const cached = cache.get(name);
  if (cached) {
    return cached;
  }

  const promise = client
    .send(new GetParameterCommand({ Name: name, WithDecryption: true }))
    .then((res) => {
      const value = res.Parameter?.Value;
      if (!value) {
        throw new Error(`SSM parameter ${name} has no value`);
      }
      return value;
    })
    .catch((err) => {
      // 取得に失敗した Promise をキャッシュに残したままにすると、
      // 一時的な障害（SSMの瞬断など）から永久に回復できなくなってしまうため、
      // 失敗時はキャッシュから消して次回呼び出しでリトライできるようにする。
      cache.delete(name);
      throw err;
    });

  cache.set(name, promise);
  return promise;
}
