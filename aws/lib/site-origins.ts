import type { Node } from 'constructs';

/**
 * サイトのオリジン一覧を cdk.json の context から読む。
 *
 * 新旧ドメインを同時に受け入れる移行期間のため、context.siteOrigins（配列）を優先し、
 * 無ければ従来の context.siteOrigin（文字列）を 1 要素の配列として使う。
 * どちらも無ければ空配列を返す（既定値は呼び出し側が決める）。
 * 先頭が「正」のオリジンで、/run web が案内する URL に使う。
 */
export function readSiteOrigins(node: Node): string[] {
  const origins = node.tryGetContext('siteOrigins');
  if (Array.isArray(origins) && origins.length > 0) {
    return origins.filter((o): o is string => typeof o === 'string' && o !== '');
  }
  const single = node.tryGetContext('siteOrigin');
  return typeof single === 'string' && single !== '' ? [single] : [];
}
