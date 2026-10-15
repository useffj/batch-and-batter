import { z } from 'zod';
import { idSchema } from './domain';
import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
export const fulfillmentStatus = z.enum([
  'READY_FOR_PICKUP',
  'PICKED_UP',
  'MISSED_PICKUP',
]);
export const fulfillmentEvent = z.strictObject({
  requestId: z.uuid(),
  status: fulfillmentStatus,
  at: z.iso.datetime(),
  administrator: z.string().min(1).max(256),
  reason: z.string().max(500),
});
export const fulfillmentState = z
  .strictObject({
    orderId: idSchema,
    revision: z.number().int().min(1).max(3),
    status: fulfillmentStatus,
    history: z.array(fulfillmentEvent).min(1).max(3),
  })
  .refine(
    (s) =>
      s.revision === s.history.length && s.status === s.history.at(-1)?.status,
    'Invalid fulfillment history',
  );
export const fulfillmentKey = (orderId: string) => ({
  PK: 'ORDER#' + idSchema.parse(orderId),
  SK: 'FULFILLMENT',
});
export async function readFulfillment(
  client: Pick<DynamoDBDocumentClient, 'send'>,
  table: string,
  orderId: string,
) {
  const key = fulfillmentKey(orderId);
  const r = await client.send(
    new GetCommand({ TableName: table, Key: key, ConsistentRead: true }),
  );
  if (!r.Item) return null;
  const { PK, SK, ...data } = r.Item;
  const state = fulfillmentState.parse(data);
  if (PK !== key.PK || SK !== key.SK || state.orderId !== orderId)
    throw Error('Invalid fulfillment identity');
  return state;
}
