import { handler as health } from './health';
import { idSchema } from './domain';
import type { CatalogRepository } from './repository';
import { composeDrop, type CurrentDropResponse } from './storefront';

export interface ApiEvent {
  routeKey: string;
  requestContext: { requestId: string; http: { method: string } };
  pathParameters?: Record<string, string | undefined>;
}
export interface ApiResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}
function json(statusCode: number, body: unknown): ApiResponse {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
    body: JSON.stringify(body),
  };
}
export function createHandler(getRepository: () => CatalogRepository) {
  return async (event: ApiEvent): Promise<ApiResponse> => {
    const error = (status: number, code: string, message: string) =>
      json(status, {
        code,
        message,
        requestId: event.requestContext.requestId,
      });
    if (event.requestContext.http.method !== 'GET')
      return error(404, 'NOT_FOUND', 'Route not found.');
    if (event.routeKey === 'GET /health') return health();
    if (!['GET /drops/current', 'GET /drops/{dropId}'].includes(event.routeKey))
      return error(404, 'NOT_FOUND', 'Route not found.');
    const isCurrent = event.routeKey === 'GET /drops/current';
    const id = isCurrent
      ? undefined
      : idSchema.safeParse(event.pathParameters?.dropId);
    if (id && !id.success)
      return error(400, 'INVALID_DROP_ID', 'Invalid Drop ID.');
    try {
      const repository = getRepository();
      const drop = isCurrent
        ? await repository.getStorefrontDrop()
        : await repository.getDrop(id!.data!);
      const response = drop ? await composeDrop(repository, drop) : null;
      if (isCurrent)
        return json(200, { drop: response } satisfies CurrentDropResponse);
      return response
        ? json(200, { drop: response })
        : error(404, 'DROP_NOT_FOUND', 'Drop not found.');
    } catch {
      // Do not log records, SDK errors, credentials or customer data.
      console.error(
        JSON.stringify({
          event: 'catalog_read_failed',
          requestId: event.requestContext.requestId,
        }),
      );
      return error(500, 'INTERNAL_ERROR', 'Unable to load the Drop.');
    }
  };
}
