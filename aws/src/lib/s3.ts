// ランニング記録の写真（S3）を扱う層。document/running_api.md §5 の契約を実装する。
//
// バケット自体の設定（BLOCK_ALL、CORS、tmp/ の1日ライフサイクル）は aws/lib/running-data-stack.ts、
// Lambda への読み書き権限の付与は aws/lib/running-app-stack.ts 側で完結している。
// この層は「どう安全にアップロード・確定・配信するか」のロジックだけに責務を絞る。

import { randomUUID } from 'node:crypto';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// S3 クライアントもモジュールスコープで1つだけ生成する（ddb.ts と同じ理由: Lambda のコールドスタート
// 以降は同一実行環境でモジュールを使い回すため、ハンドラ呼び出しのたびに new すると無駄なコストがかかる）。
const s3 = new S3Client({});

/** `aws/lib/running-app-stack.ts` が Lambda 環境変数として渡す写真用バケット名 */
const BUCKET = process.env.PHOTO_BUCKET ?? '';

/** 許容する画像アップロードの最大バイト数（8MB）。API側の署名条件・Discord添付側の検証の両方で共有する。 */
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

const ALLOWED_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
type AllowedContentType = (typeof ALLOWED_CONTENT_TYPES)[number];

/**
 * アップロードを許可する画像 Content-Type かどうかを判定する純粋関数。
 * Web からの POST /v1/records/<id>/photo-url と、Discord 添付画像の検証の両方から呼ぶことで、
 * 「許可する画像形式」の定義を1箇所に集約する。
 */
export function isAllowedImageContentType(contentType: unknown): contentType is AllowedContentType {
  return typeof contentType === 'string' && (ALLOWED_CONTENT_TYPES as readonly string[]).includes(contentType);
}

/**
 * key が「discordId 本人の、recordId 用の tmp/ オブジェクト」であることを検証する純粋関数。
 *
 * これが commitPhoto における最重要のセキュリティチェックである理由:
 * POST /v1/records/<id>/photo-url で発行した署名付きPOSTの key はサーバー側で組み立てているが、
 * 確定処理（POST /v1/records/<id>/photo）にはクライアントが「これが自分がアップロードしたkeyです」
 * と自己申告した値がそのまま届く。ここを甘く検証すると、他人の discordId/recordId 配下の key や
 * '..' を使ったパス操作、あるいは既に確定済みの photos/ 配下の key を送りつけられ、
 * 他人の写真を自分の記録にコピーさせたり、無関係なオブジェクトを操作させられたりしてしまう。
 * そのため「tmp/<discordId>/<recordId>/ の直下、1階層だけ」を厳密一致で要求する。
 */
export function isOwnTmpKey(key: string, discordId: string, recordId: string): boolean {
  if (!key || key.includes('..')) return false;
  const prefix = `tmp/${discordId}/${recordId}/`;
  if (!key.startsWith(prefix)) return false;
  const rest = key.slice(prefix.length);
  // 直下のファイル名1つだけを許可する。'/' を含む＝さらに下の階層に潜ろうとしている、は拒否する。
  return rest.length > 0 && !rest.includes('/');
}

export interface PhotoUploadPost {
  url: string;
  fields: Record<string, string>;
  key: string;
}

/**
 * POST /v1/records/<id>/photo-url。S3 への署名付きアップロード情報を発行する。
 *
 * 署名付き PUT ではなく POST（createPresignedPost）を使う理由:
 * S3 の署名付き PUT URL は「このURLへの書き込みを許可する」という以上の制約をURL自体に埋め込めず、
 * content-length-range のようなサイズ上限をサーバー側の署名で強制することができない。
 * そのため PUT だと、署名済みURLさえ入手すれば任意サイズの巨大ファイルを投げ込み放題になってしまう
 * （8MBまでのつもりが数GBのアップロードを許してしまうと、ストレージ課金・帯域の両面で危険）。
 * 一方 POST の Policy には Conditions として content-length-range を埋め込め、
 * S3 自身がリクエストの時点で「1〜8MBを超えるアップロードは拒否する」を強制してくれる。
 */
export async function createPhotoUploadPost(
  discordId: string,
  recordId: string,
  contentType: string,
): Promise<PhotoUploadPost> {
  const key = `tmp/${discordId}/${recordId}/${randomUUID()}`;

  const { url, fields } = await createPresignedPost(s3, {
    Bucket: BUCKET,
    Key: key,
    Expires: 300,
    Conditions: [
      ['content-length-range', 1, MAX_PHOTO_BYTES],
      ['starts-with', '$Content-Type', 'image/'],
    ],
    Fields: {
      'Content-Type': contentType,
    },
  });

  return { url, fields, key };
}

