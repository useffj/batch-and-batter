import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoCatalogRepository } from './repository';
import { ISOLATED_TABLE, isolatedCatalog } from './isolated-catalog';
import type { ApiEvent } from './api';
let repository: DynamoCatalogRepository | undefined;
const catalog = isolatedCatalog(
  () =>
    (repository ??= new DynamoCatalogRepository(
      DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-2' })),
      ISOLATED_TABLE,
    )),
);
export async function handler(event: ApiEvent) {
  if (
    process.env.CATALOG_TABLE_NAME !== ISOLATED_TABLE ||
    process.env.PAYMENT_START_ENABLED !== 'false'
  )
    return {
      statusCode: 503,
      headers: {
        'cache-control': 'no-store, private',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        code: 'CONFIGURATION',
        message: 'Isolated catalog unavailable.',
      }),
    };
  return catalog(event);
}
