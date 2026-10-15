import {
  QueryCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { AdminOrders } from './admin-orders';
import { AdminError } from './admin-auth';
import { body, validate } from './admin-writes';
import type { ApiEvent } from './api';
import {
  customerLookupRecords,
  lookupPartition,
  searchPartition,
} from './customer-lookup';
import { idSchema } from './domain';
export const customerRoutes = [
  'POST /admin/customers/search',
  'POST /admin/customers/history',
];
const cursor = z
  .string()
  .max(2048)
  .regex(/^[A-Za-z0-9_-]+$/)
  .optional();
export const customerSearch = z.strictObject({
  query: z.string().trim().min(1).max(254),
  cursor,
});
export const customerHistory = z.strictObject({
  contactKey: z.string().regex(/^[a-f0-9]{64}$/),
  cursor,
});
const keySchema = z.strictObject({
  PK: z.string().max(160),
  SK: z.string().max(100),
});
export class AdminCustomers {
  private orders: AdminOrders;
  constructor(
    private client: Pick<DynamoDBDocumentClient, 'send'>,
    private table: string,
    private dropName: (id: string) => Promise<string | null> = async () => null,
  ) {
    this.orders = new AdminOrders(client, table);
  }
  async page(partition: string, after?: string) {
    let start: z.infer<typeof keySchema> | undefined;
    if (after) {
      try {
        start = keySchema.parse(
          JSON.parse(Buffer.from(after, 'base64url').toString()),
        );
        if (
          start.PK !== partition ||
          !/^ORDER#\d{4}-\d\d-\d\dT[^#]+#[0-9A-HJKMNP-TV-Z]{26}$/.test(start.SK)
        )
          throw Error();
      } catch {
        throw new AdminError(
          400,
          'INVALID_CURSOR',
          'Search continuation does not match this request.',
        );
      }
    }
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'PK=:pk',
        ExpressionAttributeValues: { ':pk': partition },
        Limit: 20,
        ScanIndexForward: false,
        ConsistentRead: true,
        ExclusiveStartKey: start,
      }),
    );
    const orders = [];
    for (const row of result.Items ?? []) {
      const orderId = idSchema.parse(row.orderId);
      const o = await this.orders.get(orderId);
      if (!o) continue;
      const expected = customerLookupRecords(o).find(
        (k) =>
          k.PK === partition &&
          k.SK === row.SK &&
          k.contactKey === row.contactKey,
      );
      if (!expected) continue;
      orders.push({ order: o, contactKey: expected.contactKey });
    }
    return {
      orders,
      nextCursor: result.LastEvaluatedKey
        ? Buffer.from(
            JSON.stringify(keySchema.parse(result.LastEvaluatedKey)),
          ).toString('base64url')
        : null,
    };
  }
  async search(value: unknown) {
    const input = validate(customerSearch, value);
    let partition: string;
    try {
      partition = searchPartition(input.query);
    } catch {
      throw new AdminError(
        400,
        'VALIDATION_ERROR',
        'Enter a full name, first/last name token, or exact email.',
      );
    }
    const page = await this.page(partition, input.cursor);
    const seen = new Set<string>();
    const contacts = [];
    for (const { order, contactKey } of page.orders) {
      if (seen.has(contactKey)) continue;
      seen.add(contactKey);
      contacts.push({
        contactKey,
        customer: {
          name: order.customer.name,
          email: order.customer.email,
          phone: order.customer.phone,
        },
        recentOrder: {
          orderId: order.orderId,
          displayOrderNumber: order.displayOrderNumber ?? null,
          createdAt: order.createdAt,
        },
      });
    }
    return { contacts, nextCursor: page.nextCursor };
  }
  async history(value: unknown) {
    const input = validate(customerHistory, value);
    const page = await this.page(
      lookupPartition('contact', input.contactKey),
      input.cursor,
    );
    const orders = [];
    const drops = new Map<string, string | null>();
    for (const { order } of page.orders) {
      if (!drops.has(order.dropId))
        drops.set(order.dropId, await this.dropName(order.dropId));
      orders.push({
        ...(await this.orders.present(order, true)),
        dropName: drops.get(order.dropId) ?? null,
      });
    }
    return { orders, nextCursor: page.nextCursor };
  }
}
export async function adminCustomers(event: ApiEvent, repo: AdminCustomers) {
  if (Object.keys(event.queryStringParameters ?? {}).length)
    throw new AdminError(
      400,
      'VALIDATION_ERROR',
      'Search uses request bodies only.',
    );
  return event.routeKey === customerRoutes[0]
    ? repo.search(body(event))
    : repo.history(body(event));
}