export type CommitPhotoResult = { ok: true; key: string } | { ok: false; message: string };

/**
 * POST /v1/records/<id>/photo。tmp/ の一時オブジェクトを検証したうえで photos/ へ確定させる。
 * 1. isOwnTmpKey で key の所有者・形式を検証（最重要のセキュリティチェック）
 * 2. HeadObject で実在・サイズ・Content-Type を検証（署名済みPOSTの条件をすり抜けた/改ざんされた
 *    リクエストがあっても、確定処理の入口でもう一度サーバー側から検証し直す）
 * 3. photos/ へ CopyObject（コピー先は discordId/recordId ごとに独立した新しいUUID）
 * 4. tmp/ の元オブジェクトを削除
 */
export async function commitPhoto(discordId: string, recordId: string, key: string): Promise<CommitPhotoResult> {
  if (!isOwnTmpKey(key, discordId, recordId)) {
    return { ok: false, message: '不正なアップロードです' };
  }

  let contentLength: number | undefined;
  let contentType: string | undefined;
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    contentLength = head.ContentLength;
    contentType = head.ContentType;
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } } | undefined)?.$metadata?.httpStatusCode;
    if (status === 404) {
      return { ok: false, message: 'アップロードされた画像が見つかりません（時間切れの可能性があります）' };
    }
    throw err;
  }

  if (!contentLength || contentLength > MAX_PHOTO_BYTES) {
    return { ok: false, message: '画像は8MBまでです' };
  }
  if (!contentType || !contentType.startsWith('image/')) {
    return { ok: false, message: '画像形式が正しくありません' };
  }

  // discordId・recordId は Discord のスノーフレークID・記録IDの正規表現（RECORD_ID_PATTERN）由来で
  // URLエンコードが必要な文字を含まないため、CopySource は単純な文字列連結で組み立てて問題ない
  // （encodeURIComponent で全体をエンコードすると内部の '/' まで %2F になり、逆に壊れてしまう）。
  const destKey = `photos/${discordId}/${recordId}/${randomUUID()}`;
  await s3.send(
    new CopyObjectCommand({
      Bucket: BUCKET,
      CopySource: `${BUCKET}/${key}`,
      Key: destKey,
    }),
  );

  // tmp/ 側の削除に失敗しても致命的ではない（ライフサイクルルールで1日後には自動削除される）ため、
  // ログに残すだけに留めて確定処理自体は成功として扱う。
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch (err) {
    console.error('[s3] failed to delete tmp object after commit', err);
  }

  return { ok: true, key: destKey };
}

/**
 * 記録一覧・詳細に載せる署名付き GET URL を発行する。有効期限1時間（document/running_api.md §3）。
 *
 * getSignedUrl はローカルでの HMAC 署名計算のみを行い、AWS API を一切呼び出さない
 * （実際にオブジェクトを読みに行くのは、この URL を受け取ったブラウザが直接 S3 に対して行う）。
 * そのため GET /v1/records で一覧20件分の photoUrl をまとめて署名しても、追加の API 呼び出し課金や
 * レイテンシは発生しない。だからこそ「表示のたびに毎回署名し直す」というキャッシュ無しの
 * シンプルな実装のままで問題ない。
 */
export async function getPhotoUrl(key: string): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: 3600 });
}

/** 記録の削除・写真の差し替え時に呼ぶ。対象が既に存在しなくても S3 の DeleteObject はエラーにならない。 */
export async function deletePhoto(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

/**
 * Discord添付画像を tmp/ を経由せず直接 photos/ に保存する（worker.ts から使う）。
 *
 * Discord の添付URLは署名付きで期限が切れるCDN URLのため、そのまま DynamoDB に保存すると
 * 期限切れ後に画像が表示できなくなってしまう。そのため WorkerFn がその場でダウンロードした実体を
 * 自前の S3 バケットへ保存し直す。呼び出し時点で既にサイズ・Content-Type は検証済みの実体を
 * 置くだけなので、Web側のような「確定前の一時置き場（tmp/）」を経由する必要はない。
 */
export async function putDiscordPhoto(
  discordId: string,
  recordId: string,
  contentType: string,
  body: Uint8Array,
): Promise<string> {
  const key = `photos/${discordId}/${recordId}/${randomUUID()}`;
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
  return key;
}
