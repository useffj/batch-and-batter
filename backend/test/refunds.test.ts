import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { refundInput, refundLedger } from '../src/refund-domain';
import { createHandler, type ApiEvent } from '../src/api';
import { fakeRepository } from './fixtures';
import { createStripeWebhook, StripeInbox } from '../src/stripe-webhook';
import { StripeRefundProvider } from '../src/refund-provider';
const id = '01K00000000000000000000001';
for (const route of [
  'GET /admin/orders/{orderId}/refunds',
  'POST /admin/orders/{orderId}/refunds/authorize',
  'POST /admin/orders/{orderId}/refunds/reconcile',
])
  test(route + ' requires administrator and defaults closed', async () => {
    const h = createHandler(() => fakeRepository());
    const e: ApiEvent = {
      routeKey: route,
      pathParameters: { orderId: id },
      body: JSON.stringify(
        route.endsWith('authorize')
          ? { operationId: randomUUID(), amountCents: 100, reason: 'Synthetic' }
          : { operationId: randomUUID() },
      ),
      requestContext: {
        requestId: 'synthetic',
        http: { method: route.split(' ')[0] },
      },
    };
    assert.equal((await h(e)).statusCode, 401);
    e.requestContext.authorizer = {
      jwt: {
        claims: {
          sub: 'synthetic',
          username: 'synthetic',
          token_use: 'access',
          'cognito:groups': ['customer'],
        },
      },
    };
    assert.equal((await h(e)).statusCode, 403);
    e.requestContext.authorizer.jwt!.claims!['cognito:groups'] = [
      'batch-and-batter-admins',
    ];
    assert.equal((await h(e)).statusCode, 503);
  });
for (const amount of [0, -1, 1.1, 100000000, NaN])
  test('invalid refund amount ' + amount, () =>
    assert.equal(
      refundInput.safeParse({
        operationId: randomUUID(),
        amountCents: amount,
        reason: 'Synthetic',
      }).success,
      false,
    ),
  );
test('restock requires physical availability and explicit nonduplicate quantities', () => {
  const b = {
    operationId: randomUUID(),
    amountCents: 100,
    reason: 'Synthetic',
    disposition: 'RESTOCK',
    items: [{ productId: id, quantity: 1 }],
  };
  assert.equal(refundInput.safeParse(b).success, false);
  assert.equal(
    refundInput.safeParse({ ...b, physicallyAvailable: true }).success,
    true,
  );
  assert.equal(
    refundInput.safeParse({
      ...b,
      physicallyAvailable: true,
      items: [...b.items, ...b.items],
    }).success,
    false,
  );
});
test('aggregate cannot exceed capture or lose active reservation ownership', () => {
  const b = {
    orderId: id,
    settlementId: 'a'.repeat(64),
    capturedCents: 100,
    refundedCents: 80,
    reservedCents: 30,
    revision: 1,
    active: randomUUID(),
    returned: {},
    updatedAt: new Date().toISOString(),
  };
  assert.equal(refundLedger.safeParse(b).success, false);
  assert.equal(
    refundLedger.safeParse({ ...b, refundedCents: 70 }).success,
    true,
  );
  assert.equal(
    refundLedger.safeParse({ ...b, refundedCents: 70, active: null }).success,
    false,
  );
});
for (const type of ['refund.created', 'refund.updated', 'refund.failed'])
  test(
    'signed ' +
      type +
      ' is a wakeup; unsigned, live, wrong-account and disabled fail closed',
    async () => {
      const calls: unknown[] = [];
      const now = Date.now(),
        secret = 'whsec_SYNTHETIC_LOCAL_ONLY';
      const inbox = new StripeInbox(
        {
          send: async () => {
            throw Error('Unexpected payment write');
          },
        } as any,
        'local',
        'dev:acct_SYNTHETIC',
      );
      const config = {
        signingSecret: secret,
        scope: inbox.scope,
        accountId: 'acct_SYNTHETIC',
        refundEvent: async (e: unknown) => {
          calls.push(e);
        },
      };
      const h = createStripeWebhook(inbox, config, () => now);
      const base = {
        id: 'evt_SYNTHETIC',
        object: 'event',
        type,
        livemode: false,
        account: 'acct_SYNTHETIC',
        data: {
          object: {
            object: 'refund',
            id: 're_SYNTHETIC',
            metadata: {
              environment: 'dev',
              orderId: id,
              refundOperationId: randomUUID(),
            },
          },
        },
      };
      const event = (value: unknown) => {
        const body = JSON.stringify(value);
        return {
          body,
          headers: {
            'stripe-signature': Stripe.webhooks.generateTestHeaderString({
              payload: body,
              secret,
              timestamp: Math.floor(now / 1000),
            }),
          },
        };
      };
      assert.equal((await h(event(base))).statusCode, 200);
      assert.equal(calls.length, 1);
      assert.equal((await h({ ...event(base), headers: {} })).statusCode, 400);
      assert.equal(
        (await h(event({ ...base, livemode: true }))).statusCode,
        400,
      );
      assert.equal(
        (await h(event({ ...base, account: 'acct_WRONG' }))).statusCode,
        400,
      );
      assert.equal(
        (
          await createStripeWebhook(
            inbox,
            { ...config, refundEvent: undefined },
            () => now,
          )(event(base))
        ).statusCode,
        503,
      );
      assert.equal(calls.length, 1);
    },
  );
