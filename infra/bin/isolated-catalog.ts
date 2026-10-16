import { App } from 'aws-cdk-lib';
import { IsolatedCatalogStack } from '../lib/isolated-catalog-stack';
new IsolatedCatalogStack(new App(), 'batch-and-batter-dev-isolated-catalog');
