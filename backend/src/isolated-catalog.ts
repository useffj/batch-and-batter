import type { ApiEvent, ApiResponse } from './api';
import { AdminError, requireAdmin } from './admin-auth';
import { adminCatalog, catalogRoutes } from './admin-catalog';
import { adminWrite } from './admin-writes';
import { adminWeekly, weeklyRoutes } from './admin-weekly';
import { adminComposition } from './admin-composition';
import { CatalogWriteError, type CatalogRepository } from './repository';

import { isolatedRoutes } from './isolated-catalog-contract';
export { isolatedRoutes, ISOLATED_TABLE } from './isolated-catalog-contract';
const response = (statusCode: number, body: unknown): ApiResponse => ({
  statusCode,
  headers: {
    'content-type': 'application/json',
    'cache-control': 'no-store, private',
  },
  body: JSON.stringify(body),
});
// This router deliberately does not import the general API implementation.
export function isolatedCatalog(getRepository: () => CatalogRepository) {
  return async (event: ApiEvent): Promise<ApiResponse> => {
    if (
      !event ||
      !isolatedRoutes.includes(
        event.routeKey as (typeof isolatedRoutes)[number],
      ) ||
      event.requestContext?.http?.method !== event.routeKey.split(' ')[0]
    )
      return response(404, {
        code: 'NOT_FOUND',
        message: 'Route unavailable.',
      });
    try {
      const identity = requireAdmin(event);
      if (event.routeKey === 'GET /admin/me') return response(200, identity);
      if (event.routeKey === 'GET /admin/storefront/assignment')
        return response(200, { dropId: null });
      let result;
      if (catalogRoutes.includes(event.routeKey))
        result = await adminCatalog(event, getRepository, identity.subject);
      else if (weeklyRoutes.includes(event.routeKey))
        result = await adminWeekly(event, getRepository);
      else if (
        event.routeKey.endsWith('/composition') ||
        event.routeKey.endsWith('/preview')
      ) {
        result = await adminComposition(event, getRepository);
        if (event.routeKey.endsWith('/preview')) {
          if (!('drop' in result.body) || result.body.drop?.status !== 'DRAFT')
            throw new AdminError(
              409,
              'DRAFT_REQUIRED',
              'Preview requires a saved draft.',
            );
          return response(200, {
            ...result.body,
            preview: true,
            actionsEnabled: false,
          });
        }
      } else result = await adminWrite(event, getRepository, identity.subject);
      return response(result.status, result.body);
    } catch (error) {
      if (error instanceof AdminError)
        return response(error.status, {
          code: error.code,
          message: error.message,
        });
      if (error instanceof CatalogWriteError)
        return response(error.code.endsWith('NOT_FOUND') ? 404 : 409, {
          code: error.code,
          message: 'Catalog changed or is unavailable. Reload before retrying.',
        });
      return response(503, {
        code: 'UNAVAILABLE',
        message: 'Catalog temporarily unavailable.',
      });
    }
  };
}
