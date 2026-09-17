import { App } from 'aws-cdk-lib';
import { DevelopmentStack } from '../lib/development-stack';

const app = new App();
const environment: string = app.node.tryGetContext('environment') ?? 'dev';
new DevelopmentStack(app, `batch-and-batter-${environment}`, {
  environment,
  // Unset for account/Region-agnostic local synthesis; normal CDK values later.
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
