import { ExpiryRepository } from './expiry-repository';
import { createExpiryWorker } from './expiry-worker';
import { expiryDocumentClient, expiryDispatch } from './expiry-runtime';
let worker: ReturnType<typeof createExpiryWorker> | undefined;
export const handler = (
  event: unknown,
  context?: { awsRequestId?: string; getRemainingTimeInMillis?: () => number },
) => {
  worker ??= createExpiryWorker(
    new ExpiryRepository(
      expiryDocumentClient(),
      process.env.CATALOG_TABLE_NAME ?? '',
      process.env.COMMERCE_TABLE_NAME ?? '',
      process.env.OPERATIONS_TABLE_NAME ?? '',
    ),
    expiryDispatch(),
    process.env.RESERVATION_QUEUE_ARN ?? '',
  );
  return worker(event, context);
};
