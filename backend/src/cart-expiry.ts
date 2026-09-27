import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { idSchema } from './domain';

export const canonicalTime = z.iso
  .datetime()
  .refine((s) => new Date(s).toISOString() === s);
export const expiryMessageSchema = z.strictObject({
  schemaVersion: z.literal(1),
  source: z.literal('batch-and-batter.cart-expiry'),
  operation: z.literal('expireCart'),
  cartId: idSchema,
  deadlineType: z.literal('SHOPPING'),
  deadline: canonicalTime,
});
export type ExpiryMessage = z.infer<typeof expiryMessageSchema>;
export const expiryWorkSchema = z.strictObject({
  schemaVersion: z.literal(1),
  cartId: idSchema,
  deadlineType: z.literal('SHOPPING'),
  deadline: canonicalTime,
  createdAt: canonicalTime,
});
export const expiryShard = (cartId: string) =>
  (createHash('sha256').update(idSchema.parse(cartId)).digest()[0] & 15)
    .toString(16)
    .toUpperCase()
    .padStart(2, '0');
export const expiryKey = (cartId: string, deadline: string) => ({
  PK: `CART_EXPIRY#V1#${expiryShard(cartId)}`,
  SK: `${canonicalTime.parse(deadline)}#SHOPPING#${cartId}`,
});
export const expiryMessage = (
  cartId: string,
  deadline: string,
): ExpiryMessage =>
  expiryMessageSchema.parse({
    schemaVersion: 1,
    source: 'batch-and-batter.cart-expiry',
    operation: 'expireCart',
    cartId,
    deadlineType: 'SHOPPING',
    deadline,
  });
export function expiryWork(
  cartId: string,
  deadline: string,
  createdAt: string,
) {
  return {
    ...expiryKey(cartId, deadline),
    ...expiryWorkSchema.parse({
      schemaVersion: 1,
      cartId,
      deadlineType: 'SHOPPING',
      deadline,
      createdAt,
    }),
  };
}
export function deleteExpiryWork(
  table: string,
  message: ExpiryMessage,
): NonNullable<TransactWriteCommandInput['TransactItems']>[number] {
  return {
    Delete: {
      TableName: table,
      Key: expiryKey(message.cartId, message.deadline),
      ConditionExpression:
        'attribute_not_exists(PK) OR (#cart = :cart AND #type = :type AND #deadline = :deadline AND #version = :version)',
      ExpressionAttributeNames: {
        '#cart': 'cartId',
        '#type': 'deadlineType',
        '#deadline': 'deadline',
        '#version': 'schemaVersion',
      },
      ExpressionAttributeValues: {
        ':cart': message.cartId,
        ':type': 'SHOPPING',
        ':deadline': message.deadline,
        ':version': 1,
      },
    },
  };
}
export interface ExpiryDispatch {
  send(
    message: ExpiryMessage,
    delay: number,
    timeoutMs?: number,
  ): Promise<void>;
}
export const expiryDelay = (deadline: string, now: number) =>
  Math.min(900, Math.max(0, Math.ceil((Date.parse(deadline) - now) / 1000)));
export class SqsExpiryDispatch implements ExpiryDispatch {
  constructor(
    private readonly client: Pick<SQSClient, 'send'>,
    private readonly queueUrl: string,
  ) {
    if (!queueUrl) throw new Error('Reservation queue required');
  }
  async send(message: ExpiryMessage, delay: number, timeoutMs = 400) {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(expiryMessageSchema.parse(message)),
        DelaySeconds: delay,
      }),
      { abortSignal: AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs))) },
    );
  }
}
// Explicit fields only: callers cannot accidentally spread requests or AWS errors.
export function expiryLog(
  operation: 'dispatchCartExpiry' | 'expireCart' | 'reconcileCartExpiry',
  outcome: string,
  metrics: Record<string, number> = {},
  correlation: {
    cartId?: string;
    deadline?: string;
    awsRequestId?: string;
    messageId?: string;
    receiveCount?: number;
  } = {},
) {
  const safeId = (s: string | undefined) =>
    s && /^[A-Za-z0-9_=+./:-]{1,128}$/.test(s) ? s : undefined;
  console.info(
    JSON.stringify({
      operation,
      outcome,
      cartId: idSchema.safeParse(correlation.cartId).success
        ? correlation.cartId
        : undefined,
      deadline: canonicalTime.safeParse(correlation.deadline).success
        ? correlation.deadline
        : undefined,
      deadlineType: correlation.deadline ? 'SHOPPING' : undefined,
      awsRequestId: safeId(correlation.awsRequestId),
      messageId: safeId(correlation.messageId),
      receiveCount: Number.isSafeInteger(correlation.receiveCount)
        ? correlation.receiveCount
        : undefined,
      ...metrics,
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'BatchAndBatter/CartExpiry',
            Dimensions: [['Service']],
            Metrics: Object.keys(metrics).map((Name) => ({
              Name,
              Unit: Name.endsWith('Ms') ? 'Milliseconds' : 'Count',
            })),
          },
        ],
      },
      Service: process.env.EXPIRY_METRIC_SERVICE ?? 'batch-and-batter-dev',
    }),
  );
}
