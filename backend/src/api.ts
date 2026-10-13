import { adminScheduled, scheduledRoutes } from './admin-scheduled';
import { handler as health } from './health';
import { cartApi, cartRoutes } from './cart-api';
import type { CartService } from './cart-repository';
import { idSchema } from './domain';
import { CatalogWriteError, type CatalogRepository } from './repository';
import { AdminError, requireAdmin } from './admin-auth';
import { adminWrite, adminWriteRoutes } from './admin-writes';
import { adminComposition, compositionRoutes } from './admin-composition';
import { adminPublish, publishRoute } from './admin-publish';
import { adminOpen, openRoute } from './admin-open';
import { adminLifecycle, lifecycleRoutes } from './admin-lifecycle';
import {
  adminReconcileOpening,
  reconcileOpeningRoute,
} from './admin-reconcile-opening';
import type { OpeningSchedules } from './opening-schedules';
import { composeDrop, type CurrentDropResponse } from './storefront';
import { logCompletion, type InvocationContext } from './request-logging';

export interface ApiEvent {
  routeKey: string;
  requestContext: {
    requestId: string;
    http: { method: string };
    authorizer?: { jwt?: { claims?: Record<string, unknown> } };
  };
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  pathParameters?: Record<string, string | undefined>;
}
export interface ApiResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}
function jsonResponse(statusCode: number, body: unknown): ApiResponse {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
    body: JSON.stringify(body),
  };
}
export function createHandler(
  getRepository: () => CatalogRepository,
  getSchedules: () => OpeningSchedules = () => {
    throw new Error('Opening schedules are not configured');
  },
  getCarts: () => CartService = () => {
    throw new Error('Cart service is not configured');
  },
) {
  return async (
    event: ApiEvent,
    context?: InvocationContext,
  ): Promise<ApiResponse> => {
    const complete = (response: ApiResponse, code?: string) => {
      logCompletion(event, context, response, code);
      return response;
    };
    const json = (status: number, body: unknown) =>
      complete(jsonResponse(status, body));
    const error = (status: number, code: string, message: string) =>
      complete(
        jsonResponse(status, {
          code,
          message,
          requestId: event.requestContext.requestId,
        }),
        code,
      );
    if (event.routeKey.split(' ')[0] !== event.requestContext.http.method)
      return error(404, 'NOT_FOUND', 'Route not found.');
    if (cartRoutes.includes(event.routeKey))
      return cartApi(event, getCarts, context);
    if (event.routeKey === 'GET /health') return complete(await health());
    if (
      event.routeKey === 'GET /admin/me' ||
      event.routeKey === 'GET /admin/storefront/assignment' ||
      adminWriteRoutes.includes(event.routeKey) ||
      compositionRoutes.includes(event.routeKey) ||
      event.routeKey === publishRoute ||
      event.routeKey === openRoute ||
      event.routeKey === reconcileOpeningRoute ||
      lifecycleRoutes.includes(event.routeKey) ||
      scheduledRoutes.includes(event.routeKey)
    ) {
      try {
        const identity = requireAdmin(event);
        if (event.routeKey === 'GET /admin/me') return json(200, identity);
        if (event.routeKey === 'GET /admin/storefront/assignment') {
          const repository = getRepository();
          const dropId = await repository.getStorefrontDropId();
          if (dropId === undefined) return json(200, { dropId: null });
          if (!(await repository.getDrop(dropId)))
            return error(
              409,
              'BROKEN_STOREFRONT_ASSIGNMENT',
              'The assigned Drop could not be found.',
            );
          return json(200, { dropId });
        }
        const result = scheduledRoutes.includes(event.routeKey)
          ? await adminScheduled(
              event,
              getRepository,
              getSchedules,
              identity.subject,
            )
          : lifecycleRoutes.includes(event.routeKey)
            ? await adminLifecycle(event, getRepository)
            : event.routeKey === reconcileOpeningRoute
              ? await adminReconcileOpening(event, getRepository, getSchedules)
              : event.routeKey === openRoute
                ? await adminOpen(event, getRepository)
                : event.routeKey === publishRoute
                  ? await adminPublish(event, getRepository, getSchedules)
                  : compositionRoutes.includes(event.routeKey)
                    ? await adminComposition(event, getRepository)
                    : await adminWrite(event, getRepository);
        return json(result.status, result.body);
      } catch (failure) {
        if (failure instanceof AdminError)
          return error(failure.status, failure.code, failure.message);
        if (failure instanceof CatalogWriteError) {
          const messages = {
            STALE_OPENING: 'Opening work has been superseded.',
            DROP_NOT_READY:
              event.routeKey === openRoute ||
              event.routeKey === 'POST /admin/drops/{dropId}/resume'
                ? 'Drop is not ready to open.'
                : 'Drop is not ready to publish.',
            STOREFRONT_CONFLICT: 'Drop is not assigned to the storefront.',
            STOREFRONT_OCCUPIED:
              'Another Drop is currently assigned to the storefront.',
            DROP_PRODUCT_NOT_FOUND: 'Drop product not found.',
            PICKUP_NOT_FOUND: 'Pickup date not found.',
            DROP_PRODUCT_CONFLICT: 'Drop product already exists.',
            INVENTORY_NOT_EDITABLE:
              'Inventory with reservations or sales cannot be edited.',
            COMPOSITION_CONFLICT:
              'Composition changed or is inconsistent. Reload before retrying.',
            PRODUCT_NOT_FOUND: 'Product not found.',
            DROP_NOT_FOUND: 'Drop not found.',
            PRODUCT_CONFLICT: 'Product changed or already exists.',
            DROP_CONFLICT: 'Drop changed or already exists.',
            DROP_NOT_EDITABLE: scheduledRoutes.includes(event.routeKey)
              ? 'Only future SCHEDULED Drops can be changed or canceled.'
              : lifecycleRoutes.includes(event.routeKey)
                ? 'Drop status does not allow this operation.'
                : event.routeKey === openRoute
                  ? 'Only SCHEDULED Drops can be opened.'
                  : 'Only DRAFT Drops can be edited.',
          };
          return error(
            failure.code.endsWith('NOT_FOUND') ? 404 : 409,
            failure.code,
            messages[failure.code],
          );
        }
        return error(500, 'INTERNAL_ERROR', 'Unable to complete the request.');
      }
    }
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
      return error(500, 'INTERNAL_ERROR', 'Unable to load the Drop.');
    }
  };
}
