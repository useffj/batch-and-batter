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
) {
  const http = createHandler(getRepository, getSchedules, getCarts);
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
);
