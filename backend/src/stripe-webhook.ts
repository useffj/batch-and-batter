import Stripe from 'stripe';
import { z } from 'zod';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hash } from './cart-domain';
import { canonicalTime } from './cart-expiry';
import {
  intentId,
  paymentMessage,
  paymentMessageSchema,
  type PaymentMessage,
} from './payment-execution-domain';
import {
  readPayment,
  PaymentWorkflow,
  type PaymentClient,
} from './payment-workflow';
import type { ApiEvent } from './api';

export {
  webhookTypes,
  eventReceiptSchema,
  inboxSchema,
  eventWorkKey,
} from './stripe-inbox-domain';
import {
  webhookTypes,
  eventReceiptSchema,
  inboxSchema,
  eventWorkKey,
  receiptKey,
} from './stripe-inbox-domain';
export class StripeInbox {
  constructor(
    readonly client: PaymentClient,
    readonly operations: string,
    readonly scope: string,
    readonly now = () => Date.now(),
    readonly dispatch?: (m: PaymentMessage) => Promise<void>,
  ) {}
  async accept(
    input: {
      eventId: string;
      intentId: string;
      eventType: (typeof webhookTypes)[number];
    },
    retry = false,
  ): Promise<void> {
    const key = receiptKey(input.eventId);
    const prior = await readPayment(
      this.client,
      this.operations,
      key,
      eventReceiptSchema,
    );
    if (prior) {
      if (
        prior.scope !== this.scope ||
        prior.intentId !== input.intentId ||
        prior.eventType !== input.eventType
      )
        throw new Error('EVENT_CONFLICT');
      if (prior.state === 'PROCESSED') return;
      const work = await readPayment(
        this.client,
        this.operations,
        prior.work,
        inboxSchema,
      );
      if (!work) {
        // Repair only an absent obligation at the SAME original key. Receipt CAS prevents
        // resurrection if another processor has already marked the event PROCESSED.
        const expected = eventWorkKey(prior.eventId, prior.createdAt);
        if (prior.work.PK !== expected.PK || prior.work.SK !== expected.SK)
          throw new Error('INBOX_CONFLICT');
        await this.client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: this.operations,
                  Item: { ...prior, revision: prior.revision + 1, ...key },
                  ConditionExpression:
                    '#state = :state AND #revision = :revision',
                  ExpressionAttributeNames: {
                    '#state': 'state',
                    '#revision': 'revision',
                  },
                  ExpressionAttributeValues: {
                    ':state': 'RECEIVED',
                    ':revision': prior.revision,
                  },
                },
              },
              {
                Put: {
                  TableName: this.operations,
                  Item: {
                    ...expected,
                    schemaVersion: 3,
                    deadlineType: 'STRIPE_EVENT',
                    eventId: prior.eventId,
                    deadline: prior.createdAt,
                    createdAt: prior.createdAt,
                    revision: prior.work.revision,
                  },
                  ConditionExpression: 'attribute_not_exists(PK)',
                },
              },
            ],
          }),
          { abortSignal: AbortSignal.timeout(1500) },
        );
      } else if (
        work.eventId !== prior.eventId ||
        work.revision !== prior.work.revision
      )
        throw new Error('INBOX_CONFLICT');
      try {
        await this.dispatch?.(paymentMessage(prior.work, 'STRIPE_EVENT'));
      } catch {
        /* durable inbox remains */
      }
      return;
    }
    const createdAt = new Date(this.now()).toISOString();
    const workKey = eventWorkKey(input.eventId, createdAt);
    const receipt = eventReceiptSchema.parse({
      ...input,
      scope: this.scope,
      state: 'RECEIVED',
      createdAt,
      revision: 0,
      work: { ...workKey, revision: 0 },
    });
    const work = inboxSchema.parse({
      schemaVersion: 3,
      deadlineType: 'STRIPE_EVENT',
      eventId: input.eventId,
      deadline: createdAt,
      createdAt,
      revision: 0,
    });
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.operations,
                Item: { ...receipt, ...key },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            {
              Put: {
                TableName: this.operations,
                Item: { ...work, ...workKey },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
          ],
        }),
        { abortSignal: AbortSignal.timeout(1500) },
      );
    } catch {
      const committed = await readPayment(
        this.client,
        this.operations,
        key,
        eventReceiptSchema,
      );
      if (!committed || retry) throw new Error('INBOX_UNAVAILABLE');
      // Resolve a concurrent accept/lost transaction response through durable authority.
      return this.accept(input, true);
    }
    try {
      await this.dispatch?.(paymentMessage(receipt.work, 'STRIPE_EVENT'));
    } catch {
      /* future reconciler discovers work */
    }
  }
  async process(message: PaymentMessage, workflow: PaymentWorkflow) {
    paymentMessageSchema.parse(message);
    const work = await readPayment(
      this.client,
      this.operations,
      message,
      inboxSchema,
    );
    if (!work || work.revision !== message.revision) return 'STALE_WORK';
    const receipt = await readPayment(
      this.client,
      this.operations,
      receiptKey(work.eventId),
      eventReceiptSchema,
    );
    if (
      !receipt ||
      receipt.state !== 'RECEIVED' ||
      receipt.scope !== this.scope ||
      receipt.work.PK !== message.PK ||
      receipt.work.SK !== message.SK
    )
      throw new Error('INBOX_CONFLICT');
    const financial = await workflow.processFinancialInbox?.(receipt, message);
    if (financial !== undefined) return financial;
    const p = await workflow.provider.retrieveIntent(receipt.intentId);
    const attempt = await workflow.attempt(p.metadata.paymentAttemptId);
    if (!attempt?.execution || attempt.execution.scope !== this.scope)
      return 'AWAITING_ASSOCIATION';
    const state = await workflow.load(
      paymentMessage(attempt.execution.workflow),
    );
    if (!state) return 'AWAITING_ASSOCIATION';
    if (!state.e.intentId) {
      // A signed event is only a wake-up. Binding requires validated current provider state
      // and an already-durable dispatched create command belonging to this Attempt.
      if (state.e.create.state !== 'DISPATCHED') return 'AWAITING_ASSOCIATION';
      await workflow.bind(state, p);
    } else {
      if (state.e.intentId !== p.id) {
        await workflow.recover(state, 'ASSOCIATION_CONFLICT');
        return 'QUARANTINED';
      }
      // Never turn a stale created event into failure before initial confirmation.
      if (!['CREATE_INTENT', 'BIND_INTENT', 'CONFIRM'].includes(state.e.stage))
        await workflow.observe(state, p);
    }
    // Durable workflow already owns further processing. Guard that authority while
    // completing the inbox; no inventory settlement occurs in this phase.
    const current = await workflow.attempt(attempt.paymentAttemptId);
    if (
      !current?.execution?.intentId ||
      current.execution.intentId !== receipt.intentId
    )
      return 'AWAITING_ASSOCIATION';
    const authority = await workflow.load(
      paymentMessage(current.execution.workflow),
    );
    if (!authority) return 'AWAITING_ASSOCIATION';
    await this.client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: workflow.commerce,
              Key: {
                PK: `PAYMENT_ATTEMPT#${attempt.paymentAttemptId}`,
                SK: 'META',
              },
              ConditionExpression: '#updated = :updated',
              ExpressionAttributeNames: { '#updated': 'updatedAt' },
              ExpressionAttributeValues: { ':updated': current.updatedAt },
            },
          },
          {
            ConditionCheck: {
              TableName: this.operations,
              Key: {
                PK: current.execution.workflow.PK,
                SK: current.execution.workflow.SK,
              },
              ConditionExpression: '#revision = :revision',
              ExpressionAttributeNames: { '#revision': 'revision' },
              ExpressionAttributeValues: {
                ':revision': current.execution.workflow.revision,
              },
            },
          },
          {
            Put: {
              TableName: this.operations,
              Item: {
                ...receipt,
                state: 'PROCESSED',
                revision: receipt.revision + 1,
                ...receiptKey(work.eventId),
              },
              ConditionExpression: '#state = :state AND #revision = :revision',
              ExpressionAttributeNames: {
                '#state': 'state',
                '#revision': 'revision',
              },
              ExpressionAttributeValues: {
                ':state': 'RECEIVED',
                ':revision': receipt.revision,
              },
            },
          },
          {
            Delete: {
              TableName: this.operations,
              Key: { PK: message.PK, SK: message.SK },
              ConditionExpression: '#revision = :revision',
              ExpressionAttributeNames: { '#revision': 'revision' },
              ExpressionAttributeValues: { ':revision': message.revision },
            },
          },
        ],
      }),
      { abortSignal: AbortSignal.timeout(1500) },
    );
    return 'TRANSFERRED';
  }
}
export function createStripeWebhook(
  inbox: StripeInbox,
  config: {
    signingSecret: string;
    scope: string;
    accountId: string;
    toleranceSeconds?: number;
    refundEvent?: (event: {
      eventId: string;
      orderId: string;
      operationId: string;
      refundId: string;
    }) => Promise<void>;
  },
  now = () => Date.now(),
) {
  if (
    config.scope !== inbox.scope ||
    !config.signingSecret ||
    !/^acct_[a-zA-Z0-9]+$/.test(config.accountId)
  )
    throw new Error('INVALID_WEBHOOK_CONFIG');
  return async (
    event: Pick<ApiEvent, 'body' | 'headers' | 'isBase64Encoded'>,
  ) => {
    let statusCode = 200;
    try {
      if (typeof event.body !== 'string') throw new Error('INVALID_WEBHOOK');
      if (event.body.length > 4 * 256 * 1024) {
        statusCode = 413;
        throw new Error('TOO_LARGE');
      }
      const bytes = Buffer.from(
        event.body,
        event.isBase64Encoded ? 'base64' : 'utf8',
      );
      if (bytes.length > 256 * 1024) {
        statusCode = 413;
        throw new Error('TOO_LARGE');
      }
      const signatures = Object.entries(event.headers ?? {}).filter(
        ([key]) => key.toLowerCase() === 'stripe-signature',
      );
      if (signatures.length !== 1 || !signatures[0][1])
        throw new Error('INVALID_WEBHOOK');
      // No parsing before official SDK signature verification. No API key is required.
      const verified = Stripe.webhooks.constructEvent(
        bytes,
        signatures[0][1],
        config.signingSecret,
        config.toleranceSeconds ?? 300,
        undefined,
        now(),
      );
      if (
        verified.livemode ||
        (verified.account && verified.account !== config.accountId)
      )
        throw new Error('WRONG_ENVIRONMENT');
      if (
        ['refund.created', 'refund.updated', 'refund.failed'].includes(
          verified.type,
        )
      ) {
        const refund = verified.data.object as Stripe.Refund;
        if (
          refund.object !== 'refund' ||
          refund.metadata?.environment !== 'dev'
        )
          throw new Error('WRONG_ENVIRONMENT');
        statusCode = 503;
        if (!config.refundEvent) throw new Error('REFUND_PROCESSOR_DISABLED');
        await config.refundEvent({
          eventId: verified.id,
          orderId: refund.metadata.orderId,
          operationId: refund.metadata.refundOperationId,
          refundId: refund.id,
        });
        return {
          statusCode: 200,
          headers: { 'cache-control': 'no-store' },
          body: '{"received":true}',
        };
      }
      if (
        !webhookTypes.includes(verified.type as (typeof webhookTypes)[number])
      )
        return { statusCode: 200, body: '{}' };
      const object = verified.data.object as Stripe.PaymentIntent;
      if (
        object.object !== 'payment_intent' ||
        object.livemode ||
        object.metadata?.environment !== 'dev'
      )
        throw new Error('WRONG_ENVIRONMENT');
      statusCode = 503;
      await inbox.accept({
        eventId: verified.id,
        intentId: object.id,
        eventType: verified.type as (typeof webhookTypes)[number],
      });
      statusCode = 200;
    } catch {
      if (statusCode === 200) statusCode = 400;
    }
    console.info(JSON.stringify({ operation: 'paymentWebhook', statusCode }));
    return {
      statusCode,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
      body: JSON.stringify({ received: statusCode === 200 }),
    };
  };
}
