import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

/**
 * API Gateway HTTP API (payload format 2.0) 向けの JSON レスポンスを組み立てる共通ヘルパー。
 * 各ハンドラで `Content-Type` ヘッダや JSON.stringify を書き散らさないようにする。
 */
export function jsonResponse(
  statusCode: number,
  body: unknown,
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}
