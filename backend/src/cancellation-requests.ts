import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { AdminOrders } from './admin-orders';
import { AdminError } from './admin-auth';
import { idSchema } from './domain';
import { orderKey } from './payment-domain';
import { fulfillmentKey, readFulfillment } from './fulfillment-state';
import {
  refundKey,
  refundSchema,
  digest,
  operationKey,
  dueKey,
  type Operation,
} from './notification-contract';
export const cancellationKey = (id: string) => ({
  PK: 'ORDER#' + idSchema.parse(id),
  SK: 'CANCELLATION_REQUEST',
});
export const requestInput = z
  .strictObject({
    requestId: z.uuid(),
    type: z.enum(['GUARANTEED', 'EXCEPTION']),
    reason: z.string().trim().max(500),
  })
  .refine((x) => x.type !== 'EXCEPTION' || !!x.reason, 'Reason required');
export const reviewInput = z.strictObject({
  requestId: z.uuid(),
  revision: z.number().int().positive(),
  decision: z.enum(['NOTE', 'APPROVE_EXCEPTION', 'DECLINE_EXCEPTION']),
  note: z.string().trim().min(1).max(500),
});
export const cancellationState = z.strictObject({
  orderId: idSchema,
  requestId: z.uuid(),
  type: z.enum(['GUARANTEED', 'EXCEPTION']),
  reason: z.string().max(500),
  status: z.enum([
    'RECEIVED_PENDING_PROCESSING',
    'EXCEPTION_REQUESTED',
    'APPROVED_PENDING_PROCESSING',
    'DECLINED',
  ]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  revision: z.number().int().positive(),
  eligibility: z.strictObject({
    deadline: z.iso.datetime(),
    hours: z.number().int().positive(),
    pickupDate: z.string(),
    pickupStart: z.string(),
    orderUpdatedAt: z.iso.datetime(),
    settlementId: z.string(),
    refundDisposition: z.literal('NONE'),
    fulfillment: z.string().nullable(),
    amountCents: z.number().int().nonnegative(),
    currency: z.string(),
  }),
});
export type GuestGrant = {
  id: string;
  revision: number;
  tokenId: string;
  expiresAt: string;
};
const failure = (code = 'REQUEST_UNAVAILABLE', status = 409) =>
  new AdminError(
    status,
    code,
    'This request is unavailable. Refresh your order or contact the bakery.',
  );
export function cancellationDeadline(date: string, time: string, hours = 24) {
  if (!Number.isInteger(hours) || hours < 1 || hours > 168)
    throw Error('Invalid cancellation policy');
  const wall = date + 'T' + time;
  const matches = [6, 7]
    .map((h) => Date.parse(wall + ':00Z') + h * 3600000)
    .filter((t) => {
      const p = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'America/Denver',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
        .format(new Date(t))
        .replace(' ', 'T');
      return p === wall;
    });
  if (matches.length !== 1) throw failure('PICKUP_TIME_REQUIRES_REVIEW');
  return new Date(matches[0] - hours * 3600000).toISOString();
}
export class CancellationRequests {
  private orders: AdminOrders;
  constructor(
    private client: Pick<DynamoDBDocumentClient, 'send'>,
    private commerce: string,
    private operations: string,
    private now = Date.now,
    private hours = 24,
  ) {
    cancellationDeadline('2030-01-01', '16:00', hours);
    this.orders = new AdminOrders(client, commerce);
  }
  private async read(table: string, Key: { PK: string; SK: string }) {
    const r = await this.client.send(
      new GetCommand({ TableName: table, Key, ConsistentRead: true }),
    );
    if (!r.Item) return null;
    const { PK, SK, ...value } = r.Item;
    return value;
  }
  async state(id: string) {
    const raw = await this.read(this.commerce, cancellationKey(id));
    if (!raw) return null;
    const state = cancellationState.parse(raw);
    if (state.orderId !== id) throw failure();
    if (
      (state.type === 'GUARANTEED') !==
      (state.status === 'RECEIVED_PENDING_PROCESSING')
    )
      throw failure();
    return state;
  }
  private async evidence(id: string) {
    const order = await this.orders.get(id);
    if (!order) throw failure();
    const refund = refundSchema.safeParse(
      await this.read(this.commerce, refundKey(id)),
    );
    const fulfillment = await readFulfillment(this.client, this.commerce, id);
    let deadline: string | null = null;
    try {
      if (order.pickup.timezone === 'America/Denver')
        deadline = cancellationDeadline(
          order.pickup.date,
          order.pickup.startTime,
          this.hours,
        );
    } catch {
      /* Invalid scheduling evidence fails closed. */
    }
    const valid =
      !!deadline &&
      order.status === 'PAID' &&
      order.paymentStatus === 'CAPTURED' &&
      order.settlement?.outcome === 'PAID' &&
      order.settlement.amountCents === order.totalCents &&
      refund.success &&
      refund.data.disposition === 'NONE' &&
      refund.data.settlementId === order.settlement.id &&
      fulfillment?.status !== 'PICKED_UP' &&
      !(
        fulfillment?.status === 'MISSED_PICKUP' &&
        this.now() < Date.parse(deadline!)
      );
    return { order, refund, fulfillment, deadline, valid };
  }
  async view(id: string, admin = false) {
    const e = await this.evidence(id),
      state = await this.state(id);
    const guaranteed = e.valid && this.now() < Date.parse(e.deadline!);
    const result = {
      hours: state?.eligibility.hours ?? this.hours,
      deadline: state?.eligibility.deadline ?? e.deadline,
      eligible: !state && guaranteed,
      exceptionEligible: !state && e.valid && !guaranteed,
      unavailable: !e.valid
        ? 'Order eligibility requires bakery assistance.'
        : null,
      request: state
        ? {
            requestId: state.requestId,
            type: state.type,
            status: state.status,
            reason: state.reason,
            createdAt: state.createdAt,
            updatedAt: state.updatedAt,
            revision: state.revision,
            eligibility: {
              deadline: state.eligibility.deadline,
              amountCents: state.eligibility.amountCents,
              currency: state.eligibility.currency,
              pickupDate: state.eligibility.pickupDate,
              pickupStart: state.eligibility.pickupStart,
            },
          }
        : null,
    };
    if (!admin) return result;
    const history = await this.client.send(
      new QueryCommand({
        TableName: this.operations,
        KeyConditionExpression: 'PK=:pk',
        ExpressionAttributeValues: { ':pk': 'CANCELLATION_AUDIT#' + id },
        ConsistentRead: true,
        ScanIndexForward: false,
        Limit: 25,
      }),
    );
    return {
      ...result,
      paymentStatus: e.order.paymentStatus,
      refundDisposition: e.refund.success
        ? e.refund.data.disposition
        : 'UNKNOWN',
      history: (history.Items ?? []).map(({ PK, SK, ...x }) => x),
      historyTruncated: !!history.LastEvaluatedKey,
    };
  }
  async submit(grant: GuestGrant, raw: z.infer<typeof requestInput>) {
    const input = requestInput.parse(raw),
      id = grant.id;
    const receipt = { PK: 'CANCELLATION_RECEIPT#' + id, SK: input.requestId };
    const fingerprint = digest(JSON.stringify([grant.tokenId, input]));
    const prior = await this.read(this.operations, receipt);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw failure('REQUEST_CONFLICT');
      return { received: true };
    }
    const e = await this.evidence(id);
    if (!e.valid || !e.refund.success || !e.deadline || (await this.state(id)))
      throw failure();
    const guaranteed = this.now() < Date.parse(e.deadline);
    if ((input.type === 'GUARANTEED') !== guaranteed)
      throw failure('CANCELLATION_DEADLINE_CHANGED');
    const at = new Date(this.now()).toISOString();
    const state = cancellationState.parse({
      orderId: id,
      requestId: input.requestId,
      type: input.type,
      reason: input.reason,
      status: guaranteed
        ? 'RECEIVED_PENDING_PROCESSING'
        : 'EXCEPTION_REQUESTED',
      createdAt: at,
      updatedAt: at,
      revision: 1,
      eligibility: {
        deadline: e.deadline,
        hours: this.hours,
        pickupDate: e.order.pickup.date,
        pickupStart: e.order.pickup.startTime,
        orderUpdatedAt: e.order.updatedAt,
        settlementId: e.order.settlement!.id,
        refundDisposition: 'NONE',
        fulfillment: e.fulfillment?.status ?? null,
        amountCents: e.order.totalCents,
        currency: e.order.currency,
      },
    });
    const op: Operation = {
      orderId: id,
      key: 'REQUEST#' + input.requestId + '#email',
      kind: 'REQUEST',
      channel: 'email',
      pickupDate: e.order.pickup.date,
      status: 'PENDING',
      attempts: 0,
      revision: 0,
      createdAt: at,
      updatedAt: at,
    };
    if (Date.parse(grant.expiresAt) <= this.now())
      throw failure('ORDER_ACCESS_UNAVAILABLE', 403);
    if (this.now() < Date.parse(e.deadline) !== guaranteed)
      throw failure('CANCELLATION_DEADLINE_CHANGED');
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.commerce,
                Item: { ...cancellationKey(id), ...state },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            {
              ConditionCheck: {
                TableName: this.commerce,
                Key: orderKey(id),
                ConditionExpression:
                  'updatedAt=:at AND pickup=:pickup AND #s=:paid AND paymentStatus=:captured AND settlement=:settlement',
                ExpressionAttributeNames: { '#s': 'status' },
                ExpressionAttributeValues: {
                  ':at': e.order.updatedAt,
                  ':pickup': e.order.pickup,
                  ':paid': 'PAID',
                  ':captured': 'CAPTURED',
                  ':settlement': e.order.settlement,
                },
              },
            },
            {
              ConditionCheck: {
                TableName: this.commerce,
                Key: refundKey(id),
                ConditionExpression:
                  'disposition=:none AND settlementId=:s AND updatedAt=:at',
                ExpressionAttributeValues: {
                  ':none': 'NONE',
                  ':s': e.refund.data.settlementId,
                  ':at': e.refund.data.updatedAt,
                },
              },
            },
            {
              ConditionCheck: {
                TableName: this.commerce,
                Key: fulfillmentKey(id),
                ConditionExpression: e.fulfillment
                  ? 'revision=:r'
                  : 'attribute_not_exists(PK)',
                ...(e.fulfillment
                  ? {
                      ExpressionAttributeValues: {
                        ':r': e.fulfillment.revision,
                      },
                    }
                  : {}),
              },
            },
            {
              ConditionCheck: {
                TableName: this.commerce,
                Key: { PK: 'ORDER#' + id, SK: 'GUEST_ACCESS' },
                ConditionExpression: 'revision=:r',
                ExpressionAttributeValues: { ':r': grant.revision },
              },
            },
            {
              Put: {
                TableName: this.operations,
                Item: { ...receipt, fingerprint, at },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            {
              Put: {
                TableName: this.operations,
                Item: {
                  PK: 'CANCELLATION_AUDIT#' + id,
                  SK: at + '#' + input.requestId,
                  requestId: input.requestId,
                  action: 'SUBMITTED',
                  actorTokenId: grant.tokenId,
                  at,
                  type: input.type,
                  reason: input.reason,
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
          ],
        }),
      );
    } catch (e) {
      if (
        (await this.read(this.operations, receipt))?.fingerprint === fingerprint
      )
        return { received: true };
      if (e instanceof Error && e.name === 'TransactionCanceledException')
        throw failure('REQUEST_CONFLICT');
      throw e;
    }
    return { received: true };
  }
  async review(
    id: string,
    raw: z.infer<typeof reviewInput>,
    administrator: string,
  ) {
    const input = reviewInput.parse(raw);
    idSchema.parse(id);
    const key = { PK: 'CANCELLATION_REVIEW#' + id, SK: input.requestId },
      fingerprint = digest(JSON.stringify([administrator, input]));
    const prior = await this.read(this.operations, key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw failure('REQUEST_CONFLICT');
      return { recorded: true };
    }
    const state = await this.state(id);
    if (!state || state.revision !== input.revision)
      throw failure('REQUEST_CONFLICT');
    if (
      input.decision !== 'NOTE' &&
      (state.type !== 'EXCEPTION' || state.status !== 'EXCEPTION_REQUESTED')
    )
      throw failure('DECISION_NOT_ALLOWED');
    const evidence =
      input.decision === 'APPROVE_EXCEPTION' ? await this.evidence(id) : null;
    if (evidence && !evidence.valid) throw failure('ORDER_NOT_ELIGIBLE');
    const at = new Date(this.now()).toISOString();
    const status =
      input.decision === 'APPROVE_EXCEPTION'
        ? 'APPROVED_PENDING_PROCESSING'
        : input.decision === 'DECLINE_EXCEPTION'
          ? 'DECLINED'
          : state.status;
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            ...(evidence && evidence.refund.success
              ? [
                  {
                    ConditionCheck: {
                      TableName: this.commerce,
                      Key: orderKey(id),
                      ConditionExpression:
                        'updatedAt=:at AND #s=:paid AND paymentStatus=:captured AND settlement=:settlement',
                      ExpressionAttributeNames: { '#s': 'status' },
                      ExpressionAttributeValues: {
                        ':at': evidence.order.updatedAt,
                        ':paid': 'PAID',
                        ':captured': 'CAPTURED',
                        ':settlement': evidence.order.settlement,
                      },
                    },
                  },
                  {
                    ConditionCheck: {
                      TableName: this.commerce,
                      Key: refundKey(id),
                      ConditionExpression:
                        'disposition=:none AND settlementId=:s AND updatedAt=:at',
                      ExpressionAttributeValues: {
                        ':none': 'NONE',
                        ':s': evidence.refund.data.settlementId,
                        ':at': evidence.refund.data.updatedAt,
                      },
                    },
                  },
                  {
                    ConditionCheck: {
                      TableName: this.commerce,
                      Key: fulfillmentKey(id),
                      ConditionExpression: evidence.fulfillment
                        ? 'revision=:r'
                        : 'attribute_not_exists(PK)',
                      ...(evidence.fulfillment
                        ? {
                            ExpressionAttributeValues: {
                              ':r': evidence.fulfillment.revision,
                            },
                          }
                        : {}),
                    },
                  },
                ]
              : []),
            {
              Put: {
                TableName: this.commerce,
                Item: {
                  ...cancellationKey(id),
                  ...state,
                  status,
                  revision: state.revision + 1,
                  updatedAt: at,
                },
                ConditionExpression: 'revision=:r',
                ExpressionAttributeValues: { ':r': state.revision },
              },
            },
            {
              Put: {
                TableName: this.operations,
                Item: { ...key, fingerprint, at },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            {
              Put: {
                TableName: this.operations,
                Item: {
                  PK: 'CANCELLATION_AUDIT#' + id,
                  SK: at + '#' + input.requestId,
                  requestId: input.requestId,
                  at,
                  administrator,
                  action: input.decision,
                  note: input.note,
                  revision: state.revision + 1,
                },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
          ],
        }),
      );
    } catch (e) {
      if ((await this.read(this.operations, key))?.fingerprint === fingerprint)
        return { recorded: true };
      if (e instanceof Error && e.name === 'TransactionCanceledException')
        throw failure('REQUEST_CONFLICT');
      throw e;
    }
    return { recorded: true };
  }
}