test('real adapter verifies key account before any refund request', async () => {
  let creates = 0;
  const provider = new StripeRefundProvider(
    {
      accounts: {
        retrieve: async (account: unknown) => {
          assert.equal(account, null);
          return { id: 'acct_WRONG' };
        },
      },
      refunds: {
        create: async () => {
          creates++;
        },
      },
      paymentIntents: {},
    } as any,
    'acct_SYNTHETIC',
  );
  await assert.rejects(
    provider.create({ accountId: 'acct_SYNTHETIC', environment: 'dev' } as any),
  );
  assert.equal(creates, 0);
});

test('adapter sends exact cents/idempotency and requires authoritative retrieval', async () => {
  const op: any = {
    operationId: randomUUID(),
    orderId: id,
    intentId: 'pi_SYNTHETIC',
    accountId: 'acct_SYNTHETIC',
    environment: 'dev',
    amountCents: 400,
    capturedCents: 945,
    previousRefundedCents: 0,
    currency: 'usd',
    idempotencyKey: 'refund:synthetic',
  };
  const receipt: any = {
    id: 're_SYNTHETIC',
    payment_intent: op.intentId,
    amount: 400,
    currency: 'usd',
    status: 'pending',
    metadata: {
      refundOperationId: op.operationId,
      orderId: id,
      environment: 'dev',
    },
  };
  let created = false;
  const client: any = {
    accounts: { retrieve: async () => ({ id: op.accountId }) },
    paymentIntents: {
      retrieve: async () => ({
        id: op.intentId,
        livemode: false,
        status: 'succeeded',
        amount_received: 945,
        amount_capturable: 0,
        currency: 'usd',
        metadata: { orderId: id, environment: 'dev' },
      }),
    },
    refunds: {
      list: async () => ({ data: created ? [receipt] : [], has_more: false }),
      create: async (body: any, options: any) => {
        assert.equal(body.amount, 400);
        assert.equal(body.payment_intent, op.intentId);
        assert.equal(options.idempotencyKey, op.idempotencyKey);
        assert.equal(options.maxNetworkRetries, 0);
        created = true;
        return receipt;
      },
      retrieve: async () => receipt,
    },
  };
  const p = new StripeRefundProvider(client, op.accountId);
  assert.equal((await p.create(op)).status, 'pending');
  receipt.status = 'succeeded';
  assert.equal((await p.reconcile(op))?.status, 'succeeded');
  await assert.rejects(p.create(op)); // Existing provider refund contradicts the stale zero-refunded ledger.
});
