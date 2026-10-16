import { cartKey, cartSchema } from './cart-domain';
import {
  settlementIdentity,
  paidEventKey,
  paidEventSchema,
} from './payment-settlement';
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { AdminError } from './admin-auth';
import {
  orderKey,
  orderSchema,
  attemptKey,
  paymentAttemptSchema,
} from './payment-domain';
import { associationKey, associationSchema } from './payment-execution-domain';
import { cancellationKey, cancellationState } from './cancellation-requests';
import {
  refundKey,
  refundSchema,
  digest,
  operationKey,
  dueKey,
  type Operation,
} from './notification-contract';
import { fulfillmentKey, readFulfillment } from './fulfillment-state';
import { inventorySchema } from './domain';
import { catalogKeys } from './keys';
import {
  refundInput,
  refundLedger,
  refundOperation,
  ledgerKey,
  refundOperationKey,
  refundWorkKey,
  refundSnapshot,
  type RefundOperation,
  type RefundProvider,
} from './refund-domain';
type Actions = NonNullable<TransactWriteCommandInput['TransactItems']>;
const conflict = () =>
  new AdminError(
    409,
    'REFUND_REQUIRES_REVIEW',
    'Refund evidence changed or requires reconciliation. Refresh before continuing.',
  );
const guard = (fields: Record<string, unknown>) => ({
  ConditionExpression: Object.keys(fields)
    .map((k) => '#' + k + '=:' + k)
    .join(' AND '),
  ExpressionAttributeNames: Object.fromEntries(
    Object.keys(fields).map((k) => ['#' + k, k]),
  ),
  ExpressionAttributeValues: Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [':' + k, v]),
  ),
});
// Injected coordinator only; no real provider or cloud client is activated.
export class Refunds {
  constructor(
    readonly client: Pick<DynamoDBDocumentClient, 'send'>,
    readonly commerce: string,
    readonly operations: string,
    readonly catalog: string,
    readonly provider: RefundProvider,
    readonly scope: string,
    readonly now = Date.now,
  ) {
    if (
      !/^dev:acct_[A-Za-z0-9]+$/.test(scope) ||
      provider.environment !== 'dev' ||
      !/^acct_[A-Za-z0-9]+$/.test(provider.accountId)
    )
      throw conflict();
  }
  private async read(table: string, Key: { PK: string; SK: string }) {
    const r = await this.client.send(
      new GetCommand({ TableName: table, Key, ConsistentRead: true }),
    );
    if (!r.Item) return null;
    const { PK, SK, ...value } = r.Item;
    if (PK !== Key.PK || SK !== Key.SK) throw conflict();
    return value;
  }
  private time(old?: string) {
    return new Date(
      Math.max(this.now(), old ? Date.parse(old) + 1 : 0),
    ).toISOString();
  }
  private async operation(id: string, op: string) {
    const o = refundOperation.parse(
      await this.read(this.operations, refundOperationKey(id, op)),
    );
    if (
      o.orderId !== id ||
      o.operationId !== op ||
      o.scope !== this.scope ||
      o.accountId !== this.provider.accountId ||
      o.environment !== this.provider.environment ||
      o.idempotencyKey !== 'refund:' + id + ':' + op
    )
      throw conflict();
    return o;
  }
  private async evidence(id: string) {
    const order = orderSchema.parse(
      await this.read(this.commerce, orderKey(id)),
    );
    const attempt = paymentAttemptSchema.parse(
      await this.read(this.commerce, attemptKey(order.paymentAttemptId)),
    );
    const e = attempt.execution,
      capture = e?.captureEvidence;
    if (
      !e?.intentId ||
      !capture ||
      e.scope !== this.scope ||
      e.recoveryRequired ||
      e.financialMode === 'READ_ONLY' ||
      attempt.status !== 'CAPTURED' ||
      order.paymentStatus !== 'CAPTURED' ||
      !['PAID', 'CANCELLED'].includes(order.status) ||
      order.orderId !== id ||
      attempt.orderId !== id ||
      attempt.cartId !== order.cartId ||
      attempt.dropId !== order.dropId ||
      e.parameters.metadata.orderId !== id ||
      e.parameters.metadata.cartId !== order.cartId ||
      e.parameters.metadata.paymentAttemptId !== attempt.paymentAttemptId ||
      e.parameters.metadata.dropId !== order.dropId ||
      order.currency !== 'usd' ||
      attempt.currency !== order.currency ||
      attempt.amountCents !== order.totalCents ||
      capture.amountReceivedCents !== order.totalCents ||
      capture.amountCents !== order.totalCents ||
      capture.currency !== order.currency ||
      capture.intentId !== e.intentId ||
      order.settlement?.outcome !== 'PAID' ||
      order.settlement.intentId !== e.intentId ||
      order.settlement.amountCents !== order.totalCents ||
      JSON.stringify(order.settlement) !== JSON.stringify(attempt.settlement)
    )
      throw conflict();
    const association = associationSchema.parse(
      await this.read(this.commerce, associationKey(this.scope, e.intentId)),
    );
    if (
      association.scope !== this.scope ||
      association.intentId !== e.intentId ||
      association.orderId !== id ||
      association.paymentAttemptId !== attempt.paymentAttemptId ||
      association.cartId !== order.cartId ||
      association.environment !== 'dev'
    )
      throw conflict();
    const cart = cartSchema.parse(
      await this.read(this.commerce, cartKey(order.cartId)),
    );
    const paid = paidEventSchema.parse(
      await this.read(this.operations, paidEventKey(id)),
    );
    if (
      cart.cartId !== order.cartId ||
      cart.orderId !== id ||
      cart.paymentAttemptId !== attempt.paymentAttemptId ||
      cart.dropId !== order.dropId ||
      cart.status !== 'CONVERTED' ||
      cart.recoveryRequired ||
      !isDeepStrictEqual(cart.settlement, order.settlement) ||
      !isDeepStrictEqual(
        settlementIdentity(cart, e, 'PAID'),
        order.settlement,
      ) ||
      cart.items.length !== order.items.length ||
      cart.items.some(
        (line) =>
          !order.items.some(
            (item) =>
              item.productId === line.productId &&
              item.quantity === line.quantity &&
              item.unitPriceCents === line.priceCents &&
              item.cookieUnits === line.cookieUnits,
          ),
      ) ||
      paid.orderId !== id ||
      paid.cartId !== order.cartId ||
      paid.paymentAttemptId !== attempt.paymentAttemptId ||
      paid.dropId !== order.dropId ||
      paid.settlementId !== order.settlement.id
    )
      throw conflict();
    const raw = await this.read(this.commerce, ledgerKey(id));
    const ledger = raw
      ? refundLedger.parse(raw)
      : refundLedger.parse({
          orderId: id,
          settlementId: order.settlement.id,
          capturedCents: capture.amountReceivedCents,
          refundedCents: 0,
          reservedCents: 0,
          revision: 0,
          active: null,
          returned: {},
          updatedAt: order.updatedAt,
        });
    const disposition = refundSchema.parse(
      await this.read(this.commerce, refundKey(id)),
    );
    const expected = ledger.active
      ? 'PENDING'
      : ledger.refundedCents === ledger.capturedCents
        ? 'FULL'
        : ledger.refundedCents
          ? 'PARTIAL'
          : 'NONE';
    if (
      ledger.orderId !== id ||
      ledger.settlementId !== order.settlement.id ||
      ledger.capturedCents !== capture.amountReceivedCents ||
      disposition.settlementId !== ledger.settlementId ||
      disposition.disposition !== expected ||
      (order.status === 'CANCELLED') !== (expected === 'FULL')
    )
      throw conflict();
    return {
      order,
      attempt,
      ledger,
      disposition,
      exists: !!raw,
      intentId: e.intentId,
      cart,
      paid,
    };
  }
  async view(id: string) {
    const s = await this.evidence(id);
    const r = await this.client.send(
      new QueryCommand({
        TableName: this.operations,
        KeyConditionExpression: 'PK=:pk',
        ExpressionAttributeValues: { ':pk': 'ORDER_REFUNDS#' + id },
        ConsistentRead: true,
        Limit: 25,
      }),
    );
    const audit = await this.client.send(
      new QueryCommand({
        TableName: this.operations,
        KeyConditionExpression: 'PK=:pk',
        ExpressionAttributeValues: { ':pk': 'REFUND_AUDIT#' + id },
        ConsistentRead: true,
        Limit: 25,
      }),
    );
    const currentLedger = await this.read(this.commerce, ledgerKey(id));
    if ((currentLedger?.revision ?? 0) !== s.ledger.revision) throw conflict();
    return {
      audit: (audit.Items ?? []).map(({ PK, SK, ...v }) => v),
      auditTruncated: !!audit.LastEvaluatedKey,
      capturedCents: s.ledger.capturedCents,
      refundedCents: s.ledger.refundedCents,
      reservedCents: s.ledger.reservedCents,
      remainingCents:
        s.ledger.capturedCents -
        s.ledger.refundedCents -
        s.ledger.reservedCents,
      currency: s.order.currency,
      operations: (r.Items ?? []).map(({ PK, SK, ...v }) =>
        refundOperation.parse(v),
      ),
      historyTruncated: !!r.LastEvaluatedKey,
      items: s.order.items.map((i) => ({
        productId: i.productId,
        name: i.name,
        quantity: i.quantity,
        returned: s.ledger.returned[i.productId] ?? 0,
      })),
    };
  }
  async authorize(id: string, value: unknown, administrator: string) {
    if (!administrator || administrator.length > 256)
      throw new AdminError(403, 'FORBIDDEN', 'Administrator required.');
    const input = refundInput.parse(value),
      fingerprint = digest(JSON.stringify([administrator, input]));
    const existing = await this.read(
      this.operations,
      refundOperationKey(id, input.operationId),
    );
    if (existing) {
      const op = await this.operation(id, input.operationId);
      if (op.fingerprint !== fingerprint) throw conflict();
      return op;
    }
    const s = await this.evidence(id),
      l = s.ledger;
    if (
      l.blocked ||
      l.active ||
      input.amountCents > l.capturedCents - l.refundedCents ||
      s.order.status !== 'PAID'
    )
      throw conflict();
    const rawRequest = await this.read(this.commerce, cancellationKey(id)),
      request = rawRequest ? cancellationState.parse(rawRequest) : null;
    if (
      request?.type === 'GUARANTEED' &&
      (input.amountCents !== l.capturedCents - l.refundedCents ||
        request.eligibility.settlementId !== l.settlementId ||
        request.eligibility.amountCents !== l.capturedCents ||
        request.eligibility.currency !== s.order.currency)
    )
      throw conflict();
    const fulfillment = await readFulfillment(this.client, this.commerce, id);
    if (input.disposition === 'RESTOCK') {
      if (fulfillment?.status === 'PICKED_UP') throw conflict();
      for (const i of input.items)
        if (
          i.quantity >
          (s.order.items.find((x) => x.productId === i.productId)?.quantity ??
            0) -
            (l.returned[i.productId] ?? 0)
        )
          throw conflict();
    }
    const at = this.time(l.updatedAt);
    const op = refundOperation.parse({
      ...input,
      orderId: id,
      administrator,
      fingerprint,
      intentId: s.intentId,
      accountId: this.provider.accountId,
      scope: this.scope,
      environment: 'dev',
      currency: s.order.currency,
      capturedCents: l.capturedCents,
      previousRefundedCents: l.refundedCents,
      settlementId: l.settlementId,
      idempotencyKey: 'refund:' + id + ':' + input.operationId,
      status: 'AUTHORIZED',
      revision: 0,
      checks: 0,
      createdAt: at,
      updatedAt: at,
      nextCheckAt: at,
    });
    const ledger = refundLedger.parse({
      ...l,
      active: op.operationId,
      reservedCents: input.amountCents,
      revision: l.revision + 1,
      updatedAt: at,
    });
    const actions: Actions = [
      {
        ConditionCheck: {
          TableName: this.commerce,
          Key: cartKey(s.order.cartId),
          ...guard({ status: 'CONVERTED', settlement: s.order.settlement }),
        },
      },
      {
        ConditionCheck: {
          TableName: this.operations,
          Key: paidEventKey(id),
          ...guard({
            settlementId: l.settlementId,
            orderId: id,
            paymentAttemptId: s.attempt.paymentAttemptId,
          }),
        },
      },
      {
        ConditionCheck: {
          TableName: this.commerce,
          Key: orderKey(id),
          ...guard({
            updatedAt: s.order.updatedAt,
            status: 'PAID',
            settlement: s.order.settlement,
          }),
        },
      },
      {
        ConditionCheck: {
          TableName: this.commerce,
          Key: attemptKey(s.attempt.paymentAttemptId),
          ...guard({
            updatedAt: s.attempt.updatedAt,
            execution: s.attempt.execution,
          }),
        },
      },
      {
        ConditionCheck: {
          TableName: this.commerce,
          Key: cancellationKey(id),
          ...(request
            ? guard({ revision: request.revision })
            : { ConditionExpression: 'attribute_not_exists(PK)' }),
        },
      },
      {
        ConditionCheck: {
          TableName: this.commerce,
          Key: fulfillmentKey(id),
          ...(fulfillment
            ? guard({ revision: fulfillment.revision })
            : { ConditionExpression: 'attribute_not_exists(PK)' }),
        },
      },
      {
        Put: {
          TableName: this.commerce,
          Item: { ...ledgerKey(id), ...ledger },
          ...(s.exists
            ? guard({ revision: l.revision })
            : { ConditionExpression: 'attribute_not_exists(PK)' }),
        },
      },
      {
        Put: {
          TableName: this.commerce,
          Item: {
            ...refundKey(id),
            disposition: 'PENDING',
            settlementId: l.settlementId,
            updatedAt: at,
          },
          ...guard({ ...s.disposition }),
        },
      },
      {
        Put: {
          TableName: this.operations,
          Item: { ...refundOperationKey(id, op.operationId), ...op },
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
      {
        Put: {
          TableName: this.operations,
          Item: {
            ...refundWorkKey(id, op.operationId),
            orderId: id,
            operationId: op.operationId,
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
      this.audit(op),
    ];
    try {
      await this.client.send(
        new TransactWriteCommand({ TransactItems: actions }),
      );
    } catch {
      const saved = await this.read(
        this.operations,
        refundOperationKey(id, op.operationId),
      );
      if (!saved || saved.fingerprint !== fingerprint) throw conflict();
      return this.operation(id, op.operationId);
    }
    return op;
  }
  private audit(op: RefundOperation): Actions[number] {
    return {
      Put: {
        TableName: this.operations,
        Item: {
          PK: 'REFUND_AUDIT#' + op.orderId,
          SK: op.operationId + '#' + String(op.revision).padStart(12, '0'),
          operationId: op.operationId,
          status: op.status,
          amountCents: op.amountCents,
          administrator: op.administrator,
          reason: op.reason,
          disposition: op.disposition,
          at: op.updatedAt,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    };
  }
  private async transition(
    old: RefundOperation,
    changes: Partial<RefundOperation>,
    extras: Actions = [],
  ) {
    const next = refundOperation.parse({
      ...old,
      ...changes,
      revision: old.revision + 1,
      updatedAt: this.time(old.updatedAt),
    });
    await this.client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.operations,
              Item: {
                ...refundOperationKey(old.orderId, old.operationId),
                ...next,
              },
              ...guard({ revision: old.revision, status: old.status }),
            },
          },
          this.audit(next),
          ...extras,
        ],
      }),
    );
    return next;
  }
  async webhook(value: {
    eventId: string;
    orderId: string;
    operationId: string;
    refundId: string;
  }) {
    const event = z
      .strictObject({
        eventId: z
          .string()
          .regex(/^evt_[A-Za-z0-9]+$/)
          .max(255),
        orderId: z.string(),
        operationId: z.uuid(),
        refundId: z
          .string()
          .regex(/^re_[A-Za-z0-9]+$/)
          .max(255),
      })
      .parse(value);
    const op = await this.operation(event.orderId, event.operationId);
    const snapshot = await this.provider.reconcile(op);
    if (
      !snapshot ||
      snapshot.id !== event.refundId ||
      snapshot.operationId !== op.operationId ||
      snapshot.accountId !== op.accountId ||
      snapshot.environment !== op.environment ||
      snapshot.amountCents !== op.amountCents ||
      snapshot.intentId !== op.intentId ||
      snapshot.orderId !== op.orderId ||
      snapshot.currency !== op.currency
    )
      throw conflict();
    const key = { PK: 'REFUND_EVENT#' + event.eventId, SK: 'META' };
    const old = await this.read(this.operations, key);
    if (old && !isDeepStrictEqual(old, event)) throw conflict();
    if (!old) {
      try {
        await this.client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: this.operations,
                  Item: { ...key, ...event },
                  ConditionExpression: 'attribute_not_exists(PK)',
                },
              },
            ],
          }),
        );
      } catch {
        const retry = await this.read(this.operations, key);
        if (!retry || !isDeepStrictEqual(retry, event)) throw conflict();
      }
    }
    if (['SUCCEEDED', 'FAILED', 'CANCELED'].includes(op.status)) {
      if (snapshot.status.toUpperCase() !== op.status) {
        const s = await this.evidence(op.orderId);
        await this.transition(op, { status: 'RECONCILIATION_REQUIRED' }, [
          {
            Put: {
              TableName: this.commerce,
              Item: {
                ...ledgerKey(op.orderId),
                ...s.ledger,
                blocked: true,
                revision: s.ledger.revision + 1,
              },
              ...guard({ revision: s.ledger.revision }),
            },
          },
        ]);
      }
      return;
    }
    // Signed events are wakeups only; canonical retrieval determines the result.
    await this.run(event.orderId, event.operationId, true);
  }
  async run(id: string, operationId: string, wake = false) {
    let op = await this.operation(id, operationId);
    if (
      ['SUCCEEDED', 'FAILED', 'CANCELED'].includes(op.status) ||
      (!wake && this.now() < Date.parse(op.nextCheckAt))
    )
      return op;
    const authority = await this.evidence(id);
    const ledger = authority.ledger;
    if (
      ledger.blocked ||
      ledger.active !== op.operationId ||
      ledger.reservedCents !== op.amountCents ||
      ledger.capturedCents !== op.capturedCents ||
      ledger.refundedCents !== op.previousRefundedCents ||
      ledger.settlementId !== op.settlementId ||
      authority.intentId !== op.intentId ||
      authority.order.currency !== op.currency
    )
      throw conflict();
    if (op.status === 'AUTHORIZED') {
      op = await this.transition(op, { status: 'DISPATCHED' }, [
        {
          ConditionCheck: {
            TableName: this.commerce,
            Key: ledgerKey(id),
            ...guard({
              revision: ledger.revision,
              active: op.operationId,
              blocked: false,
            }),
          },
        },
      ]);
      // Claim once before side effect. Lost acknowledgement NEVER permits another create.
      try {
        await this.provider.create(op);
      } catch {
        /* retain durable reservation */
      }
    }
    let snapshot;
    try {
      snapshot = await this.provider.reconcile(op);
    } catch {
      snapshot = null;
    }
    if (snapshot) {
      const r = refundSnapshot.parse(snapshot);
      if (
        r.operationId !== op.operationId ||
        r.orderId !== id ||
        r.intentId !== op.intentId ||
        r.accountId !== op.accountId ||
        r.environment !== op.environment ||
        r.amountCents !== op.amountCents ||
        r.currency !== op.currency ||
        (op.providerId && r.id !== op.providerId)
      )
        throw conflict();
      if (['succeeded', 'failed', 'canceled'].includes(r.status))
        return this.finish(
          op,
          r.id,
          r.status as 'succeeded' | 'failed' | 'canceled',
        );
      return this.transition(op, {
        status: r.status === 'pending' ? 'PENDING' : 'RECONCILIATION_REQUIRED',
        providerId: r.id,
        checks: op.checks + 1,
        nextCheckAt: this.next(op),
      });
    }
    return this.transition(op, {
      status: 'RECONCILIATION_REQUIRED',
      checks: op.checks + 1,
      nextCheckAt: this.next(op),
    });
  }
  private next(op: RefundOperation) {
    return new Date(
      this.now() + Math.min(900000, 60000 * 2 ** Math.min(op.checks, 4)),
    ).toISOString();
  }
  private async finish(
    op: RefundOperation,
    providerId: string,
    result: 'succeeded' | 'failed' | 'canceled',
  ) {
    const s = await this.evidence(op.orderId),
      l = s.ledger,
      id = op.orderId;
    if (
      l.active !== op.operationId ||
      l.reservedCents !== op.amountCents ||
      l.settlementId !== op.settlementId
    )
      throw conflict();
    const success = result === 'succeeded',
      at = this.time(l.updatedAt),
      refundedCents = l.refundedCents + (success ? op.amountCents : 0),
      returned = { ...l.returned },
      actions: Actions = [];
    if (success && op.disposition === 'RESTOCK') {
      const f = await readFulfillment(this.client, this.commerce, id);
      if (f?.status === 'PICKED_UP') throw conflict();
      actions.push({
        ConditionCheck: {
          TableName: this.commerce,
          Key: fulfillmentKey(id),
          ...(f
            ? guard({ revision: f.revision })
            : { ConditionExpression: 'attribute_not_exists(PK)' }),
        },
      });
      for (const item of op.items) {
        const key = catalogKeys.inventory(s.order.dropId, item.productId),
          inventory = inventorySchema.parse(await this.read(this.catalog, key));
        if (
          inventory.dropId !== s.order.dropId ||
          inventory.productId !== item.productId ||
          inventory.sold < item.quantity ||
          (returned[item.productId] ?? 0) + item.quantity >
            (s.order.items.find((i) => i.productId === item.productId)
              ?.quantity ?? 0)
        )
          throw conflict();
        returned[item.productId] =
          (returned[item.productId] ?? 0) + item.quantity;
        actions.push({
          Put: {
            TableName: this.catalog,
            Item: {
              ...key,
              ...inventorySchema.parse({
                ...inventory,
                sold: inventory.sold - item.quantity,
                updatedAt: this.time(inventory.updatedAt),
              }),
            },
            ...guard({
              total: inventory.total,
              reserved: inventory.reserved,
              sold: inventory.sold,
              updatedAt: inventory.updatedAt,
            }),
          },
        });
      }
      actions.push({
        Put: {
          TableName: this.operations,
          Item: {
            PK: 'REFUND_INVENTORY#' + id,
            SK: op.operationId,
            items: op.items,
            administrator: op.administrator,
            reason: op.reason,
            physicallyAvailable: true,
            at,
            waitlistNotification: 'NOT_DISPATCHED',
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      });
    }
    const ledger = refundLedger.parse({
        ...l,
        lastStatus: success
          ? 'SUCCEEDED'
          : result === 'failed'
            ? 'FAILED'
            : 'CANCELED',
        refundedCents,
        reservedCents: 0,
        active: null,
        returned,
        revision: l.revision + 1,
        updatedAt: at,
      }),
      full = refundedCents === l.capturedCents;
    actions.push(
      {
        Put: {
          TableName: this.commerce,
          Item: { ...ledgerKey(id), ...ledger },
          ...guard({ revision: l.revision, active: op.operationId }),
        },
      },
      {
        Put: {
          TableName: this.commerce,
          Item: {
            ...refundKey(id),
            disposition: full ? 'FULL' : refundedCents ? 'PARTIAL' : 'NONE',
            settlementId: l.settlementId,
            updatedAt: at,
          },
          ...guard({ ...s.disposition }),
        },
      },
      {
        Put: {
          TableName: this.commerce,
          Item: {
            ...orderKey(id),
            ...orderSchema.parse({
              ...s.order,
              status: full ? 'CANCELLED' : 'PAID',
              updatedAt: this.time(s.order.updatedAt),
            }),
          },
          ...guard({
            updatedAt: s.order.updatedAt,
            settlement: s.order.settlement,
          }),
        },
      },
      {
        Delete: {
          TableName: this.operations,
          Key: refundWorkKey(id, op.operationId),
        },
      },
    );
    if (success)
      actions.push({
        Put: {
          TableName: this.operations,
          Item: {
            PK: 'REFUND_COMPLETION#' + id,
            SK: op.operationId,
            orderId: id,
            operationId: op.operationId,
            amountCents: op.amountCents,
            currency: op.currency,
            cumulativeCents: refundedCents,
            providerId,
            status: 'PREPARED',
            createdAt: at,
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      });
    if (success) {
      const notification: Operation = {
        orderId: id,
        key: 'REFUND#' + op.operationId + '#email',
        kind: 'REFUND',
        channel: 'email',
        pickupDate: s.order.pickup.date,
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
            Item: { ...operationKey(id, notification.key), ...notification },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
        {
          Put: {
            TableName: this.operations,
            Item: {
              ...dueKey(notification),
              orderId: id,
              key: notification.key,
            },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
      );
    }
    return this.transition(
      op,
      {
        providerId,
        status: success
          ? 'SUCCEEDED'
          : result === 'failed'
            ? 'FAILED'
            : 'CANCELED',
        checks: op.checks + 1,
      },
      actions,
    );
  }
}
