import { z } from 'zod';
import {
  expiryDelay,
  expiryLog,
  expiryMessageSchema,
  type ExpiryDispatch,
} from './cart-expiry';
import { ExpiryFailure, type ExpiryRepository } from './expiry-repository';

const recordSchema = z.object({
  messageId: z.string().min(1).max(128),
  eventSource: z.literal('aws:sqs'),
  eventSourceARN: z.string(),
  body: z.string().max(4096),
  attributes: z.object({
    ApproximateReceiveCount: z.string().regex(/^\d{1,6}$/),
  }),
});
export function createExpiryWorker(
  repository: Pick<ExpiryRepository, 'expire'>,
  dispatch: ExpiryDispatch,
  queueArn: string,
  now = () => Date.now(),
) {
  if (!queueArn) throw new Error('Reservation queue ARN required');
  return async (
    event: unknown,
    context?: {
      awsRequestId?: string;
      getRemainingTimeInMillis?: () => number;
    },
  ) => {
    // Only the SQS event source mapping can invoke this function in the deployed
    // policy. An HTTP envelope is rejected even if it also contains Records.
    if (
      !event ||
      typeof event !== 'object' ||
      'requestContext' in event ||
      'routeKey' in event ||
      'version' in event ||
      !('Records' in event) ||
      !Array.isArray(event.Records) ||
      event.Records.length !== 1
    )
      throw new Error('Invalid SQS envelope');
    const record = recordSchema.safeParse(event.Records[0]);
    if (!record.success || record.data.eventSourceARN !== queueArn)
      throw new Error('Invalid SQS envelope');
    const r = record.data;
    let safe: { cartId?: string; deadline?: string } = {};
    try {
      const message = expiryMessageSchema.parse(JSON.parse(r.body));
      safe = { cartId: message.cartId, deadline: message.deadline };
      const result = await repository.expire(
        message,
        context?.getRemainingTimeInMillis?.bind(context),
      );
      if (result.outcome === 'early') {
        const remaining = context?.getRemainingTimeInMillis?.() ?? 1000;
        if (remaining < 600) throw new ExpiryFailure('RETRY_EXHAUSTED');
        await dispatch.send(
          message,
          Math.max(1, expiryDelay(message.deadline, now())),
          Math.min(400, remaining - 200),
        );
      }
      expiryLog(
        'expireCart',
        result.outcome,
        {
          WorkerSuccess: 1,
          Attempts: result.attempts,
          ExpiryLatenessMs: result.lateness,
        },
        {
          ...safe,
          awsRequestId: context?.awsRequestId,
          messageId: r.messageId,
          receiveCount: Number(r.attributes.ApproximateReceiveCount),
        },
      );
      return { batchItemFailures: [] };
    } catch (error) {
      expiryLog(
        'expireCart',
        error instanceof ExpiryFailure ? error.code : 'MESSAGE_FAILED',
        { WorkerBatchFailure: 1 },
        {
          ...safe,
          awsRequestId: context?.awsRequestId,
          messageId: r.messageId,
          receiveCount: Number(r.attributes.ApproximateReceiveCount),
        },
      );
      return { batchItemFailures: [{ itemIdentifier: r.messageId }] };
    }
  };
}
