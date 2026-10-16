import {
  GetCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { AdminError } from './admin-auth';
import { AdminOrders } from './admin-orders';
import { dateSchema, idSchema } from './domain';
import { orderReferencePattern, referenceKey } from './order-reference';
import {
  ledgerKey,
  refundLedger,
  refundOperation,
  refundOperationKey,
  refundStatus,
} from './refund-domain';

export const attentionAge = {
  AUTHORIZED: 60 * 60000,
  DISPATCHED: 60 * 60000,
  PENDING: 24 * 3600000,
};
export function attention(op: z.infer<typeof refundOperation>, now: number) {
  if (op.status === 'RECONCILIATION_REQUIRED') return 'Reconciliation required';
  if (op.status === 'FAILED') return 'Failed refund';
  const threshold = attentionAge[op.status as keyof typeof attentionAge];
  // Creation time is durable; polling updates must not postpone operational review.
  if (threshold !== undefined && now - Date.parse(op.createdAt) >= threshold)
    return {
      AUTHORIZED: 'Authorization awaiting processing',
      DISPATCHED: 'Dispatched outcome not confirmed',
      PENDING: 'Long-running pending refund',
    }[op.status as keyof typeof attentionAge];
  return null;
}
const token = z
  .string()
  .max(4096)
  .regex(/^[A-Za-z0-9_-]+$/);
export const worklistQuery = z.strictObject({
  dropId: idSchema.optional(),
  pickupDate: dateSchema.optional(),
  reference: z.string().regex(orderReferencePattern).optional(),
  status: refundStatus.optional(),
  attentionOnly: z.enum(['true', 'false']).default('true'),
  cursor: token.optional(),
});
const keySchema = z.record(z.string(), z.string().max(256));
const traversal = z.strictObject({
  scope: z.string().max(512),
  key: keySchema.nullable(),
  current: idSchema.nullable(),
  after: z.uuid().nullable(),
});
const auditCursor = z.strictObject({
  scope: z.string(),
  after: z.string().max(100),
});
const invalid = () =>
  new AdminError(
    400,
    'INVALID_CURSOR',
    'Invalid scope or continuation. Refresh the worklist.',
  );
const changed = () =>
  new AdminError(
    409,
    'REFRESH_REQUIRED',
    'Recorded evidence changed. Refresh the worklist.',
  );
const encode = (x: unknown) =>
  Buffer.from(JSON.stringify(x)).toString('base64url');
function decode(value: string) {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString());
  } catch {
    throw invalid();
  }
}
function bounded<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value)) > 128 * 1024) throw changed();
  return value;
}
export class RefundWorklist {
  private orders: AdminOrders;
  constructor(
    private client: Pick<DynamoDBDocumentClient, 'send'>,
    private commerce: string,
    private operations: string,
    private now = Date.now,
  ) {
    if (!commerce || !operations) throw Error('Read tables required');
    this.orders = new AdminOrders(client, commerce);
  }
  private async read(table: string, Key: { PK: string; SK: string }) {
    const r = await this.client.send(
      new GetCommand({ TableName: table, Key, ConsistentRead: true }),
    );
    if (!r.Item) return null;
    const { PK, SK, ...data } = r.Item;
    if (PK !== Key.PK || SK !== Key.SK) throw changed();
    return data;
  }
  private async state(id: string) {
    const order = await this.orders.get(id);
    if (!order) throw changed();
    const raw = await this.read(this.commerce, ledgerKey(id));
    const ledger = raw ? refundLedger.parse(raw) : null;
    if (
      ledger &&
      (ledger.orderId !== id ||
        ledger.settlementId !== order.settlement?.id ||
        ledger.capturedCents !== order.totalCents)
    )
      throw changed();
    return { order, ledger };
  }
  private async stable(s: Awaited<ReturnType<RefundWorklist['state']>>) {
    const current = await this.state(s.order.orderId);
    if (JSON.stringify(current) !== JSON.stringify(s)) throw changed();
  }
  private summary(s: Awaited<ReturnType<RefundWorklist['state']>>) {
    return {
      orderId: s.order.orderId,
      reference: s.order.displayOrderNumber ?? null,
      customerName: s.order.customer.name,
      dropId: s.order.dropId,
      pickupDate: s.order.pickup.date,
      currency: s.order.currency,
      originalTotalCents: s.order.totalCents,
      capturedCents: s.ledger?.capturedCents ?? null,
      refundedCents: s.ledger?.refundedCents ?? null,
      reservedCents: s.ledger?.reservedCents ?? null,
      availableCents: s.ledger
        ? s.ledger.capturedCents -
          s.ledger.refundedCents -
          s.ledger.reservedCents
        : null,
      blocked: s.ledger?.blocked ?? false,
      returned: s.ledger?.returned ?? {},
      updatedAt: s.ledger?.updatedAt ?? s.order.updatedAt,
    };
  }
  private indexKey(key: Record<string, string>, index: string, pk: string) {
    if (
      Object.keys(key).sort().join() !==
        ['PK', 'SK', index + 'PK', index + 'SK'].sort().join() ||
      key.SK !== 'META' ||
      key[index + 'PK'] !== pk
    )
      throw invalid();
    const id = idSchema.safeParse(key.PK.slice(6));
    const indexedTime = key[index + 'SK'].split('#')[1];
    if (!z.iso.datetime().safeParse(indexedTime).success) throw invalid();
    if (
      !key.PK.startsWith('ORDER#') ||
      !id.success ||
      !/^ORDER#\d{4}-\d\d-\d\dT[\d:.]+Z#/.test(key[index + 'SK']) ||
      !key[index + 'SK'].endsWith('#' + id.data)
    )
      throw invalid();
  }
  async list(value: unknown) {
    const parsed = worklistQuery.safeParse(value);
    if (!parsed.success) throw invalid();
    const q = parsed.data;
    if ([q.dropId, q.pickupDate, q.reference].filter(Boolean).length !== 1)
      throw invalid();
    const { cursor, ...filters } = q,
      scope = JSON.stringify(filters),
      index = q.pickupDate ? 'GSI1' : 'GSI2',
      pk = q.pickupDate ? 'PICKUP#' + q.pickupDate : 'DROP#' + q.dropId;
    let c: z.infer<typeof traversal> = {
      scope,
      key: null,
      current: null,
      after: null,
    };
    if (cursor) {
      const p = traversal.safeParse(decode(cursor));
      if (!p.success || p.data.scope !== scope) throw invalid();
      c = p.data;
    }
    if (c.key) {
      if (q.reference) throw invalid();
      this.indexKey(c.key, index, pk);
    }
    if (
      (c.after && !c.current) ||
      (c.current && !c.after) ||
      (c.current && c.key && c.key.PK !== 'ORDER#' + c.current) ||
      (!q.reference && c.current && !c.key)
    )
      throw invalid();
    let id = c.current,
      nextOrderKey = c.key;
    if (!id) {
      if (q.reference) {
        const ref = await this.read(this.commerce, referenceKey(q.reference));
        if (!ref) return { rows: [], nextCursor: null };
        id = idSchema.parse(ref.orderId);
      } else {
        const page = await this.client.send(
          new QueryCommand({
            TableName: this.commerce,
            IndexName: index,
            KeyConditionExpression: '#pk=:pk',
            ExpressionAttributeNames: { '#pk': index + 'PK' },
            ExpressionAttributeValues: { ':pk': pk },
            ScanIndexForward: false,
            Limit: 1,
            ExclusiveStartKey: c.key ?? undefined,
          }),
        );
        nextOrderKey =
          (page.LastEvaluatedKey as Record<string, string>) ?? null;
        if (nextOrderKey) {
          this.indexKey(nextOrderKey, index, pk);
          if (c.key && nextOrderKey[index + 'SK'] >= c.key[index + 'SK'])
            throw changed();
        }
        if (!page.Items?.length)
          return {
            rows: [],
            nextCursor: nextOrderKey
              ? encode({ scope, key: nextOrderKey, current: null, after: null })
              : null,
          };
        if (page.Items.length !== 1) throw changed();
        id = idSchema.parse(page.Items[0].orderId);
        // Retain this evaluated position while walking all operation pages, even at the last Order.
        const item = page.Items[0];
        const position = {
          PK: item.PK,
          SK: item.SK,
          [index + 'PK']: item[index + 'PK'],
          [index + 'SK']: item[index + 'SK'],
        };
        this.indexKey(position, index, pk);
        if (position.PK !== 'ORDER#' + id) throw changed();
        c = { ...c, key: position };
      }
    }
    const s = await this.state(id);
    if (
      (q.reference && s.order.displayOrderNumber !== q.reference) ||
      (q.dropId && s.order.dropId !== q.dropId) ||
      (q.pickupDate && s.order.pickup.date !== q.pickupDate)
    )
      throw changed();
    const page = await this.client.send(
      new QueryCommand({
        TableName: this.operations,
        KeyConditionExpression: 'PK=:pk',
        ExpressionAttributeValues: { ':pk': 'ORDER_REFUNDS#' + id },
        ConsistentRead: true,
        Limit: 10,
        ExclusiveStartKey: c.after
          ? refundOperationKey(id, c.after)
          : undefined,
      }),
    );
    const rows: unknown[] = [];
    const summary = this.summary(s);
    const now = this.now();
    if (!c.after && s.ledger?.blocked)
      rows.push({
        ...summary,
        operation: null,
        attentionReason: 'Blocked refund ledger',
      });
    for (const item of page.Items ?? []) {
      const { PK, SK, ...raw } = item,
        op = refundOperation.parse(raw);
      if (
        PK !== 'ORDER_REFUNDS#' + id ||
        SK !== op.operationId ||
        op.orderId !== id ||
        !s.ledger ||
        op.settlementId !== s.ledger.settlementId ||
        op.capturedCents !== s.ledger.capturedCents ||
        op.currency !== s.order.currency
      )
        throw changed();
      const reason = attention(op, now);
      if (
        (!q.status || q.status === op.status) &&
        (q.attentionOnly === 'false' || reason)
      )
        rows.push({
          ...summary,
          operation: {
            operationId: op.operationId,
            amountCents: op.amountCents,
            status: op.status,
            updatedAt: op.updatedAt,
          },
          attentionReason: reason,
        });
    }
    let nextCursor: string | null = null;
    if (page.LastEvaluatedKey) {
      const key = page.LastEvaluatedKey;
      if (
        Object.keys(key).sort().join() !== 'PK,SK' ||
        key.PK !== 'ORDER_REFUNDS#' + id ||
        !z.uuid().safeParse(key.SK).success ||
        (c.after && key.SK <= c.after)
      )
        throw changed();
      nextCursor = encode({
        scope,
        key: q.reference ? null : c.key,
        current: id,
        after: key.SK,
      });
    } else if (!q.reference) {
      // On resumed operation pages, the current Order position is also the next index continuation.
      const key = c.current ? c.key : nextOrderKey;
      if (key) nextCursor = encode({ scope, key, current: null, after: null });
    }
    await this.stable(s);
    return bounded({ rows, nextCursor });
  }
  async detail(id: string, operationId: string, cursor?: string) {
    if (
      !idSchema.safeParse(id).success ||
      !z.uuid().safeParse(operationId).success
    )
      throw invalid();
    if (cursor && !token.safeParse(cursor).success) throw invalid();
    const scope = JSON.stringify([id, operationId]);
    let after: string | undefined;
    if (cursor) {
      const c = auditCursor.safeParse(decode(cursor));
      if (
        !c.success ||
        c.data.scope !== scope ||
        !new RegExp('^' + operationId + '#[0-9]{12}$').test(c.data.after)
      )
        throw invalid();
      after = c.data.after;
    }
    const s = await this.state(id),
      key = refundOperationKey(id, operationId),
      raw = await this.read(this.operations, key);
    if (!raw) throw new AdminError(404, 'NOT_FOUND', 'Refund not found.');
    const op = refundOperation.parse(raw);
    if (
      op.orderId !== id ||
      op.operationId !== operationId ||
      !s.ledger ||
      op.settlementId !== s.ledger.settlementId ||
      op.capturedCents !== s.ledger.capturedCents ||
      op.currency !== s.order.currency
    )
      throw changed();
    const page = await this.client.send(
      new QueryCommand({
        TableName: this.operations,
        KeyConditionExpression: 'PK=:pk AND begins_with(SK,:prefix)',
        ExpressionAttributeValues: {
          ':pk': 'REFUND_AUDIT#' + id,
          ':prefix': operationId + '#',
        },
        ConsistentRead: true,
        Limit: 10,
        ExclusiveStartKey: after
          ? { PK: 'REFUND_AUDIT#' + id, SK: after }
          : undefined,
      }),
    );
    const audit = (page.Items ?? []).map(({ PK, SK, ...v }) => {
      if (
        PK !== 'REFUND_AUDIT#' + id ||
        !new RegExp('^' + operationId + '#[0-9]{12}$').test(SK) ||
        v.operationId !== operationId
      )
        throw changed();
      return {
        status: refundStatus.parse(v.status),
        at: z.iso.datetime().parse(v.at),
      };
    });
    let nextCursor: string | null = null;
    if (page.LastEvaluatedKey) {
      const k = page.LastEvaluatedKey;
      if (
        Object.keys(k).sort().join() !== 'PK,SK' ||
        k.PK !== 'REFUND_AUDIT#' + id ||
        !new RegExp('^' + operationId + '#[0-9]{12}$').test(k.SK) ||
        (after && k.SK <= after)
      )
        throw changed();
      nextCursor = encode({ scope, after: k.SK });
    }
    await this.stable(s);
    if (
      JSON.stringify(await this.read(this.operations, key)) !==
      JSON.stringify(raw)
    )
      throw changed();
    return bounded({
      order: this.summary(s),
      operation: {
        operationId,
        status: op.status,
        amountCents: op.amountCents,
        providerId: op.providerId ?? null,
        checks: op.checks,
        createdAt: op.createdAt,
        updatedAt: op.updatedAt,
        disposition: op.disposition,
        items: op.items,
      },
      audit,
      nextCursor,
    });
  }
}
