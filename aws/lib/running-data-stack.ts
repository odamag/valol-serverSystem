import { Stack, StackProps, RemovalPolicy, Duration } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/**
 * ランニング記録ボットのデータ層（DynamoDB テーブル + 写真用 S3 バケット）。
 *
 * データを持つリソースは RunningApp（Lambda / API Gateway）とスタックを分け、
 * アプリ側を作り直しても誤ってテーブルやバケットを消してしまわないようにする。
 */
export class RunningDataStack extends Stack {
  /** ランニング記録・集計・nonce などを格納する単一テーブル */
  public readonly table: dynamodb.Table;
  /** ランニング記録に添付する写真を保存する S3 バケット */
  public readonly photoBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.table = new dynamodb.Table(this, 'Table', {
      tableName: 'running',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // nonce（Discord インタラクションの重複実行防止用など）を TTL で自動削除するための属性。
      // このテーブルには TTL 対象外のアイテムも同居するが、ttl 属性を持たないアイテムは削除されない。
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // GSI1: 月別集計（合計距離ランキングなど）を distanceM 順に引くためのインデックス。
    //
    // 重要: gsi1pk を持つのは「集計アイテム」だけにする設計なので、これはスパースGSIになる。
    // 記録アイテム（1回ごとのランニングログ）も distanceM 属性を持つが、gsi1pk を持たせないため
    // GSI1 には一切載らない。もし記録アイテムにまで gsi1pk を付けてしまうと、
    // 「1件ごとの記録」と「集計値」が同じインデックスに混在してランキングが壊れる。
    //
    // また、集計アイテムの distanceM は DynamoDB の ADD（UpdateExpression の加算）で更新する運用を想定している。
    // ADD で更新すると、ソートキーである distanceM の値自体が更新されるため GSI 側のソート順も自動的に追随する。
    // 「テーブル本体の集計値」と「GSI 用のインデックス値」を別々に持って二重管理する必要がない。
    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'distanceM', type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.photoBucket = new s3.Bucket(this, 'PhotoBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      cors: [
        {
          allowedOrigins: [
            // TODO: 本番ドメインが確定したら cdk.json の context.siteOrigin に本番オリジンを追加する。
            // 本番ドメイン未確定のため、いったんコンテキスト経由（既定値はローカル開発用オリジン）で管理する。
            this.node.tryGetContext('siteOrigin') ?? 'http://localhost:5173',
          ],
          allowedMethods: [s3.HttpMethods.POST, s3.HttpMethods.PUT],
          allowedHeaders: ['*'],
        },
      ],
      lifecycleRules: [
        {
          // マルチパートアップロードが失敗・放置された場合の課金対策。
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
        {
          // 署名付きURLでのアップロード前段として使う一時置き場。1日で自動削除する。
          prefix: 'tmp/',
          expiration: Duration.days(1),
        },
      ],
      // 写真データも誤操作でスタックごと消えないようにする。
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }
}
