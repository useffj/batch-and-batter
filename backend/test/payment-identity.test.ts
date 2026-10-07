import assert from 'node:assert/strict';
import { test } from 'node:test';
import Stripe from 'stripe';
import { paymentIdentity } from '../src/payment-runtime';
import { paymentFixture } from './payment-execution-fixture';
import { createStripeWebhook } from '../src/stripe-webhook';
const config = {
  STRIPE_ENVIRONMENT: 'dev',
  STRIPE_ACCOUNT_ID: 'acct_actualfixture',
  STRIPE_LEDGER_ACCOUNT_ID: 'acct_actualfixture',
  STRIPE_LEDGER_NAMESPACE: 'dev:acct_historicalfixture',
};
test('actual account and historical ledger namespace resolve separately', () => {
  assert.deepEqual(paymentIdentity(config), {
    accountId: 'acct_actualfixture',
    scope: 'dev:acct_historicalfixture',
  });
});
for (const override of [
  { STRIPE_ENVIRONMENT: 'production' },
  { STRIPE_ACCOUNT_ID: '' },
  { STRIPE_ACCOUNT_ID: 'acct_unrelated' },
  { STRIPE_LEDGER_ACCOUNT_ID: '' },
  { STRIPE_LEDGER_ACCOUNT_ID: 'acct_historicalfixture' },
  { STRIPE_LEDGER_NAMESPACE: '' },
  { STRIPE_LEDGER_NAMESPACE: 'live:acct_historicalfixture' },
])
  test(`invalid DEV identity binding fails closed: ${JSON.stringify(override)}`, () => {
    assert.throws(() => paymentIdentity({ ...config, ...override }), {
      code: 'PROVIDER_INVALID',
    });
  });
test('historical namespace cannot authorize wrong-account webhook; same-account receipts remain deduplicated', async () => {
  const identity = paymentIdentity(config);
  const f = await paymentFixture(true, undefined, 1, false, identity.scope);
  const secret = 'synthetic-webhook-secret';
  const handler = createStripeWebhook(
    f.inbox,
    { ...identity, signingSecret: secret, toleranceSeconds: 300 },
    () => f.s.now,
  );
  const event = (account: string) => {
    const body = JSON.stringify({
      id: 'evt_BindingFixture',
      object: 'event',
      type: 'payment_intent.created',
      livemode: false,
      account,
      data: {
        object: {
          id: 'pi_Test1',
          object: 'payment_intent',
          livemode: false,
          metadata: { environment: 'dev' },
        },
      },
    });
    return {
      body,
      headers: {
        'Stripe-Signature': Stripe.webhooks.generateTestHeaderString({
          payload: body,
          secret,
          timestamp: Math.floor(f.s.now / 1000),
        }),
      },
    };
  };
  const before = structuredClone(f.s.rows);
  for (const account of ['acct_historicalfixture', 'acct_unrelated']) {
    assert.equal((await handler(event(account))).statusCode, 400);
    assert.deepEqual(f.s.rows, before);
  }
  assert.equal((await handler(event(identity.accountId))).statusCode, 200);
  const accepted = structuredClone(f.s.rows);
  assert.equal((await handler(event(identity.accountId))).statusCode, 200);
  assert.deepEqual(f.s.rows, accepted);
});

test('all payment HTTP routes catch initialization failures, log only safe diagnostics and retry initialization', async (t) => {
  const runtime = await import('../src/payment-runtime');
  const { createPaymentHttp } = await import('../src/payment-http-runtime');
  const logs: string[] = [];
  t.mock.method(console, 'info', (line: string) => logs.push(line));
  let attempts = 0;
  t.mock.method(runtime, 'paymentScope', () => {
    attempts++;
    throw new Error('private-configuration-marker');
  });
  t.mock.method(runtime, 'paymentClient', () => {
    throw new Error('must not construct clients');
  });
  const handler = createPaymentHttp();
  for (const [route, operation] of [
    ['POST /carts/{cartId}/payment/start', 'beginPayment'],
    ['POST /carts/{cartId}/payment/confirm', 'confirmPayment'],
    ['GET /carts/{cartId}/payment', 'getPayment'],
  ]) {
    const response = await handler({
      routeKey: route,
      requestContext: {
        requestId: 'safe-fixture',
        http: { method: route.split(' ')[0] },
      },
    } as any);
    assert.equal(response.statusCode, 503);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(JSON.parse(response.body), {
      code: 'PAYMENT_UNAVAILABLE',
      message: 'Payment service is temporarily unavailable.',
      requestId: 'safe-fixture',
    });
    assert.deepEqual(JSON.parse(logs.at(-1)!), {
      operation,
      statusCode: 503,
      code: 'PAYMENT_UNAVAILABLE',
    });
  }
  assert.equal(attempts, 3); // A failed initialization is never cached.
  assert.doesNotMatch(logs.join(''), /private-configuration-marker/);
});

test('staged legacy and corrected account bindings keep the identical historical namespace', () => {
  const prepared = paymentIdentity({
    ...config,
    STRIPE_ACCOUNT_ID: 'acct_historicalfixture',
    STRIPE_LEDGER_ACCOUNT_ID: 'acct_historicalfixture',
  });
  const corrected = paymentIdentity(config);
  assert.equal(prepared.scope, corrected.scope);
  assert.notEqual(prepared.accountId, corrected.accountId);
  assert.throws(
    () =>
      paymentIdentity({
        ...config,
        STRIPE_ACCOUNT_ID: 'acct_historicalfixture',
      }),
    { code: 'PROVIDER_INVALID' },
  );
});
