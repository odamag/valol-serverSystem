import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/**
 * GitHub Actions から長期のアクセスキーを使わずに CDK デプロイを行うための OIDC 連携スタック。
 *
 * GitHub Actions のワークフローが発行する OIDC トークンを AWS STS が検証し、
 * 一時的な認証情報だけを払い出す（AWS 側にシークレットを保存しない）。
 */
export class GithubOidcStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // リポジトリ名は cdk.json の context.githubRepo から読む（既定値: odamag/serverSystem）。
    const githubRepo = (this.node.tryGetContext('githubRepo') as string) ?? 'odamag/serverSystem';

    const provider = new iam.OpenIdConnectProvider(this, 'GithubOidcProvider', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });

    const deployRole = new iam.Role(this, 'GithubDeployRole', {
      roleName: 'github-cdk-deploy',
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
        StringLike: {
          // main ブランチへの push（＝main ブランチのワークフロー実行）からのみ引き受けを許可する。
          // PR やその他のブランチからは assume できない。
          'token.actions.githubusercontent.com:sub': `repo:${githubRepo}:ref:refs/heads/main`,
        },
      }),
    });

    // このロール自体には広い権限を持たせない。
    // 実際の作成・変更権限は CDK ブートストラップが用意する cdk-hnb659fds-* ロール群が持っているので、
    // このロールはそれらへ AssumeRole できるだけにとどめる（権限昇格の入口を最小限にする）。
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [
          `arn:aws:iam::${this.account}:role/cdk-hnb659fds-*-${this.account}-${this.region}`,
        ],
      }),
    );

    new CfnOutput(this, 'GithubDeployRoleArn', {
      value: deployRole.roleArn,
      description: 'GitHub Actions のワークフローで sts:AssumeRoleWithWebIdentity する対象ロール ARN',
    });
  }
}
