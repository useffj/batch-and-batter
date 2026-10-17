import { App } from 'aws-cdk-lib';
import { IsolatedCatalogStack } from '../lib/isolated-catalog-stack';
const app = new App();
new IsolatedCatalogStack(
  app,
  'batch-and-batter-dev-isolated-catalog',
  app.node.tryGetContext('isolatedMedia') === 'true',
);
