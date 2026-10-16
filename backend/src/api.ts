import { type Refunds } from './refunds';
import { refundInput } from './refund-domain';
const refundRoutes = [
  'GET /admin/orders/{orderId}/refunds',
  'POST /admin/orders/{orderId}/refunds/authorize',
  'POST /admin/orders/{orderId}/refunds/reconcile',
];
import { requestInput, reviewInput } from './cancellation-requests';
import {
  GuestOrders,
  guestToken,
  pickupChangeInput,
  accessAdminInput,
} from './guest-orders';
import { z } from 'zod';
import type { AdminNotifications } from './admin-notifications';
import {
  adminCustomers,
  customerRoutes,
  type AdminCustomers,
} from './admin-customers';
import {
  adminFulfillment,
  fulfillmentRoutes,
  type FulfillmentRepository,
} from './admin-fulfillment';
import { adminOrders, orderRoutes, type AdminOrders } from './admin-orders';
import { adminWeekly, weeklyRoutes } from './admin-weekly';
import type { MediaOrchestration } from './media-orchestration';
import {
  adminMedia,
  mediaRoutes,
  type MediaApiRepository,
} from './admin-media';
import { adminScheduled, scheduledRoutes } from './admin-scheduled';
import { handler as health } from './health';
import { cartApi, cartRoutes } from './cart-api';
import type { CartService } from './cart-repository';
import { idSchema } from './domain';
import { CatalogWriteError, type CatalogRepository } from './repository';
import { AdminError, requireAdmin } from './admin-auth';
import { adminCatalog, catalogRoutes } from './admin-catalog';
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
    http: { method: string; sourceIp?: string };
    authorizer?: { jwt?: { claims?: Record<string, unknown> } };
  };
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined>;
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
  getMedia: () => MediaApiRepository = () => {
    throw new AdminError(
      503,
      'MEDIA_STORAGE_UNAVAILABLE',
      'Media metadata is unavailable.',
    );
  },
  getMediaServices: () => MediaOrchestration | undefined = () => undefined,
  getOrders: () => AdminOrders = () => {
    throw new Error('Orders unavailable');
  },
  getFulfillment: () => FulfillmentRepository = () => {
    throw Error('Fulfillment unavailable');
  },
  getCustomers: () => AdminCustomers = () => {
    throw Error('Customers unavailable');
  },
  getNotifications: () => AdminNotifications = () => {
    throw Error('Notifications unavailable');
  },
  getGuestOrders: () => GuestOrders = () => {
    throw Error('Guest orders unavailable');
  },
  getRefunds: () => Refunds = () => {
    throw new AdminError(
      503,
      'REFUNDS_DISABLED',
      'Refund execution is not activated.',
    );
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
    if (
      [
        'POST /orders/manage/view',
        'POST /orders/manage/pickup',
        'POST /orders/manage/request',
      ].includes(event.routeKey)
    ) {
      try {
        const guest = getGuestOrders();
        await guest.rateLimit(event.requestContext.http.sourceIp ?? '');
        if (
          event.isBase64Encoded ||
          !event.body ||
          Buffer.byteLength(event.body) > 2048 ||
          Object.keys(event.queryStringParameters ?? {}).length
        )
          throw new AdminError(400, 'INVALID_REQUEST', 'Invalid request.');
        let data: unknown;
        try {
          data = JSON.parse(event.body);
        } catch {
          throw new AdminError(400, 'INVALID_REQUEST', 'Invalid request.');
        }
        if (event.routeKey.endsWith('/view')) {
          const parsed = z.strictObject({ token: guestToken }).safeParse(data);
          if (!parsed.success)
            return error(
              403,
              'ORDER_ACCESS_UNAVAILABLE',
              'This order link is unavailable or expired.',
            );
          return json(200, await guest.view(parsed.data.token));
        }
        if (event.routeKey.endsWith('/request')) {
          const parsed = z
            .strictObject({ token: guestToken, request: requestInput })
            .safeParse(data);
          if (!parsed.success)
            return error(400, 'INVALID_REQUEST', 'Invalid request.');
          return json(
            200,
            await guest.requestCancellation(
              parsed.data.token,
              parsed.data.request,
            ),
          );
        }
        const parsed = pickupChangeInput.safeParse(data);
        if (!parsed.success)
          return error(400, 'INVALID_REQUEST', 'Invalid request.');
        return json(200, await guest.change(parsed.data));
      } catch (e) {
        return error(
          e instanceof AdminError ? e.status : 503,
          e instanceof AdminError ? e.code : 'UNAVAILABLE',
          e instanceof AdminError
            ? e.message
            : 'Order management is temporarily unavailable.',
        );
      }
    }
    if (event.routeKey === 'GET /health') return complete(await health());
    if (
      refundRoutes.includes(event.routeKey) ||
      [
        'GET /admin/orders/{orderId}/requests',
        'POST /admin/orders/{orderId}/requests/review',
        'GET /admin/orders/{orderId}/access',
        'POST /admin/orders/{orderId}/access/reissue',
        'POST /admin/orders/{orderId}/access/revoke',
      ].includes(event.routeKey) ||
      event.routeKey === 'GET /admin/orders/{orderId}/notifications' ||
      customerRoutes.includes(event.routeKey) ||
      fulfillmentRoutes.includes(event.routeKey) ||
      orderRoutes.includes(event.routeKey) ||
      weeklyRoutes.includes(event.routeKey) ||
      mediaRoutes.includes(event.routeKey) ||
      catalogRoutes.includes(event.routeKey) ||
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
        if (refundRoutes.includes(event.routeKey)) {
          const id = idSchema.safeParse(event.pathParameters?.orderId);
          if (
            !id.success ||
            Object.keys(event.queryStringParameters ?? {}).length
          )
            return error(400, 'INVALID_REQUEST', 'Invalid request.');
          if (event.routeKey.startsWith('GET'))
            return json(200, await getRefunds().view(id.data));
          if (
            event.isBase64Encoded ||
            !event.body ||
            Buffer.byteLength(event.body) > 2048
          )
            return error(400, 'INVALID_REQUEST', 'Invalid request.');
          let value: unknown;
          try {
            value = JSON.parse(event.body);
          } catch {
            return error(400, 'INVALID_REQUEST', 'Invalid request.');
          }
          if (event.routeKey.endsWith('/authorize')) {
            const parsed = refundInput.safeParse(value);
            if (!parsed.success)
              return error(400, 'INVALID_REQUEST', 'Invalid request.');
            return json(
              200,
              await getRefunds().authorize(
                id.data,
                parsed.data,
                identity.subject,
              ),
            );
          }
          if (
            !value ||
            typeof value !== 'object' ||
            Object.keys(value).join() !== 'operationId' ||
            !/^[a-f0-9-]{36}$/.test(
              String((value as { operationId?: unknown }).operationId),
            )
          )
            return error(400, 'INVALID_REQUEST', 'Invalid request.');
          return json(
            200,
            await getRefunds().run(
              id.data,
              (value as { operationId: string }).operationId,
            ),
          );
        }
        if (
          [
            'GET /admin/orders/{orderId}/requests',
            'POST /admin/orders/{orderId}/requests/review',
            'GET /admin/orders/{orderId}/access',
            'POST /admin/orders/{orderId}/access/reissue',
            'POST /admin/orders/{orderId}/access/revoke',
          ].includes(event.routeKey)
        ) {
          const id = idSchema.safeParse(event.pathParameters?.orderId);
          if (!id.success)
            return error(400, 'INVALID_REQUEST', 'Invalid request.');
          if (event.routeKey.startsWith('GET'))
            return json(
              200,
              event.routeKey.endsWith('/requests')
                ? await getGuestOrders().adminRequest(id.data)
                : await getGuestOrders().adminStatus(id.data),
            );
          if (
            event.isBase64Encoded ||
            !event.body ||
            Buffer.byteLength(event.body) > 2048
          )
            return error(400, 'INVALID_REQUEST', 'Invalid request.');
          let data: unknown;
          try {
            data = JSON.parse(event.body);
          } catch {
            return error(400, 'INVALID_REQUEST', 'Invalid request.');
          }
          if (event.routeKey.endsWith('/requests/review')) {
            const parsed = reviewInput.safeParse(data);
            if (!parsed.success)
              return error(400, 'INVALID_REQUEST', 'Invalid request.');
            return json(
              200,
              await getGuestOrders().reviewRequest(
                id.data,
                parsed.data,
                identity.subject,
              ),
            );
          }
          const parsed = accessAdminInput.safeParse(data);
          if (!parsed.success)
            return error(400, 'INVALID_REQUEST', 'Invalid request.');
          return json(
            200,
            await getGuestOrders().admin(
              id.data,
              event.routeKey.endsWith('/revoke') ? 'revoke' : 'reissue',
              parsed.data,
              identity.subject,
            ),
          );
        }
        if (event.routeKey === 'GET /admin/orders/{orderId}/notifications') {
          const orderId = event.pathParameters?.orderId ?? '';
          if (!(await getOrders().get(orderId)))
            return error(404, 'NOT_FOUND', 'Order not found.');
          return json(200, await getNotifications().status(orderId));
        }
        if (customerRoutes.includes(event.routeKey))
          return json(200, await adminCustomers(event, getCustomers()));
        if (fulfillmentRoutes.includes(event.routeKey))
          return json(
            200,
            await adminFulfillment(event, getFulfillment(), identity.subject),
          );
        if (orderRoutes.includes(event.routeKey))
          return json(200, await adminOrders(event, getOrders()));
        if (weeklyRoutes.includes(event.routeKey)) {
          const result = await adminWeekly(event, getRepository);
          return json(result.status, result.body);
        }
        if (mediaRoutes.includes(event.routeKey)) {
          const result = await adminMedia(
            event,
            getRepository,
            getMedia,
            identity.subject,
            getMediaServices(),
          );
          return json(result.status, result.body);
        }
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
        if (catalogRoutes.includes(event.routeKey)) {
          const result = await adminCatalog(
            event,
            getRepository,
            identity.subject,
          );
          return json(result.status, result.body);
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
                    : await adminWrite(event, getRepository, identity.subject);
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
