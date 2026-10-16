import {
  ledgerKey,
  refundLedger,
  refundOperationKey,
  refundOperation,
} from './refund-domain';
import {
  CancellationRequests,
  cancellationKey,
  requestInput,
  reviewInput,
} from './cancellation-requests';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import {
  GetCommand,
  QueryCommand,
  UpdateCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { AdminOrders } from './admin-orders';
import { AdminError } from './admin-auth';
import { orderKey } from './payment-domain';
import { orderIndexKeys } from './order-reference';
import { idSchema, dateSchema, pickupSchema } from './domain';
import { catalogKeys } from './keys';
import { fulfillmentKey, readFulfillment } from './fulfillment-state';
import {
  refundKey,
  refundSchema,
  operationKey,
  dueKey,
  shard,
  type Operation,
} from './notification-contract';
export const guestToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const hash = (s: string) =>
  createHash('sha256')
    .update('guest-order:v1:' + s)
    .digest('hex');
const accessKey = (id: string) => ({
  PK: 'ORDER#' + idSchema.parse(id),
  SK: 'GUEST_ACCESS',
});
const tokenKey = (digest: string) => ({
  PK: 'GUEST_TOKEN#' + digest,
  SK: 'META',
});
const stateSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  originalExpiresAt: z.iso.datetime(),
  tokens: z
    .array(
      z.strictObject({
        id: z.uuid(),
        hash: z.string().regex(/^[a-f0-9]{64}$/),
        issuedAt: z.iso.datetime(),
        expiresAt: z.iso.datetime(),
      }),
    )
    .max(2),
});
const changeState = z.strictObject({
  revision: z.number().int().nonnegative(),
});
const changeKey = (id: string) => ({
  PK: 'ORDER#' + id,
  SK: 'PICKUP_REVISION',
});
const fail = (code = 'ORDER_ACCESS_UNAVAILABLE', status = 403) =>
  new AdminError(
    status,
    code,
    code === 'ORDER_ACCESS_UNAVAILABLE'
      ? 'This order link is unavailable or expired. Contact the bakery.'
      : 'This action is unavailable. Refresh your order or contact the bakery.',
  );
const conflict = (e: unknown) =>
  e instanceof Error &&
  ['TransactionCanceledException', 'ConditionalCheckFailedException'].includes(
    e.name,
  );
