import type { Refunds } from './refunds';
import { GuestOrders } from './guest-orders';
import { AdminNotifications } from './admin-notifications';
import { AdminCustomers } from './admin-customers';
import { FulfillmentRepository } from './admin-fulfillment';
import { AdminOrders } from './admin-orders';
import { MediaRepository } from './media-repository';
import type { MediaApiRepository } from './admin-media';
import { createPaymentHttp } from './payment-http-runtime';
import { SQSClient } from '@aws-sdk/client-sqs';
import { SqsExpiryDispatch } from './cart-expiry';
import { DynamoCartRepository, type CartService } from './cart-repository';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SchedulerClient } from '@aws-sdk/client-scheduler';
import { createHandler, type ApiEvent } from './api';
import { DynamoCatalogRepository, type CatalogRepository } from './repository';
import {
  SchedulerOpeningSchedules,
  type OpeningSchedules,
} from './opening-schedules';
import { createAutoOpenHandler } from './auto-open';
import type { InvocationContext } from './request-logging';

// A real API Gateway envelope always stays on the HTTP path. Its body is never
// parsed as an internal event, regardless of the body contents or source marker.
export function createEntrypoint(
  getRepository: () => CatalogRepository,
  getSchedules: () => OpeningSchedules,
  getCarts?: () => CartService,
  getMedia?: () => MediaApiRepository,
  getOrders?: () => AdminOrders,
  getFulfillment?: () => FulfillmentRepository,
  getCustomers?: () => AdminCustomers,
  getNotifications?: () => AdminNotifications,
  getGuestOrders?: () => GuestOrders,
  getRefunds?: () => Refunds,
) {
  const http = createHandler(
    getRepository,
    getSchedules,
    getCarts,
    getMedia,
    undefined,
    getOrders,
    getFulfillment,
    getCustomers,
    getNotifications,
    getGuestOrders,
    getRefunds,
  );
  let payment: ReturnType<typeof createPaymentHttp> | undefined;
  const automatic = createAutoOpenHandler(getRepository);
  return (event: unknown, context?: InvocationContext) => {
    if (
      event &&
      typeof event === 'object' &&
      ('requestContext' in event || 'routeKey' in event || 'version' in event)
    ) {
      const httpEvent = event as ApiEvent;
      if (
        [
          'POST /carts/{cartId}/payment/start',
          'POST /carts/{cartId}/payment/confirm',
          'GET /carts/{cartId}/payment',
        ].includes(httpEvent.routeKey)
      )
        return (payment ??= createPaymentHttp())(httpEvent);
      return http(httpEvent, context);
    }
    return automatic(event, context);
  };
}
let repository: DynamoCatalogRepository | undefined;
let schedules: SchedulerOpeningSchedules | undefined;
let carts: DynamoCartRepository | undefined;
let media: MediaRepository | undefined;
let orders: AdminOrders | undefined;
let fulfillment: FulfillmentRepository | undefined;
let customers: AdminCustomers | undefined;
let notifications: AdminNotifications | undefined;
let guestOrders: GuestOrders | undefined;
export const handler = createEntrypoint(
  () =>
    (repository ??= new DynamoCatalogRepository(
      DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 2 })),
      process.env.CATALOG_TABLE_NAME ?? '',
    )),
  () =>
    (schedules ??= new SchedulerOpeningSchedules(
      new SchedulerClient({ maxAttempts: 2 }),
      process.env.OPEN_SCHEDULE_GROUP ?? '',
      process.env.OPEN_TARGET_ARN ?? '',
      process.env.OPEN_SCHEDULE_ROLE_ARN ?? '',
    )),
  () =>
    (carts ??= new DynamoCartRepository(
      DynamoDBDocumentClient.from(
        new DynamoDBClient({
          maxAttempts: 1,
          requestHandler: {
            connectionTimeout: 300,
            requestTimeout: 700,
            throwOnRequestTimeout: true,
          },
        }),
      ),
      process.env.CATALOG_TABLE_NAME ?? '',
      process.env.COMMERCE_TABLE_NAME ?? '',
      process.env.OPERATIONS_TABLE_NAME ?? '',
      undefined,
      new SqsExpiryDispatch(
        new SQSClient({ maxAttempts: 1 }),
        process.env.RESERVATION_QUEUE_URL ?? '',
      ),
    )),
  () =>
    (media ??= new MediaRepository(
      DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 1 })),
      process.env.CATALOG_TABLE_NAME ?? '',
    )),
  () =>
    (orders ??= new AdminOrders(
      DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 1 })),
      process.env.COMMERCE_TABLE_NAME ?? '',
    )),
  () =>
    (fulfillment ??= new FulfillmentRepository(
      DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 1 })),
      process.env.COMMERCE_TABLE_NAME ?? '',
    )),
  () =>
    (customers ??= new AdminCustomers(
      DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 1 })),
      process.env.COMMERCE_TABLE_NAME ?? '',
      async (id) =>
        (
          await new DynamoCatalogRepository(
            DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 1 })),
            process.env.CATALOG_TABLE_NAME ?? '',
          ).getDrop(id)
        )?.name ?? null,
    )),
  () =>
    (notifications ??= new AdminNotifications(
      DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 1 })),
      process.env.OPERATIONS_TABLE_NAME ?? '',
    )),
  () =>
    (guestOrders ??= new GuestOrders(
      DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 1 })),
      process.env.COMMERCE_TABLE_NAME ?? '',
      process.env.OPERATIONS_TABLE_NAME ?? '',
      process.env.CATALOG_TABLE_NAME ?? '',
      process.env.GUEST_ORDER_ORIGIN ?? '',
      Date.now,
      process.env.GUEST_PICKUP_CUTOFF ?? '15:00',
      Number(process.env.GUEST_CANCELLATION_HOURS ?? '24'),
    )),
);
