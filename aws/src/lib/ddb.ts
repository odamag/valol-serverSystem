import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// DynamoDB クライアントはモジュールスコープで1つだけ生成する。
// Lambda はコールドスタート以降、同一実行環境（コンテナ）内でモジュールを使い回すため、
// ハンドラ呼び出しのたびに new すると接続の再確立コストが毎回かかってしまう。
const client = new DynamoDBClient({});

export const ddb = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    // オプショナル項目（未設定なら undefined）を持つオブジェクトをそのまま Put/Update しても
    // エラーにならないよう、undefined のフィールドは書き込み対象から除外する。
    removeUndefinedValues: true,
  },
});

/** `aws/lib/running-app-stack.ts` が Lambda 環境変数として渡すテーブル名 */
export const TABLE_NAME = process.env.TABLE_NAME ?? '';
