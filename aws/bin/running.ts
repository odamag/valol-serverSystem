#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { RunningDataStack } from '../lib/running-data-stack';
import { RunningAppStack } from '../lib/running-app-stack';
import { GithubOidcStack } from '../lib/github-oidc-stack';

const app = new cdk.App();

const env = {
  // アカウントは実行環境（CLI プロファイル / OIDC で引き受けたロール）から取得する。
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: 'ap-northeast-1',
};

const dataStack = new RunningDataStack(app, 'RunningData', { env });

// RunningApp は RunningData が公開する table / photoBucket を props 経由で受け取る。
// スタックをまたいだ参照になるため、CloudFormation の Export/Import（もしくは同一 App 内の直接参照）が発生する。
new RunningAppStack(app, 'RunningApp', {
  env,
  table: dataStack.table,
  photoBucket: dataStack.photoBucket,
});

new GithubOidcStack(app, 'RunningGithubOidc', { env });
