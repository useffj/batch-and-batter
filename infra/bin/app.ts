import { App } from 'aws-cdk-lib';
import { DevelopmentStack } from '../lib/development-stack';

const app = new App();
if (
  process.env.CDK_DEFAULT_ACCOUNT &&
  process.env.CDK_DEFAULT_ACCOUNT !== '302154194958'
)
  throw Error('WRONG_DEPLOYMENT_ACCOUNT');
// CDK supplies us-east-1 as an ambient fallback in credential-free CI.
// The stack target below is authoritative; do not adopt that fallback.
const environment: string = app.node.tryGetContext('environment') ?? 'dev';
new DevelopmentStack(app, `batch-and-batter-${environment}`, {
  environment,
  // Explicit approved DEV target; no account lookup required.
  env: {
    account: '302154194958',
    region: 'us-east-2',
  },
});
