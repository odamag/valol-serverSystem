import * as path from 'path';
import { Stack, StackProps, Duration, CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import { CfnStage } from 'aws-cdk-lib/aws-apigatewayv2';
import { Construct } from 'constructs';

export interface RunningAppStackProps extends StackProps {
  /** RunningDataStack が公開する DynamoDB テーブル */
  table: dynamodb.Table;
  /** RunningDataStack が公開する写真用 S3 バケット */
  photoBucket: s3.Bucket;
}

/**
 * ランニング記録ボットのアプリケーション層。
 * Discord からのインタラクション受付、非同期ワーカー、Web API、月次バッチを Lambda で構成する。
 */
export class RunningAppStack extends Stack {
  constructor(scope: Construct, id: string, props: RunningAppStackProps) {
    super(scope, id, props);

    const { table, photoBucket } = props;

    // Discord のスラッシュコマンド関連の値は cdk.json の context から読む。
    // 未設定でも synth/deploy が壊れないよう、空文字をフォールバックにする（cdk.json 側にはプレースホルダを記載）。
    const discordAppId = this.node.tryGetContext('discordAppId') ?? '';
    const discordPublicKey = this.node.tryGetContext('discordPublicKey') ?? '';
    const discordGuildId = this.node.tryGetContext('discordGuildId') ?? '';
    // `/run web` が案内する Web版のベースURL。cdk.json の context から読む（未設定なら空文字）。
    const siteOrigin = this.node.tryGetContext('siteOrigin') ?? '';

    // Bot Token（DISCORD_BOT_TOKEN）はここには絶対に含めない。
    // Lambda の環境変数は `lambda:GetFunctionConfiguration` 権限さえあれば平文で読み出せてしまうため、
    // Bot Token のような長期的な秘密情報は環境変数ではなく SSM Parameter Store（SecureString）に置き、
    // 各関数は SSM_PREFIX 配下から実行時に取得する運用にする。
    const commonEnv: Record<string, string> = {
      TABLE_NAME: table.tableName,
      PHOTO_BUCKET: photoBucket.bucketName,
      DISCORD_APP_ID: discordAppId,
      DISCORD_PUBLIC_KEY: discordPublicKey,
      DISCORD_GUILD_ID: discordGuildId,
      SITE_ORIGIN: siteOrigin,
      SSM_PREFIX: '/running/',
    };

    // 4関数共通の設定をまとめるファクトリ。timeout とエントリポイントだけが関数ごとに異なる。
    const createFunction = (
      idName: string,
      entryFile: string,
      timeout: Duration,
      extraEnv?: Record<string, string>,
      extraProps?: Partial<lambda.FunctionOptions>,
    ): NodejsFunction => {
      // ロググループは明示的に作る。NodejsFunction の logRetention プロパティは
      // 「保持期間を設定するためだけのカスタムリソース Lambda」を裏で1本デプロイする仕組みで、
      // 非推奨になっているうえに余計な関数とIAMロールが増える。LogGroup を自分で作って
      // logGroup に渡せば、CloudFormation だけで完結する。
      const logGroup = new logs.LogGroup(this, `${idName}Logs`, {
        retention: logs.RetentionDays.TWO_WEEKS,
        // ログはスタックを消したら一緒に消えてよい（DynamoDB/S3 と違い保全対象ではない）
        removalPolicy: RemovalPolicy.DESTROY,
      });

      return new NodejsFunction(this, idName, {
        entry: path.join(__dirname, '..', 'src', 'handlers', entryFile),
        handler: 'handler',
        // nodejs20.x は 2026-04-30 に非推奨化済み（2027-02-01 に新規作成不可）。
        // 新規構築なので最新のマネージドランタイムを使う。
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 512,
        timeout,
        logGroup,
        bundling: {
          minify: true,
          sourceMap: false,
          target: 'node24',
        },
        environment: { ...commonEnv, ...extraEnv },
        // 暴走課金対策: Discord からの想定外の連投や不具合による無限リトライで
        // 一気に大量の同時実行が走らないよう、全関数に予約同時実行数の上限をかけておく。
        reservedConcurrentExecutions: 10,
        ...extraProps,
      });
    };

    // Worker を先に作る。Interactions が WORKER_FN 環境変数と invoke 権限を必要とするため。
    const workerDlq = new sqs.Queue(this, 'WorkerDlq', {
      // Worker が処理に失敗し続けたイベントを退避しておく。原因調査後に再実行する想定。
      retentionPeriod: Duration.days(14),
    });

    const workerFn = createFunction('WorkerFn', 'worker.ts', Duration.seconds(30), undefined, {
      deadLetterQueue: workerDlq,
    });

    const interactionsFn = createFunction(
      'InteractionsFn',
      'interactions.ts',
      Duration.seconds(5),
      { WORKER_FN: workerFn.functionName },
    );

    const apiFn = createFunction('ApiFn', 'api.ts', Duration.seconds(15));

    const schedulerFn = createFunction('SchedulerFn', 'scheduler.ts', Duration.minutes(2));

    // --- DynamoDB 権限 ---
    table.grantReadWriteData(workerFn);
    table.grantReadWriteData(apiFn);
    table.grantReadWriteData(schedulerFn);
    // Interactions は書き込みは行わず読み取りのみ。
    // スラッシュコマンドの autocomplete レスポンスは defer（一旦保留してあとで応答）できない仕様のため、
    // InteractionsFn 自身が同期的に DynamoDB を読んで候補を返す必要がある。そのため読み取り権限だけは付与する。
    table.grantReadData(interactionsFn);

    // Interactions は重い処理を Worker に丸投げして自分は素早く応答を返す（Discord は3秒でタイムアウトする）。
    workerFn.grantInvoke(interactionsFn);

    // --- S3 権限 ---
    photoBucket.grantReadWrite(apiFn);
    photoBucket.grantReadWrite(workerFn);

    // --- SSM 権限（Bot Token などの秘密情報を全関数が実行時に読み取れるようにする） ---
    const ssmReadStatement = new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/running/*`],
    });
    for (const fn of [interactionsFn, workerFn, apiFn, schedulerFn]) {
      fn.addToRolePolicy(ssmReadStatement);
    }

    // --- API Gateway (HTTP API) ---
    // CORS は設定しない: ブラウザからのアクセスは PHP プロキシ経由になる想定で、
    // このエンドポイントを直接叩くのは Discord（サーバー間通信）のみのため、ブラウザの CORS 制御は不要。
    const httpApi = new apigwv2.HttpApi(this, 'HttpApi');

    httpApi.addRoutes({
      path: '/discord/interactions',
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('InteractionsIntegration', interactionsFn),
    });

    httpApi.addRoutes({
      path: '/v1/{proxy+}',
      methods: [apigwv2.HttpMethod.ANY],
      integration: new HttpLambdaIntegration('ApiIntegration', apiFn),
    });

    // デフォルトステージにスロットリングを設定して、意図しない高頻度呼び出しによる暴走課金を防ぐ。
    const defaultStage = httpApi.defaultStage?.node.defaultChild as CfnStage;
    defaultStage.defaultRouteSettings = {
      throttlingRateLimit: 20,
      throttlingBurstLimit: 40,
    };

    // --- EventBridge Scheduler（月次ロールオーバー） ---
    const schedulerInvokeRole = new iam.Role(this, 'SchedulerInvokeRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });
    schedulerInvokeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [schedulerFn.functionArn],
      }),
    );

    new scheduler.CfnSchedule(this, 'MonthlyRollover', {
      name: 'MonthlyRollover',
      // 毎月1日 0:05（Asia/Tokyo）。0:00 ちょうどではなく5分ずらして、
      // 他の日次バッチ等との衝突を避ける。
      scheduleExpression: 'cron(5 0 1 * ? *)',
      scheduleExpressionTimezone: 'Asia/Tokyo',
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: schedulerFn.functionArn,
        roleArn: schedulerInvokeRole.roleArn,
        input: JSON.stringify({ job: 'monthly-rollover' }),
      },
    });

    new CfnOutput(this, 'HttpApiUrl', {
      value: httpApi.apiEndpoint,
      description: 'Discord Interactions Endpoint URL や API のベースURL。手順書内の各所で使う。',
    });
  }
}
