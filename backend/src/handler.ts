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
) {
  const http = createHandler(getRepository, getSchedules);
  const automatic = createAutoOpenHandler(getRepository);
  return (event: unknown, context?: InvocationContext) => {
    if (
      event &&
      typeof event === 'object' &&
      ('requestContext' in event || 'routeKey' in event || 'version' in event)
    )
      return http(event as ApiEvent, context);
    return automatic(event, context);
  };
}
let repository: DynamoCatalogRepository | undefined;
let schedules: SchedulerOpeningSchedules | undefined;
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
);
