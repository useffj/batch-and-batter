import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoCatalogRepository } from './repository';
import { ISOLATED_TABLE, isolatedCatalog } from './isolated-catalog';
import { adminMedia, mediaRoutes } from './admin-media';
import { AdminError, requireAdmin } from './admin-auth';
import { isolatedMedia, type IsolatedMedia } from './isolated-media';
import type { ApiEvent, ApiResponse } from './api';
import type { CatalogRepository } from './repository';
export function mediaCatalog(
  getCatalog: () => CatalogRepository,
  getMedia: () => IsolatedMedia,
) {
  const base = isolatedCatalog(getCatalog);
  return async (event: ApiEvent): Promise<ApiResponse> => {
    if (!mediaRoutes.includes(event?.routeKey)) return base(event);
    try {
      if (event.requestContext?.http?.method !== event.routeKey.split(' ')[0])
        throw new AdminError(405, 'VALIDATION_ERROR', 'Invalid method.');
      const identity = requireAdmin(event),
        media = getMedia();
      if (
        event.routeKey.endsWith('/assets/{mediaId}') &&
        event.queryStringParameters?.view === 'image'
      )
        return await media.image(event, getCatalog);
      const r = await adminMedia(
        event,
        getCatalog,
        () => media.repository,
        identity.subject,
        media.services,
      );
      return {
        statusCode: r.status,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store, private',
        },
        body: JSON.stringify(r.body),
      };
    } catch (e) {
      return {
        statusCode: e instanceof AdminError ? e.status : 503,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store, private',
        },
        body: JSON.stringify({
          code: e instanceof AdminError ? e.code : 'MEDIA_STORAGE_UNAVAILABLE',
          message: 'Media request unavailable.',
        }),
      };
    }
  };
}
let repository: DynamoCatalogRepository | undefined;
const router = mediaCatalog(
  () =>
    (repository ??= new DynamoCatalogRepository(
      DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-2' })),
      ISOLATED_TABLE,
    )),
  () => isolatedMedia(process.env),
);
export async function handler(event: ApiEvent) {
  if (
    process.env.CATALOG_TABLE_NAME !== ISOLATED_TABLE ||
    process.env.PAYMENT_START_ENABLED !== 'false'
  )
    return {
      statusCode: 503,
      headers: { 'cache-control': 'no-store, private' },
      body: '{"code":"CONFIGURATION"}',
    };
  return router(event);
}
