import {
  GetCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { orderSchema, orderKey } from './payment-domain';
import { orderReferencePattern, referenceKey } from './order-reference';
import { idSchema, dateSchema } from './domain';
import { AdminError } from './admin-auth';
import { validate } from './admin-writes';
import type { ApiEvent } from './api';
export const orderRoutes = ['GET /admin/orders', 'GET /admin/orders/{orderId}'];
type Order = z.infer<typeof orderSchema>;
const statusSchema = orderSchema.shape.status;
const querySchema = z.strictObject({
  dropId: idSchema.optional(),
  pickupDate: dateSchema.optional(),
  status: statusSchema.optional(),
  reference: z.string().regex(orderReferencePattern).optional(),
  cursor: z
    .string()
    .max(4096)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
});
const cursorSchema = z.strictObject({
  scope: z.string(),
  key: z.record(z.string(), z.string().max(2048)),
});
export function orderDto(o: Order, details = false) {
  return {
    orderId: o.orderId,
    displayOrderNumber: o.displayOrderNumber ?? null,
    status: o.status,
    paymentStatus: o.paymentStatus,
    customerName: o.customer.name,
    totalCents: o.totalCents,
    currency: o.currency,
    pickupDate: o.pickup.date,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    fulfillmentStatus: null,
    ...(details
      ? {
          customer: {
            name: o.customer.name,
            email: o.customer.email,
            phone: o.customer.phone,
          },
          items: o.items.map((i) => ({
            name: i.name,
            quantity: i.quantity,
            unitPriceCents: i.unitPriceCents,
            cookieUnits: i.cookieUnits,
          })),
          subtotalCents: o.subtotalCents,
          taxCents: o.taxCents,
          feeCents: o.feeCents,
          pickup: {
            date: o.pickup.date,
            startTime: o.pickup.startTime,
            endTime: o.pickup.endTime,
            timezone: o.pickup.timezone,
            location: o.pickup.location,
            instructions: o.pickup.instructions,
          },
        }
      : {}),
  };
}
export class AdminOrders {
  constructor(
    private client: Pick<DynamoDBDocumentClient, 'send'>,
    private table: string,
  ) {
    if (!table) throw Error('Commerce table required');
  }
  async get(id: string) {
    const key = orderKey(id);
    const r = await this.client.send(
      new GetCommand({ TableName: this.table, Key: key, ConsistentRead: true }),
    );
    if (!r.Item) return null;
    const { PK, SK, ...data } = r.Item;
    const order = orderSchema.parse(data);
    if (PK !== key.PK || SK !== key.SK || order.orderId !== id)
      throw Error('Order identity mismatch');
    return order;
  }
  async list(input: z.infer<typeof querySchema>) {
    if (input.reference) {
      if (input.dropId || input.pickupDate || input.status || input.cursor)
        throw new AdminError(
          400,
          'VALIDATION_ERROR',
          'Reference search cannot combine filters.',
        );
      const r = await this.client.send(
        new GetCommand({
          TableName: this.table,
          Key: referenceKey(input.reference),
          ConsistentRead: true,
        }),
      );
      const o = r.Item ? await this.get(idSchema.parse(r.Item.orderId)) : null;
      if (o && o.displayOrderNumber !== input.reference)
        throw Error('Reference mismatch');
      return { orders: o ? [orderDto(o)] : [], nextCursor: null };
    }
    if (!input.dropId && !input.pickupDate)
      throw new AdminError(
        400,
        'VALIDATION_ERROR',
        'Select a Drop or pickup date.',
      );
    const index = input.pickupDate ? 'GSI1' : 'GSI2',
      pk = input.pickupDate
        ? 'PICKUP#' + input.pickupDate
        : 'DROP#' + input.dropId;
    const scope = JSON.stringify([
      input.dropId ?? null,
      input.pickupDate ?? null,
      input.status ?? null,
    ]);
    let key: Record<string, string> | undefined;
    if (input.cursor) {
      try {
        const c = cursorSchema.parse(
          JSON.parse(Buffer.from(input.cursor, 'base64url').toString()),
        );
        if (c.scope !== scope) throw Error();
        key = c.key;
        if (
          Object.keys(key).sort().join(',') !==
            [index + 'PK', index + 'SK', 'PK', 'SK'].sort().join(',') ||
          key[index + 'PK'] !== pk ||
          !key.PK.startsWith('ORDER#') ||
          key.SK !== 'META'
        )
          throw Error();
      } catch {
        throw new AdminError(400, 'VALIDATION_ERROR', 'Invalid order cursor.');
      }
    }
    const names: Record<string, string> = { '#pk': index + 'PK' },
      values: Record<string, string> = { ':pk': pk };
    const filters = [];
    if (input.status) {
      names['#status'] = 'status';
      values[':status'] = input.status;
      filters.push('#status=:status');
    }
    if (input.pickupDate && input.dropId) {
      names['#drop'] = 'dropId';
      values[':drop'] = input.dropId;
      filters.push('#drop=:drop');
    }
    const r = await this.client.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: index,
        KeyConditionExpression: '#pk=:pk',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ScanIndexForward: false,
        Limit: 20,
        ExclusiveStartKey: key,
        ...(filters.length ? { FilterExpression: filters.join(' AND ') } : {}),
      }),
    );
    // Refresh each projected row from the authoritative record; index visibility can lag.
    const orders = [];
    for (const item of r.Items ?? []) {
      const o = await this.get(idSchema.parse(item.orderId));
      if (
        o &&
        (!input.dropId || o.dropId === input.dropId) &&
        (!input.pickupDate || o.pickup.date === input.pickupDate) &&
        (!input.status || o.status === input.status)
      )
        orders.push(orderDto(o));
    }
    return {
      orders,
      nextCursor: r.LastEvaluatedKey
        ? Buffer.from(
            JSON.stringify({ scope, key: r.LastEvaluatedKey }),
          ).toString('base64url')
        : null,
    };
  }
}
export async function adminOrders(event: ApiEvent, repository: AdminOrders) {
  if (event.pathParameters?.orderId) {
    const o = await repository.get(
      validate(idSchema, event.pathParameters.orderId),
    );
    if (!o) throw new AdminError(404, 'ORDER_NOT_FOUND', 'Order not found.');
    return { order: orderDto(o, true) };
  }
  return repository.list(
    validate(querySchema, event.queryStringParameters ?? {}),
  );
}
