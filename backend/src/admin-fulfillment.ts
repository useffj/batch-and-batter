import { ledgerKey, refundLedger } from './refund-domain';
import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { AdminOrders } from './admin-orders';
import { AdminError } from './admin-auth';
import { orderKey } from './payment-domain';
import { dateSchema, idSchema } from './domain';
import {
  fulfillmentStatus,
  fulfillmentState,
  fulfillmentKey,
  readFulfillment,
} from './fulfillment-state';
import { body, validate } from './admin-writes';
import type { ApiEvent } from './api';
export const fulfillmentRoutes = [
  'GET /admin/fulfillment',
  'POST /admin/orders/{orderId}/fulfillment',
];
export const fulfillmentInput = z.strictObject({
  requestId: z.uuid(),
  revision: z.number().int().min(0).max(3),
  status: fulfillmentStatus,
  reason: z.string().trim().max(500).default(''),
});
const receiptSchema = z.strictObject({
  fingerprint: z.string(),
  administrator: z.string(),
  result: fulfillmentState,
});
export function pickupEnded(
  pickup: { date: string; endTime: string; timezone: string },
  now: number,
) {
  if (pickup.timezone !== 'America/Denver')
    throw new AdminError(
      409,
      'FULFILLMENT_CONFLICT',
      'Pickup timezone requires review.',
    );
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Denver',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const p = (type: string) => parts.find((x) => x.type === type)!.value;
  return (
    `${p('year')}-${p('month')}-${p('day')}T${p('hour')}:${p('minute')}` >=
    `${pickup.date}T${pickup.endTime}`
  );
}
const conflict = () =>
  new AdminError(
    409,
    'FULFILLMENT_CONFLICT',
    'Order or fulfillment changed, or this action is not eligible. Refresh before trying another action.',
  );