export function denverWall(now: number) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Denver',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const get = (k: string) => parts.find((p) => p.type === k)!.value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}
export function pickupCutoff(date: string, time = '15:00') {
  dateSchema.parse(date);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw Error('Invalid cutoff');
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10) + 'T' + time;
}
export function accessExpiration(date: string, endTime: string) {
  const wall = date + 'T' + endTime;
  const approximate = Date.parse(wall + ':00Z');
  const matches = [6, 7]
    .map((h) => approximate + h * 3600000)
    .filter((t) => denverWall(t) === wall);
  if (matches.length !== 1) throw fail('PICKUP_TIME_REQUIRES_REVIEW', 409);
  return new Date(matches[0] + 30 * 86400000).toISOString();
}
export const pickupChangeInput = z.strictObject({
  token: guestToken,
  requestId: z.uuid(),
  revision: z.number().int().nonnegative(),
  date: dateSchema,
});
export const accessAdminInput = z.strictObject({
  requestId: z.uuid(),
  reason: z.string().trim().min(1).max(500),
  tokenId: z.uuid().optional(),
});
type Client = Pick<DynamoDBDocumentClient, 'send'>;
export class GuestOrders {
  private orders: AdminOrders;
  constructor(
    private client: Client,
    private commerce: string,
    private operations: string,
    private catalog: string,
    private origin: string,
    private now = Date.now,
    private cutoff = '15:00',
    private cancellationHours = 24,
  ) {
    if (
      !commerce ||
      !operations ||
      !catalog ||
      new URL(origin).protocol !== 'https:' ||
      new URL(origin).origin !== origin
    )
      throw Error('Guest order configuration required');
    this.orders = new AdminOrders(client, commerce);
    pickupCutoff('2030-01-01', cutoff);
  }
  private requests() {
    return new CancellationRequests(
      this.client,
      this.commerce,
      this.operations,
      this.now,
      this.cancellationHours,
    );
  }
  async requestCancellation(
    token: string,
    input: z.infer<typeof requestInput>,
  ) {
    const { id, state, grant } = await this.authorize(token);
    return this.requests().submit(
      {
        id,
        revision: state.revision,
        tokenId: grant.id,
        expiresAt: grant.expiresAt,
      },
      input,
    );
  }
  async adminRequest(id: string) {
    return this.requests().view(id, true);
  }
  async reviewRequest(
    id: string,
    input: z.infer<typeof reviewInput>,
    administrator: string,
  ) {
    return this.requests().review(id, input, administrator);
  }
  private async read(table: string, key: { PK: string; SK: string }) {
    const r = await this.client.send(
      new GetCommand({ TableName: table, Key: key, ConsistentRead: true }),
    );
    if (!r.Item) return null;
    const { PK, SK, ...data } = r.Item;
    return data;
  }
  private async state(id: string) {
    const raw = await this.read(this.commerce, accessKey(id));
    return raw ? stateSchema.parse(raw) : null;
  }
  private async order(id: string) {
    const o = await this.orders.get(id);
    if (!o) throw fail();
    return o;
  }
  private paid(o: Awaited<ReturnType<AdminOrders['get']>>) {
    return (
      !!o &&
      o.status === 'PAID' &&
      o.paymentStatus === 'CAPTURED' &&
      o.settlement?.outcome === 'PAID'
    );
  }
  async rateLimit(identity: string) {
    if (!identity || identity.length > 128) throw fail();
    const Key = { PK: 'GUEST_RATE#' + hash(identity), SK: 'META' },
      bucket = Math.floor(this.now() / 60000);
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.operations,
          Key,
          UpdateExpression: 'SET #bucket=:bucket, attempts=:one',
          ConditionExpression:
            'attribute_not_exists(#bucket) OR #bucket<>:bucket',
          ExpressionAttributeNames: { '#bucket': 'bucket' },
          ExpressionAttributeValues: { ':bucket': bucket, ':one': 1 },
        }),
      );
      return;
    } catch (e) {
      if (!conflict(e)) throw e;
    }
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.operations,
          Key,
          UpdateExpression: 'SET attempts=attempts+:one',
          ConditionExpression: '#bucket=:bucket AND attempts<:max',
          ExpressionAttributeNames: { '#bucket': 'bucket' },
          ExpressionAttributeValues: {
            ':bucket': bucket,
            ':one': 1,
            ':max': 60,
          },
        }),
      );
    } catch {
      throw fail('RATE_LIMITED', 429);
    }
  }
  private async authorize(raw: string) {
    const token = guestToken.safeParse(raw);
    if (!token.success) throw fail();
    const digest = hash(token.data),
      lookup = await this.read(this.operations, tokenKey(digest));
    if (!lookup || !idSchema.safeParse(lookup.orderId).success) throw fail();
    const id = lookup.orderId as string,
      state = await this.state(id);
    const grant = state?.tokens.find(
      (t) => t.hash === digest && Date.parse(t.expiresAt) > this.now(),
    );
    if (!state || !grant) throw fail();
    return { id, state, grant };
  }
  async issue(o: Operation): Promise<string> {
    if (
      !['CONFIRMATION', 'ACCESS'].includes(o.kind) ||
      o.channel !== 'email' ||
      o.status !== 'DISPATCHED'
    )
      throw fail();
    const order = await this.order(o.orderId);
    if (!this.paid(order)) throw fail();
    const previous = await this.state(o.orderId),
      at = new Date(this.now()).toISOString(),
      expiresAt =
        previous?.originalExpiresAt ??
        accessExpiration(order.pickup.date, order.pickup.endTime);
    if (Date.parse(expiresAt) <= this.now()) throw fail();
    const active =
      previous?.tokens.filter((t) => Date.parse(t.expiresAt) > this.now()) ??
      [];
    if (active.length >= 2) throw fail('ACTIVE_LINK_LIMIT', 409);
    const raw = randomBytes(32).toString('base64url'),
      digest = hash(raw),
      id = randomUUID();
    const state = stateSchema.parse({
      revision: (previous?.revision ?? 0) + 1,
      originalExpiresAt: expiresAt,
      tokens: [...active, { id, hash: digest, issuedAt: at, expiresAt }],
    });
    await this.client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.commerce,
              Item: { ...accessKey(o.orderId), ...state },
              ConditionExpression: previous
                ? 'revision=:revision'
                : 'attribute_not_exists(PK)',
              ...(previous
                ? {
                    ExpressionAttributeValues: {
                      ':revision': previous.revision,
                    },
                  }
                : {}),
            },
          },
          {
            Put: {
              TableName: this.operations,
              Item: { ...tokenKey(digest), orderId: o.orderId },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Put: {
              TableName: this.operations,
              Item: {
                PK: 'GUEST_ISSUANCE#' + o.orderId,
                SK: o.key,
                tokenId: id,
                issuedAt: at,
                expiresAt,
              },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            ConditionCheck: {
              TableName: this.operations,
              Key: operationKey(o.orderId, o.key),
              ConditionExpression: '#status=:status AND revision=:revision',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':status': 'DISPATCHED',
                ':revision': o.revision,
              },
            },
          },
          {
            ConditionCheck: {
              TableName: this.commerce,
              Key: orderKey(o.orderId),
              ConditionExpression:
                '#status=:paid AND paymentStatus=:captured AND updatedAt=:updated',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':paid': 'PAID',
                ':captured': 'CAPTURED',
                ':updated': order.updatedAt,
              },
            },
          },
        ],
      }),
    );
    // Fragment is never sent in a URL request, Referer or server access log.
    return this.origin + '/order/manage#' + raw;
  }
  async adminStatus(id: string) {
    const s = await this.state(id);
    return {
      tokens: (s?.tokens ?? []).map(({ hash, ...t }) => ({
        ...t,
        expired: Date.parse(t.expiresAt) <= this.now(),
      })),
      originalExpiresAt: s?.originalExpiresAt ?? null,
    };
  }
  async admin(
    id: string,
    action: 'reissue' | 'revoke',
    input: z.infer<typeof accessAdminInput>,
    administrator: string,
  ) {
    idSchema.parse(id);
    input = accessAdminInput.parse(input);
    if ((action === 'revoke') !== !!input.tokenId)
      throw fail('INVALID_ACTION', 400);
    const receipt = { PK: 'GUEST_ADMIN#' + id, SK: input.requestId },
      fingerprint = hash(
        JSON.stringify([
          action,
          input.reason,
          input.tokenId ?? null,
          administrator,
        ]),
      );
    const prior = await this.read(this.operations, receipt);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw fail('REQUEST_CONFLICT', 409);
      return { accepted: true };
    }
    const order = await this.order(id);
    const at = new Date(this.now()).toISOString();
    const actions: any[] = [
      {
        Put: {
          TableName: this.operations,
          Item: {
            ...receipt,
            fingerprint,
            administrator,
            reason: input.reason,
            action,
            tokenId: input.tokenId ?? null,
            at,
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
    ];
    if (action === 'reissue') {
      if (!this.paid(order)) throw fail('ORDER_NOT_ELIGIBLE', 409);
      const state = await this.state(id);
      if (state && Date.parse(state.originalExpiresAt) <= this.now())
        throw fail();
      if (
        (state?.tokens.filter((t) => Date.parse(t.expiresAt) > this.now())
          .length ?? 0) >= 2
      )
        throw fail('ACTIVE_LINK_LIMIT', 409);
      const op: Operation = {
        orderId: id,
        key: 'ACCESS#' + input.requestId + '#email',
        kind: 'ACCESS',
        channel: 'email',
        pickupDate: order.pickup.date,
        status: 'PENDING',
        attempts: 0,
        revision: 0,
        createdAt: at,
        updatedAt: at,
      };
      actions.push(
        {
          Put: {
            TableName: this.operations,
            Item: { ...operationKey(id, op.key), ...op },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
        {
          Put: {
            TableName: this.operations,
            Item: { ...dueKey(op), orderId: id, key: op.key },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
      );
    } else {
      const state = await this.state(id);
      if (!state || !state.tokens.some((t) => t.id === input.tokenId))
        throw fail('LINK_NOT_FOUND', 404);
      actions.push({
        Put: {
          TableName: this.commerce,
          Item: {
            ...accessKey(id),
            ...state,
            revision: state.revision + 1,
            tokens: state.tokens.filter((t) => t.id !== input.tokenId),
          },
          ConditionExpression: 'revision=:revision',
          ExpressionAttributeValues: { ':revision': state.revision },
        },
      });
    }
    try {
      await this.client.send(
        new TransactWriteCommand({ TransactItems: actions }),
      );
    } catch (e) {
      const saved = await this.read(this.operations, receipt);
      if (saved?.fingerprint === fingerprint) return { accepted: true };
      if (conflict(e)) throw fail('REQUEST_CONFLICT', 409);
      throw e;
    }
    return { accepted: true };
  }
  private async eligibility(o: Awaited<ReturnType<GuestOrders['order']>>) {
    if (await this.requests().state(o.orderId))
      return 'A cancellation or assistance request is recorded. Contact the bakery before changing pickup.';
    if (!this.paid(o) || o.pickup.timezone !== 'America/Denver')
      return 'Order is not eligible for pickup changes.';
    const raw = await this.read(this.commerce, refundKey(o.orderId)),
      refund = refundSchema.safeParse(raw);
    if (
      !refund.success ||
      refund.data.disposition !== 'NONE' ||
      refund.data.settlementId !== o.settlement?.id
    )
      return 'Refund eligibility requires bakery review.';
    if (await readFulfillment(this.client, this.commerce, o.orderId))
      return 'Preparation or fulfillment has already been recorded. Contact the bakery.';
    if (denverWall(this.now()) >= pickupCutoff(o.pickup.date, this.cutoff))
      return 'The pickup-change deadline has passed.';
    return null;
  }
  async view(token: string) {
    const { id } = await this.authorize(token),
      o = await this.order(id),
      state = changeState.parse(
        (await this.read(this.commerce, changeKey(id))) ?? { revision: 0 },
      ),
      f = await readFulfillment(this.client, this.commerce, id),
      reason = await this.eligibility(o);
    const r = await this.client.send(
      new QueryCommand({
        TableName: this.catalog,
        KeyConditionExpression: 'PK=:pk AND begins_with(SK,:prefix)',
        ExpressionAttributeValues: {
          ':pk': 'DROP#' + o.dropId,
          ':prefix': 'PICKUP#',
        },
        ConsistentRead: true,
        Limit: 100,
      }),
    );
    const dates = (r.Items ?? [])
      .map(({ PK, SK, ...p }) => pickupSchema.parse(p))
      .filter(
        (p) =>
          p.active &&
          p.dropId === o.dropId &&
          p.date !== o.pickup.date &&
          p.timezone === 'America/Denver' &&
          p.date > denverWall(this.now()).slice(0, 10),
      );
    const refundRaw = await this.read(this.commerce, ledgerKey(id));
    const ledger = refundRaw ? refundLedger.parse(refundRaw) : null;
    if (
      ledger &&
      (ledger.orderId !== id || ledger.settlementId !== o.settlement?.id)
    )
      throw fail();
    let refundStatus = ledger?.lastStatus ?? null;
    if (ledger?.active) {
      const operation = refundOperation.parse(
        await this.read(this.operations, refundOperationKey(id, ledger.active)),
      );
      if (operation.orderId !== id || operation.operationId !== ledger.active)
        throw fail();
      refundStatus = operation.status;
    }
    if (ledger) {
      const current = refundLedger.parse(
        await this.read(this.commerce, ledgerKey(id)),
      );
      const currentOrder = await this.order(id);
      if (
        current.revision !== ledger.revision ||
        currentOrder.updatedAt !== o.updatedAt
      )
        throw fail('STATUS_REFRESH_REQUIRED', 503);
    }
    if (ledger?.blocked) refundStatus = 'RECONCILIATION_REQUIRED';
    return {
      refund: ledger
        ? {
            status: refundStatus,
            refundedCents: ledger.refundedCents,
            currency: o.currency,
          }
        : null,
      cancellation: await this.requests().view(id),
      order: {
        reference: o.displayOrderNumber ?? null,
        items: o.items.map(({ name, quantity, unitPriceCents }) => ({
          name,
          quantity,
          unitPriceCents,
        })),
        subtotalCents: o.subtotalCents,
        taxCents: o.taxCents,
        feeCents: o.feeCents,
        totalCents: o.totalCents,
        currency: o.currency,
        paymentStatus: o.paymentStatus,
        status: o.status,
        pickup: {
          date: o.pickup.date,
          startTime: o.pickup.startTime,
          endTime: o.pickup.endTime,
          location: o.pickup.location,
          instructions: o.pickup.instructions,
        },
        fulfillmentStatus: f?.status ?? null,
      },
      revision: state.revision,
      cutoff: pickupCutoff(o.pickup.date, this.cutoff),
      changeUnavailable: reason,
      dates: dates.map(({ date, startTime, endTime }) => ({
        date,
        startTime,
        endTime,
      })),
      datesTruncated: !!r.LastEvaluatedKey,
    };
  }
  async change(input: z.infer<typeof pickupChangeInput>) {
    input = pickupChangeInput.parse(input);
    const { id, state, grant } = await this.authorize(input.token),
      receipt = { PK: 'GUEST_PICKUP#' + id, SK: input.requestId },
      fingerprint = hash(
        JSON.stringify([grant.id, input.date, input.revision]),
      );
    const saved = await this.read(this.operations, receipt);
    if (saved) {
      if (saved.fingerprint !== fingerprint)
        throw fail('REQUEST_CONFLICT', 409);
      return { changed: true, revision: saved.revision };
    }
    const o = await this.order(id);
    if (await this.eligibility(o)) throw fail('PICKUP_CHANGE_UNAVAILABLE', 409);
    const previous = changeState.parse(
      (await this.read(this.commerce, changeKey(id))) ?? { revision: 0 },
    );
    if (
      previous.revision !== input.revision ||
      input.date === o.pickup.date ||
      input.date <= denverWall(this.now()).slice(0, 10)
    )
      throw fail('PICKUP_CONFLICT', 409);
    const p = pickupSchema.safeParse(
      await this.read(this.catalog, catalogKeys.pickup(o.dropId, input.date)),
    );
    if (
      !p.success ||
      !p.data.active ||
      p.data.dropId !== o.dropId ||
      p.data.timezone !== 'America/Denver'
    )
      throw fail('PICKUP_UNAVAILABLE', 409);
    const refund = refundSchema.parse(
        await this.read(this.commerce, refundKey(id)),
      ),
      at = new Date(this.now()).toISOString(),
      revision = previous.revision + 1,
      next = { ...o, pickup: { ...o.pickup, ...p.data }, updatedAt: at };
    Object.assign(next, orderIndexKeys(next));
    const op: Operation = {
      orderId: id,
      key: 'PICKUP_CHANGE#' + input.requestId + '#email',
      kind: 'PICKUP_CHANGE',
      channel: 'email',
      pickupDate: input.date,
      status: 'PENDING',
      attempts: 0,
      revision: 0,
      createdAt: at,
      updatedAt: at,
    };
    // Recheck time and the second refund read immediately before committing.
    if (Date.parse(grant.expiresAt) <= this.now()) throw fail();
    if (
      denverWall(this.now()) >= pickupCutoff(o.pickup.date, this.cutoff) ||
      refund.disposition !== 'NONE' ||
      refund.settlementId !== o.settlement?.id
    )
      throw fail('PICKUP_CHANGE_UNAVAILABLE', 409);
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: this.commerce,
                Key: cancellationKey(id),
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            {
              Put: {
                TableName: this.commerce,
                Item: { ...orderKey(id), ...next },
                ConditionExpression:
                  'updatedAt=:updated AND pickup=:pickup AND #status=:paid AND paymentStatus=:captured',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: {
                  ':updated': o.updatedAt,
                  ':pickup': o.pickup,
                  ':paid': 'PAID',
                  ':captured': 'CAPTURED',
                },
              },
            },
            {
              Put: {
                TableName: this.commerce,
                Item: { ...changeKey(id), revision },
                ConditionExpression: previous.revision
                  ? 'revision=:revision'
                  : 'attribute_not_exists(PK)',
                ...(previous.revision
                  ? {
                      ExpressionAttributeValues: {
                        ':revision': previous.revision,
                      },
                    }
                  : {}),
              },
            },
            {
              ConditionCheck: {
                TableName: this.commerce,
                Key: accessKey(id),
                ConditionExpression: 'revision=:revision',
                ExpressionAttributeValues: { ':revision': state.revision },
              },
            },
            {
              ConditionCheck: {
                TableName: this.commerce,
                Key: refundKey(id),
                ConditionExpression:
                  'disposition=:none AND settlementId=:settlement AND updatedAt=:updated',
                ExpressionAttributeValues: {
                  ':none': 'NONE',
                  ':settlement': refund.settlementId,
                  ':updated': refund.updatedAt,
                },
              },
            },
            {
              ConditionCheck: {
                TableName: this.commerce,
                Key: fulfillmentKey(id),
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            {
              ConditionCheck: {
                TableName: this.catalog,
                Key: catalogKeys.pickup(o.dropId, input.date),
                ConditionExpression:
                  'active=:active AND startTime=:start AND endTime=:end AND #timezone=:timezone',
                ExpressionAttributeNames: { '#timezone': 'timezone' },
                ExpressionAttributeValues: {
                  ':active': true,
                  ':start': p.data.startTime,
                  ':end': p.data.endTime,
                  ':timezone': 'America/Denver',
                },
              },
            },
            {
              Put: {
                TableName: this.operations,
                Item: {
                  ...receipt,
                  fingerprint,
                  revision,
                  oldDate: o.pickup.date,
                  newDate: input.date,
                  at,
                  actorTokenId: grant.id,
                },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            {
              Put: {
                TableName: this.operations,
                Item: { ...operationKey(id, op.key), ...op },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            {
              Put: {
                TableName: this.operations,
                Item: { ...dueKey(op), orderId: id, key: op.key },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            {
              Put: {
                TableName: this.operations,
                Item: {
                  PK: 'NOTIFICATION_PICKUP_EVENTS#' + shard(id),
                  SK: input.requestId,
                  orderId: id,
                  pickupDate: input.date,
                },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
          ],
        }),
      );
    } catch (e) {
      const committed = await this.read(this.operations, receipt);
      if (committed?.fingerprint === fingerprint)
        return { changed: true, revision: committed.revision };
      if (conflict(e)) throw fail('PICKUP_CONFLICT', 409);
      throw e;
    }
    return { changed: true, revision };
  }
}
