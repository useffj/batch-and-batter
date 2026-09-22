import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createHandler } from './api';
import { DynamoCatalogRepository } from './repository';

let repository: DynamoCatalogRepository | undefined;
export const handler = createHandler(() => {
  // Lazy initialization keeps health independent of DynamoDB and configuration.
  repository ??= new DynamoCatalogRepository(
    DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 2 })),
    process.env.CATALOG_TABLE_NAME ?? '',
  );
  return repository;
});