export class FulfillmentRepository {
  private orders: AdminOrders;
  constructor(
    private client: Pick<DynamoDBDocumentClient, 'send'>,
    private table: string,
    private now = () => Date.now(),
  ) {
    this.orders = new AdminOrders(client, table);
  }
  async list(pickupDate: string, cursor?: string) {
    const page = await this.orders.list({ pickupDate, status: 'PAID', cursor });
    const orders = [];
    for (const row of page.orders) {
      const o = await this.orders.get(row.orderId);
      if (
        o &&
        o.status === 'PAID' &&
        o.paymentStatus === 'CAPTURED' &&
        o.pickup.date === pickupDate
      ) {
        orders.push({
          ...(await this.orders.present(o, true)),
          pickupEnded: pickupEnded(o.pickup, this.now()),
        });
      }
    }
    return { orders, nextCursor: page.nextCursor };
  }
  async transition(orderId: string, value: unknown, administrator: string) {
    idSchema.parse(orderId);
    const input = fulfillmentInput.parse(value);
    if (!administrator || administrator.length > 256)
      throw new AdminError(403, 'FORBIDDEN', 'Administrator required.');
    const key = {
      PK: 'ORDER#' + orderId,
      SK: 'FULFILLMENT_EVENT#' + input.requestId,
    };
    const fingerprint = JSON.stringify([
      input.revision,
      input.status,
      input.reason,
    ]);
    const replay = async () => {
      const r = await this.client.send(
        new GetCommand({
          TableName: this.table,
          Key: key,
          ConsistentRead: true,
        }),
      );
      if (!r.Item) return null;
      const { PK, SK, ...data } = r.Item;
      const receipt = receiptSchema.parse(data);
      if (
        PK !== key.PK ||
        SK !== key.SK ||
        receipt.administrator !== administrator ||
        receipt.fingerprint !== fingerprint
      )
        throw conflict();
      return receipt.result;
    };
    const priorReceipt = await replay();
    if (priorReceipt) return priorReceipt;
    const order = await this.orders.get(orderId);
    if (!order)
      throw new AdminError(404, 'ORDER_NOT_FOUND', 'Order not found.');
    if (order.status !== 'PAID' || order.paymentStatus !== 'CAPTURED')
      throw conflict();
    const ledgerRaw = await this.client.send(
      new GetCommand({
        TableName: this.table,
        Key: ledgerKey(orderId),
        ConsistentRead: true,
      }),
    );
    const ledger = ledgerRaw.Item
      ? refundLedger.parse(
          Object.fromEntries(
            Object.entries(ledgerRaw.Item).filter(
              ([k]) => k !== 'PK' && k !== 'SK',
            ),
          ),
        )
      : null;
    if (
      ledger &&
      (ledger.orderId !== orderId ||
        ledger.blocked ||
        ledger.active ||
        order.items.every(
          (i) => (ledger.returned[i.productId] ?? 0) >= i.quantity,
        ))
    )
      throw conflict();
    const prior = await readFulfillment(this.client, this.table, orderId);
    if ((prior?.revision ?? 0) !== input.revision) throw conflict();
    const from = prior?.status;
    const allowed =
      input.status === 'READY_FOR_PICKUP'
        ? !from
        : input.status === 'MISSED_PICKUP'
          ? !from || from === 'READY_FOR_PICKUP'
          : from === 'READY_FOR_PICKUP' ||
            (from === 'MISSED_PICKUP' && input.reason.length > 0);
    if (!allowed) throw conflict();
    const now = this.now();
    if (input.status === 'MISSED_PICKUP' && !pickupEnded(order.pickup, now))
      throw conflict();
    const event = {
      requestId: input.requestId,
      status: input.status,
      at: new Date(now).toISOString(),
      administrator,
      reason: input.reason,
    };
    const result = fulfillmentState.parse({
      orderId,
      revision: input.revision + 1,
      status: input.status,
      history: [...(prior?.history ?? []), event],
    });
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: this.table,
                Key: ledgerKey(orderId),
                ...(ledger
                  ? {
                      ConditionExpression: 'revision=:revision',
                      ExpressionAttributeValues: {
                        ':revision': ledger.revision,
                      },
                    }
                  : { ConditionExpression: 'attribute_not_exists(PK)' }),
              },
            },
            {
              ConditionCheck: {
                TableName: this.table,
                Key: orderKey(orderId),
                ConditionExpression:
                  '#status=:paid AND paymentStatus=:captured AND updatedAt=:revision',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: {
                  ':paid': 'PAID',
                  ':captured': 'CAPTURED',
                  ':revision': order.updatedAt,
                },
              },
            },
            {
              Put: {
                TableName: this.table,
                Item: { ...result, ...fulfillmentKey(orderId) },
                ...(prior
                  ? {
                      ConditionExpression: 'revision=:revision',
                      ExpressionAttributeValues: {
                        ':revision': prior.revision,
                      },
                    }
                  : { ConditionExpression: 'attribute_not_exists(PK)' }),
              },
            },
            {
              Put: {
                TableName: this.table,
                Item: { ...key, fingerprint, administrator, result },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
          ],
        }),
      );
      return result;
    } catch {
      const receipt = await replay();
      if (receipt) return receipt;
      throw conflict();
    }
  }
}
export async function adminFulfillment(
  event: ApiEvent,
  repo: FulfillmentRepository,
  administrator: string,
) {
  if (event.requestContext.http.method === 'GET') {
    const q = validate(
      z.strictObject({
        pickupDate: dateSchema,
        cursor: z
          .string()
          .max(4096)
          .regex(/^[A-Za-z0-9_-]+$/)
          .optional(),
      }),
      event.queryStringParameters ?? {},
    );
    return repo.list(q.pickupDate, q.cursor);
  }
  return {
    fulfillment: await repo.transition(
      validate(idSchema, event.pathParameters?.orderId),
      validate(fulfillmentInput, body(event)),
      administrator,
    ),
  };
}
