import { waitlistMessage } from './waitlists';
import {
  refundOperation,
  refundOperationKey,
  refundLedger,
  ledgerKey,
} from './refund-domain';
import { cancellationKey, cancellationState } from './cancellation-requests';
import {
  GetCommand,
  QueryCommand,
  PutCommand,
  DeleteCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { AdminOrders } from './admin-orders';
import { readFulfillment } from './fulfillment-state';
import { orderSchema } from './payment-domain';
import { idSchema, dateSchema } from './domain';
import {
  refundKey,
  refundSchema,
  consentKey,
  consentSchema,
  suppressionKey,
  suppressionSchema,
  digest,
  eventWork,
  operationKey,
  operationSchema,
  dueKey,
  reminderSchedule,
  type Operation,
} from './notification-contract';
import {
  DeliveryFailure,
  type MessageProvider,
} from './notification-providers';
type Client = Pick<DynamoDBDocumentClient, 'send'>;
type Order = z.infer<typeof orderSchema>;
export interface NotificationTransport {
  enqueue(message: NotificationMessage): Promise<void>;
  schedule(schedule: ReturnType<typeof reminderSchedule>): Promise<void>;
}
export const notificationMessage = z.discriminatedUnion('type', [
  waitlistMessage,
  z.strictObject({
    type: z.literal('DELIVERY'),
    orderId: idSchema,
    key: operationSchema.shape.key,
  }),
  z.strictObject({
    type: z.literal('REMINDER'),
    date: dateSchema,
    cursor: z.string().max(4096).optional(),
  }),
]);
export type NotificationMessage = z.infer<typeof notificationMessage>;
const paidEvent = z.strictObject({
  schemaVersion: z.literal(1),
  eventType: z.literal('PAID'),
  orderId: idSchema,
  cartId: idSchema,
  paymentAttemptId: idSchema,
  dropId: idSchema,
  settlementId: z.string().min(1),
  createdAt: z.iso.datetime(),
});
function withoutKeys(row: Record<string, unknown>) {
  const { PK, SK, ...data } = row;
  return data;
}
function conflict(e: unknown) {
  return (
    e instanceof Error &&
    [
      'ConditionalCheckFailedException',
      'TransactionCanceledException',
    ].includes(e.name)
  );
}
export class Notifications {
  private orders: AdminOrders;
  constructor(
    private client: Client,
    private commerce: string,
    private operations: string,
    private transport: NotificationTransport,
    private providers: { email: MessageProvider; sms: MessageProvider },
    private options: {
      policies: string;
      issueManagementLink?: (operation: Operation) => Promise<string>;
      reminderTime?: string;
      now?: () => number;
    },
  ) {
    if (!commerce || !operations || !options.policies.trim())
      throw Error('Notification configuration required');
    this.orders = new AdminOrders(client, commerce);
    reminderSchedule('2030-01-01', options.reminderTime);
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }
  private iso() {
    return new Date(this.now()).toISOString();
  }
  private localTime() {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Denver',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(this.now()));
    const get = (key: string) => parts.find((p) => p.type === key)!.value;
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:00`;
  }
  private async read(table: string, key: { PK: string; SK: string }) {
    const r = await this.client.send(
      new GetCommand({ TableName: table, Key: key, ConsistentRead: true }),
    );
    return r.Item ? withoutKeys(r.Item) : null;
  }
  private async authority(order: Order) {
    const raw = await this.read(this.operations, {
      PK: 'ORDER_EVENT#' + order.orderId + '#PAID',
      SK: 'META',
    });
    const event = paidEvent.safeParse(raw);
    return (
      event.success &&
      order.status === 'PAID' &&
      order.paymentStatus === 'CAPTURED' &&
      order.settlement?.outcome === 'PAID' &&
      order.settlement.id === event.data.settlementId &&
      event.data.orderId === order.orderId &&
      event.data.cartId === order.cartId &&
      event.data.paymentAttemptId === order.paymentAttemptId &&
      event.data.dropId === order.dropId
    );
  }
  private async eligibility(
    order: Order,
    o: Pick<Operation, 'kind' | 'channel' | 'pickupDate'> & { key?: string },
  ): Promise<string | null> {
    if (o.kind === 'REFUND') {
      if (!o.key || o.channel !== 'email') return 'REFUND_UNVERIFIED';
      const op = refundOperation.safeParse(
        await this.read(
          this.operations,
          refundOperationKey(order.orderId, o.key.split('#')[1]),
        ),
      );
      const ledger = refundLedger.safeParse(
        await this.read(this.commerce, ledgerKey(order.orderId)),
      );
      return op.success &&
        ledger.success &&
        !ledger.data.blocked &&
        op.data.orderId === order.orderId &&
        op.data.operationId === o.key.split('#')[1] &&
        ledger.data.orderId === order.orderId &&
        op.data.status === 'SUCCEEDED' &&
        !!op.data.providerId &&
        op.data.settlementId === order.settlement?.id &&
        ledger.data.settlementId === order.settlement?.id &&
        ledger.data.refundedCents >= op.data.amountCents
        ? null
        : 'REFUND_UNVERIFIED';
    }
    if (!(await this.authority(order))) return 'PAYMENT_NOT_ELIGIBLE';
    if (o.kind === 'PICKUP_CHANGE' && order.pickup.date !== o.pickupDate)
      return 'PICKUP_CHANGED';
    if (o.kind === 'REMINDER') {
      const request = await this.read(
        this.commerce,
        cancellationKey(order.orderId),
      );
      if (request) {
        const parsed = cancellationState.safeParse(request);
        if (!parsed.success || parsed.data.orderId !== order.orderId)
          return 'CANCELLATION_REQUIRES_REVIEW';
        if (parsed.data.type === 'GUARANTEED')
          return 'CANCELLATION_REQUEST_PENDING';
      }

      if (order.pickup.date !== o.pickupDate) return 'PICKUP_CHANGED';
      const local = this.localTime().slice(0, 10);
      if (
        this.localTime() <
        reminderSchedule(
          o.pickupDate,
          this.options.reminderTime,
        ).expression.slice(3, -1)
      )
        return 'REMINDER_NOT_DUE';
      if (local >= o.pickupDate) return 'REMINDER_WINDOW_CLOSED';
      const refund = refundSchema.safeParse(
        await this.read(this.commerce, refundKey(order.orderId)),
      );
      if (!refund.success || refund.data.settlementId !== order.settlement?.id)
        return 'REFUND_UNKNOWN';
      if (refund.data.disposition !== 'NONE')
        return 'REFUND_' + refund.data.disposition;
      const f = await readFulfillment(
        this.client,
        this.commerce,
        order.orderId,
      );
      if (f?.status === 'PICKED_UP' || f?.status === 'MISSED_PICKUP')
        return 'FULFILLMENT_NOT_ELIGIBLE';
    }
    if (o.channel === 'sms') {
      const consent = consentSchema.safeParse(
        await this.read(this.commerce, consentKey(order.orderId)),
      );
      if (
        !consent.success ||
        consent.data.phone !== order.customer.phone ||
        !consent.data.smsTransactionalConsent ||
        !consent.data.consentedAt ||
        Date.parse(consent.data.consentedAt) > this.now() ||
        consent.data.optOutAt
      )
        return 'SMS_CONSENT_UNVERIFIED';
      const current = suppressionSchema.safeParse(
        await this.read(this.operations, suppressionKey(order.customer.phone)),
      );
      if (
        !current.success ||
        current.data.phoneHash !== digest(order.customer.phone) ||
        Date.parse(current.data.verifiedAt) > this.now() ||
        this.now() - Date.parse(current.data.verifiedAt) > 86400000
      )
        return 'SMS_SUPPRESSION_UNVERIFIED';
      if (current.data.optOutAt) return 'SMS_OPTED_OUT';
    }
    return null;
  }
  private async create(
    order: Order,
    kind: Operation['kind'],
    channel: Operation['channel'],
  ) {
    const key =
      kind === 'CONFIRMATION'
        ? 'CONFIRMATION#email'
        : `REMINDER#${order.pickup.date}#${channel}`;
    const candidate = { kind, channel, pickupDate: order.pickup.date };
    const reason = await this.eligibility(order, candidate);
    const o: Operation = {
      ...candidate,
      orderId: order.orderId,
      key,
      status: reason ? 'SUPPRESSED' : 'PENDING',
      attempts: 0,
      revision: 0,
      createdAt: this.iso(),
      updatedAt: this.iso(),
      ...(reason ? { reason } : {}),
    };
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.operations,
                Item: { ...operationKey(o.orderId, o.key), ...o },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            ...(!reason
              ? [
                  {
                    Put: {
                      TableName: this.operations,
                      Item: { ...dueKey(o), orderId: o.orderId, key: o.key },
                      ConditionExpression: 'attribute_not_exists(PK)',
                    },
                  },
                ]
              : []),
          ],
        }),
      );
    } catch (e) {
      if (!conflict(e)) throw e;
      const existing = await this.operation(o.orderId, o.key);
      if (!existing) throw e;
    }
  }
  private async operation(id: string, key: string) {
    const raw = await this.read(this.operations, operationKey(id, key));
    if (!raw) return null;
    const o = operationSchema.parse(raw);
    if (o.orderId !== id || o.key !== key)
      throw Error('Notification identity mismatch');
    return o;
  }
  async confirmation(orderId: string) {
    idSchema.parse(orderId);
    const order = await this.orders.get(orderId);
    if (!order || !(await this.authority(order))) return;
    await this.create(order, 'CONFIRMATION', 'email');
    const schedule = reminderSchedule(
      order.pickup.date,
      this.options.reminderTime,
    );
    // Past dates are not scheduled; receipt delivery is independent of scheduling.
    if (schedule.expression.slice(3, -1) > this.localTime())
      await this.transport.schedule(schedule);
    else if (order.pickup.date > this.localTime().slice(0, 10))
      await this.transport.enqueue({
        type: 'REMINDER',
        date: order.pickup.date,
      });
    await this.client.send(
      new DeleteCommand({
        TableName: this.operations,
        Key: { PK: eventWork(orderId).PK, SK: eventWork(orderId).SK },
      }),
    );
  }
  async reminders(date: string, cursor?: string) {
    dateSchema.parse(date);
    if (
      this.localTime() <
      reminderSchedule(date, this.options.reminderTime).expression.slice(3, -1)
    )
      throw Error('Reminder is not due');
    const page = await this.orders.list({
      pickupDate: date,
      status: 'PAID',
      cursor,
    });
    for (const summary of page.orders) {
      const order = await this.orders.get(summary.orderId);
      if (!order || order.pickup.date !== date) continue;
      await this.create(order, 'REMINDER', 'email');
      await this.create(order, 'REMINDER', 'sms');
    }
    if (page.nextCursor)
      await this.transport.enqueue({
        type: 'REMINDER',
        date,
        cursor: page.nextCursor,
      });
  }
  async poll() {
    for (let i = 0; i < 16; i++)
      for (const type of [
        'NOTIFICATION_EVENTS',
        'NOTIFICATION_DUE',
        'NOTIFICATION_PICKUP_EVENTS',
      ]) {
        const r = await this.client.send(
          new QueryCommand({
            TableName: this.operations,
            KeyConditionExpression: 'PK=:pk',
            ExpressionAttributeValues: {
              ':pk': type + '#' + String(i).padStart(2, '0'),
            },
            ConsistentRead: true,
            Limit: 20,
          }),
        );
        for (const row of r.Items ?? []) {
          if (type === 'NOTIFICATION_EVENTS')
            await this.confirmation(idSchema.parse(row.orderId));
          else if (type === 'NOTIFICATION_PICKUP_EVENTS') {
            const date = dateSchema.parse(row.pickupDate),
              schedule = reminderSchedule(date, this.options.reminderTime);
            if (schedule.expression.slice(3, -1) > this.localTime())
              await this.transport.schedule(schedule);
            // A changed date whose reminder time passed is not retroactively sent.
            await this.client.send(
              new DeleteCommand({
                TableName: this.operations,
                Key: { PK: row.PK, SK: row.SK },
              }),
            );
          } else
            await this.transport.enqueue(
              notificationMessage.parse({
                type: 'DELIVERY',
                orderId: row.orderId,
                key: row.key,
              }),
            );
        }
      }
  }
  private async transition(
    o: Operation,
    status: Operation['status'],
    reason?: string,
    attempt = false,
  ) {
    const { reason: previousReason, ...prior } = o;
    const next: Operation = {
      ...prior,
      status,
      revision: o.revision + 1,
      attempts: o.attempts + (attempt ? 1 : 0),
      updatedAt: this.iso(),
      ...(reason ? { reason } : {}),
      ...(status === 'SENT' ? { sentAt: this.iso() } : {}),
    };
    await this.client.send(
      new PutCommand({
        TableName: this.operations,
        Item: { ...operationKey(o.orderId, o.key), ...next },
        ConditionExpression: 'revision=:revision AND #status=:status',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':revision': o.revision,
          ':status': o.status,
        },
      }),
    );
    return next;
  }
  async deliver(id: string, key: string) {
    idSchema.parse(id);
    operationSchema.shape.key.parse(key);
    let o = await this.operation(id, key);
    if (!o) return;
    if (['SENT', 'SUPPRESSED', 'FAILED', 'UNCERTAIN'].includes(o.status)) {
      await this.client.send(
        new DeleteCommand({ TableName: this.operations, Key: dueKey(o) }),
      );
      return;
    }
    if (o.status === 'DISPATCHED') {
      if (this.now() - Date.parse(o.updatedAt) > 300000) {
        try {
          await this.transition(
            o,
            'UNCERTAIN',
            'DELIVERY_ACKNOWLEDGEMENT_UNKNOWN',
          );
        } catch (e) {
          if (!conflict(e)) throw e;
        }
      }
      return;
    }
    if (o.attempts >= 3) {
      await this.transition(o, 'FAILED', 'RETRY_LIMIT');
      return;
    }
    let order = await this.orders.get(id);
    let reason = order ? await this.eligibility(order, o) : 'ORDER_UNAVAILABLE';
    if (reason) {
      await this.transition(o, 'SUPPRESSED', reason);
      return;
    }
    try {
      o = await this.transition(o, 'DISPATCHED', undefined, true);
    } catch (e) {
      if (conflict(e)) return;
      throw e;
    }
    // Re-read all mutable authority immediately before the external side effect.
    try {
      order = await this.orders.get(id);
      reason = order ? await this.eligibility(order, o) : 'ORDER_UNAVAILABLE';
      if (reason) {
        await this.transition(o, 'SUPPRESSED', reason);
        return;
      }
    } catch {
      await this.transition(o, 'UNCERTAIN', 'ELIGIBILITY_CHECK_FAILED');
      return;
    }
    const value = order!;
    const title =
      o.kind === 'REFUND'
        ? 'Your Batch & Batter refund is completed'
        : o.kind === 'CONFIRMATION'
          ? 'Your Batch & Batter order'
          : o.kind === 'REQUEST'
            ? 'Your bakery assistance request has been received'
            : o.kind === 'ACCESS'
              ? 'Your Batch & Batter order link'
              : o.kind === 'PICKUP_CHANGE'
                ? 'Your Batch & Batter pickup has changed'
                : 'Your Batch & Batter pickup reminder';
    const refund =
      o.kind === 'REFUND'
        ? refundOperation.parse(
            await this.read(
              this.operations,
              refundOperationKey(id, o.key.split('#')[1]),
            ),
          )
        : null;
    const text = [
      title,
      value.displayOrderNumber
        ? `Order ${value.displayOrderNumber}`
        : 'Your order',
      ...(refund
        ? [
            `Refund completed: ${(refund.amountCents / 100).toFixed(2)} ${refund.currency.toUpperCase()}. Your bank may take additional time to post it.`,
          ]
        : []),
      ...value.items.map((i) => `${i.quantity} × ${i.name}`),
      `Total: ${(value.totalCents / 100).toFixed(2)} ${value.currency.toUpperCase()}`,
      ...(refund
        ? []
        : [
            `Pickup: ${value.pickup.date}, ${value.pickup.startTime}–${value.pickup.endTime} America/Denver`,
            value.pickup.location,
            value.pickup.instructions,
          ]),
      ...(o.kind === 'REQUEST'
        ? [
            'Your cancellation or refund-exception request has been received. This records your request only; it does not mean a refund has started. This message does not confirm cancellation or a refund.',
          ]
        : []),
      this.options.policies,
    ].join('\n');
    let link: string | undefined;
    if (
      this.options.issueManagementLink &&
      ['CONFIRMATION', 'ACCESS'].includes(o.kind)
    ) {
      try {
        link = await this.options.issueManagementLink(o);
      } catch {
        await this.transition(
          o,
          'UNCERTAIN',
          'ACCESS_ISSUANCE_REQUIRES_RECONCILIATION',
        );
        return;
      }
    }
    if (o.kind === 'ACCESS' && !link) {
      await this.transition(o, 'FAILED', 'ACCESS_ISSUER_UNAVAILABLE');
      return;
    }
    try {
      await this.providers[o.channel].send({
        to: o.channel === 'email' ? value.customer.email : value.customer.phone,
        subject: title,
        text: link ? text + '\nManage your order: ' + link : text,
        operationId: digest(id + '#' + key),
      });
    } catch (e) {
      await this.transition(
        o,
        e instanceof DeliveryFailure
          ? !link && e.retryable && o.attempts < 3
            ? 'PENDING'
            : 'FAILED'
          : 'UNCERTAIN',
        e instanceof DeliveryFailure
          ? 'PROVIDER_REJECTED'
          : 'DELIVERY_ACKNOWLEDGEMENT_UNKNOWN',
      );
      return;
    }
    // A failed persistence acknowledgement must never be interpreted as permission to send again.
    await this.transition(o, 'SENT');
  }
  async handle(input: unknown) {
    const m = notificationMessage.parse(input);
    if (m.type === 'DELIVERY') await this.deliver(m.orderId, m.key);
    else if (m.type === 'REMINDER') await this.reminders(m.date, m.cursor);
    else throw Error('Waitlist worker is not configured');
  }
}
