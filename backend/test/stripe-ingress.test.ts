import assert from 'node:assert/strict';
import { test } from 'node:test';
import Stripe from 'stripe';
import { paymentFixture } from './payment-execution-fixture';
import { createStripeWebhook, webhookTypes } from '../src/stripe-webhook';
import {
  stripeClient,
  StripePaymentProvider,
  StripePaymentReader,
  STRIPE_API_VERSION,
} from '../src/stripe-provider';
import { paymentMessage } from '../src/payment-execution-domain';

const secret = 'synthetic-local-webhook-secret';
const sign = (body: string, now: number) =>
  Stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret,
    timestamp: Math.floor(now / 1000),
  });
async function webhookFixture(
  dispatch?: ConstructorParameters<
    typeof import('../src/stripe-webhook').StripeInbox
  >[4],
) {
  const f = await paymentFixture(true, dispatch);
  const handler = createStripeWebhook(
    f.inbox,
    {
      signingSecret: secret,
      scope: f.scope,
      accountId: 'acct_localfixture',
      toleranceSeconds: 300,
    },
    () => f.s.now,
  );
  const payload = (
    id = 'evt_Fixture',
    type: (typeof webhookTypes)[number] = 'payment_intent.created',
  ) =>
    JSON.stringify({
      id,
      object: 'event',
      type,
      livemode: false,
      account: 'acct_localfixture',
      data: {
        object: {
          id: 'pi_Test1',
          object: 'payment_intent',
          livemode: false,
          metadata: { environment: 'dev' },
          customer: { email: 'private-webhook@example.test' },
        },
      },
    });
  const event = (body = payload()) => ({
    body,
    headers: { 'Stripe-Signature': sign(body, f.s.now) },
  });
  return { ...f, handler, payload, event };
}
for (const mode of ['raw', 'base64'])
  test(`signature verifies exact ${mode} bytes before durable receipt/inbox`, async () => {
    const f = await webhookFixture();
    const event = f.event();
    if (mode === 'base64')
      Object.assign(event, {
        body: Buffer.from(event.body).toString('base64'),
        isBase64Encoded: true,
      });
    assert.equal((await f.handler(event)).statusCode, 200);
    const rows = [...f.s.rows.values()];
    assert.equal(rows.filter((r) => r.state === 'RECEIVED').length, 1);
    assert.equal(
      rows.filter((r) => r.deadlineType === 'STRIPE_EVENT').length,
      1,
    );
    assert.match(
      rows.find((r) => r.deadlineType === 'STRIPE_EVENT')!.PK,
      /^CART_EXPIRY#V1#0[0-9A-F]$/,
    );
  });
for (const kind of ['bad', 'changed', 'old', 'live', 'account', 'environment'])
  test(`webhook rejects ${kind} without writing`, async () => {
    const f = await webhookFixture();
    const e = f.event();
    const before = structuredClone(f.s.rows);
    if (kind === 'bad') e.headers['Stripe-Signature'] = 'bad';
    if (kind === 'changed') e.body += ' ';
    if (kind === 'old')
      e.headers['Stripe-Signature'] = sign(e.body, f.s.now - 301000);
    if (['live', 'account', 'environment'].includes(kind)) {
      const p = JSON.parse(e.body);
      if (kind === 'live') p.livemode = true;
      if (kind === 'account') p.account = 'acct_other';
      if (kind === 'environment')
        p.data.object.metadata.environment = 'production';
      e.body = JSON.stringify(p);
      e.headers['Stripe-Signature'] = sign(e.body, f.s.now);
    }
    assert.equal((await f.handler(e)).statusCode, 400);
    assert.deepEqual(f.s.rows, before);
  });
for (const base64 of [false, true])
  test(`oversized decoded webhook base64=${base64} returns 413`, async () => {
    const f = await webhookFixture();
    const body = 'x'.repeat(256 * 1024 + 1);
    assert.equal(
      (
        await f.handler({
          body: base64 ? Buffer.from(body).toString('base64') : body,
          isBase64Encoded: base64,
          headers: {},
        })
      ).statusCode,
      413,
    );
  });
test('duplicate RECEIVED preserves one obligation despite lost dispatch', async () => {
  const f = await webhookFixture(async () => {
    throw new Error('lost SQS send');
  });
  assert.equal((await f.handler(f.event())).statusCode, 200);
  assert.equal((await f.handler(f.event())).statusCode, 200);
  const work = [...f.s.rows.values()].filter(
    (r) => r.deadlineType === 'STRIPE_EVENT',
  );
  assert.equal(work.length, 1);
  assert.ok(!JSON.stringify(work).includes('private-webhook'));
});
test('missing inbox behind RECEIVED is conditionally restored at the original key', async () => {
  const f = await webhookFixture();
  await f.handler(f.event());
  const work = [...f.s.rows.values()].find(
    (r) => r.deadlineType === 'STRIPE_EVENT',
  )!;
  f.s.rows.delete(f.s.key('operations', work));
  assert.equal((await f.handler(f.event())).statusCode, 200);
  assert.deepEqual(f.s.row('operations', work), work);
});
test('failed durable acceptance returns 503 without a receipt alone', async () => {
  const f = await webhookFixture();
  f.s.before = () => {
    throw new Error('Dynamo unavailable');
  };
  assert.equal((await f.handler(f.event())).statusCode, 503);
  assert.equal(
    [...f.s.rows.values()].filter((r) => r.state === 'RECEIVED').length,
    0,
  );
});
test('event before bind retrieves provider and transfers to durable workflow; PROCESSED replay is inert', async () => {
  const f = await webhookFixture();
  f.provider.lostCreate = true;
  await assert.rejects(f.run());
  assert.equal((await f.handler(f.event())).statusCode, 200);
  const work = [...f.s.rows.values()].find(
    (r) => r.deadlineType === 'STRIPE_EVENT',
  )!;
  assert.equal(
    await f.inbox.process(
      paymentMessage(
        { PK: work.PK, SK: work.SK, revision: work.revision },
        'STRIPE_EVENT',
      ),
      f.workflow,
    ),
    'TRANSFERRED',
  );
  assert.equal(f.attempt().execution.intentId, 'pi_Test1');
  assert.equal(f.attempt().execution.stage, 'CONFIRM');
  const before = structuredClone(f.s.rows);
  assert.equal((await f.handler(f.event())).statusCode, 200);
  assert.deepEqual(f.s.rows, before);
});
test('out-of-order event snapshots only wake trusted retrieval, never sell inventory', async () => {
  const f = await webhookFixture();
  await f.bind();
  f.provider.outcome = 'requires_capture';
  await f.run();
  for (const [i, type] of webhookTypes.entries()) {
    await f.handler(f.event(f.payload(`evt_Order${i}`, type)));
    const work = [...f.s.rows.values()].find(
      (r) => r.eventId === `evt_Order${i}` && r.deadlineType === 'STRIPE_EVENT',
    )!;
    await f.inbox.process(
      paymentMessage(
        { PK: work.PK, SK: work.SK, revision: work.revision },
        'STRIPE_EVENT',
      ),
      f.workflow,
    );
  }
  assert.equal(f.cart().status, 'PAYMENT_PENDING');
  assert.equal(f.attempt().execution.stage, 'CLAIM_CAPTURE');
});
test('webhook logs and stored records exclude raw body/signature/secrets/PII', async () => {
  const f = await webhookFixture();
  const e = f.event();
  const logs: string[] = [];
  const old = console.info;
  console.info = (s) => logs.push(String(s));
  try {
    await f.handler(e);
    await f.handler({ ...e, body: e.body + 'x' });
  } finally {
    console.info = old;
  }
  const evidence =
    JSON.stringify([...f.s.rows].filter(([k]) => k.startsWith('operations|'))) +
    logs.join('');
  for (const value of [
    secret,
    e.headers['Stripe-Signature'],
    e.body,
    'private-webhook@example.test',
    f.request.confirmationTokenId,
  ])
    assert.ok(!evidence.includes(value));
});

function transportFixture() {
  const requests: {
    url: string;
    method: string;
    body: string;
    headers: Headers;
  }[] = [];
  let response: unknown;
  let fail = false;
  const client = stripeClient(
    'rk_test_' + 'SyntheticFixture',
    Stripe.createFetchHttpClient(async (url, init) => {
      requests.push({
        url: String(url),
        method: init?.method ?? '',
        body: String(init?.body ?? ''),
        headers: new Headers(init?.headers),
      });
      if (fail)
        throw new Error(
          'synthetic transport timeout with private request data',
        );
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return {
    requests,
    client,
    provider: new StripePaymentProvider(client),
    reader: new StripePaymentReader(client),
    respond: (value: unknown) => {
      response = value;
    },
    fail: () => {
      fail = true;
    },
  };
}
function rawIntent(parameters: any, status = 'requires_payment_method') {
  return {
    id: 'pi_AdapterFixture',
    status,
    amount: parameters.amountCents,
    amount_received: 0,
    amount_capturable: 0,
    currency: parameters.currency,
    capture_method: 'manual',
    confirmation_method: 'automatic',
    payment_method_types: ['card'],
    metadata: parameters.metadata,
    livemode: false,
    client_secret: 'synthetic-action-secret',
  };
}
test('official SDK transport uses pinned version, frozen create params and confirm=false', async () => {
  const f = await paymentFixture();
  const t = transportFixture();
  const e = f.attempt().execution;
  t.respond(rawIntent(e.parameters));
  await t.provider.createIntent({
    parameters: e.parameters,
    amountCents: e.parameters.amountCents,
    currency: 'usd',
    paymentAttemptId: f.cart().paymentAttemptId,
    orderId: f.cart().orderId,
    idempotencyKey: e.create.id,
  });
  const req = t.requests[0];
  const body = new URLSearchParams(req.body);
  assert.equal(req.headers.get('stripe-version'), STRIPE_API_VERSION);
  assert.equal(req.headers.get('idempotency-key'), e.create.id);
  assert.equal(body.get('confirm'), 'false');
  assert.equal(body.get('capture_method'), 'manual');
  assert.equal(body.get('confirmation_method'), 'automatic');
  assert.ok(!req.body.includes('ctoken'));
  assert.ok(!req.body.includes('customer'));
});
test('official SDK initial confirmation uses token; automatic continuation cannot reconfirm', async () => {
  const f = await paymentFixture();
  const t = transportFixture();
  t.respond(rawIntent(f.attempt().execution.parameters, 'requires_action'));
  const generation = 0;
  await t.provider.confirmIntent({
    paymentAttemptId: f.cart().paymentAttemptId,
    orderId: f.cart().orderId,
    amountCents: 900,
    currency: 'usd',
    intentId: 'pi_AdapterFixture',
    confirmationSequence: generation,
    idempotencyKey: `payment-confirm:${f.cart().paymentAttemptId}:${generation}`,
    ...(generation === 0
      ? { confirmationTokenId: f.request.confirmationTokenId }
      : {}),
  });
  assert.equal(
    new URLSearchParams(t.requests[0].body).get('confirmation_token'),
    f.request.confirmationTokenId,
  );
  assert.equal(
    new URLSearchParams(t.requests[0].body).has('confirmation_method'),
    false,
  );
  await assert.rejects(
    t.provider.confirmIntent({
      paymentAttemptId: f.cart().paymentAttemptId,
      orderId: f.cart().orderId,
      amountCents: 900,
      currency: 'usd',
      intentId: 'pi_AdapterFixture',
      confirmationSequence: 1,
      idempotencyKey: `payment-confirm:${f.cart().paymentAttemptId}:1`,
    }),
  );
  assert.equal(t.requests.length, 1);
});
test('SDK timeout makes exactly one transport attempt and strips raw error', async () => {
  const t = transportFixture();
  t.fail();
  await assert.rejects(t.reader.retrieveIntent('pi_AdapterFixture'), (e) => {
    assert.equal((e as Error).message, 'PROVIDER_UNKNOWN');
    return true;
  });
  assert.equal(t.requests.length, 1);
});
test('restricted read adapter has no financial commands; invalid financial commands never reach transport', async () => {
  const t = transportFixture();
  assert.equal('createIntent' in t.reader, false);
  assert.equal('confirmIntent' in t.reader, false);
  await assert.rejects(
    t.provider.captureIntent({
      intentId: 'pi_Invalid',
      paymentAttemptId: 'invalid',
      orderId: 'invalid',
      amountCents: 0,
      currency: 'usd',
      idempotencyKey: 'invalid',
    }),
    /PROVIDER_INVALID/,
  );
  await assert.rejects(
    t.provider.cancelIntent({
      intentId: 'pi_Invalid',
      paymentAttemptId: 'invalid',
      orderId: 'invalid',
      amountCents: 0,
      currency: 'usd',
      idempotencyKey: 'invalid',
    }),
    /PROVIDER_INVALID/,
  );
  assert.equal(t.requests.length, 0);
  assert.throws(() => stripeClient('sk_test_' + 'SyntheticFixture'));
  assert.throws(() => stripeClient('rk_live_' + 'SyntheticFixture'));
});
test('token retrieval projection excludes billing/card data and rejects unsupported/live tokens', async () => {
  const t = transportFixture();
  const good = {
    id: 'ctoken_AdapterFixture',
    livemode: false,
    expires_at: 2000000000,
    payment_intent: null,
    setup_intent: null,
    setup_future_usage: null,
    payment_method_preview: {
      type: 'card',
      billing_details: { email: 'private@example.test' },
    },
  };
  t.respond(good);
  const result = await t.reader.retrieveConfirmationToken(good.id);
  assert.ok(!JSON.stringify(result).includes('private'));
  for (const patch of [
    { livemode: true },
    { payment_method_preview: { type: 'us_bank_account' } },
    { expires_at: null },
  ]) {
    t.respond({ ...good, ...patch });
    await assert.rejects(t.reader.retrieveConfirmationToken(good.id));
  }
});

test('damaged inbox is not overwritten or acknowledged', async () => {
  const f = await webhookFixture();
  await f.handler(f.event());
  const work = [...f.s.rows.values()].find(
    (r) => r.deadlineType === 'STRIPE_EVENT',
  )!;
  work.eventId = 'evt_Conflicting';
  assert.equal((await f.handler(f.event())).statusCode, 503);
  assert.equal(work.eventId, 'evt_Conflicting');
});
test('concurrent duplicate webhook acceptance has one receipt and one inbox item', async () => {
  const f = await webhookFixture();
  const responses = await Promise.all([
    f.handler(f.event()),
    f.handler(f.event()),
  ]);
  assert.deepEqual(
    responses.map((r) => r.statusCode),
    [200, 200],
  );
  assert.equal(
    [...f.s.rows.values()].filter((r) => r.state === 'RECEIVED').length,
    1,
  );
  assert.equal(
    [...f.s.rows.values()].filter((r) => r.deadlineType === 'STRIPE_EVENT')
      .length,
    1,
  );
});

test('inbox cannot complete if canonical workflow obligation disappears concurrently', async () => {
  const f = await webhookFixture();
  await f.bind();
  await f.handler(f.event());
  const work = [...f.s.rows.values()].find(
    (r) => r.deadlineType === 'STRIPE_EVENT',
  )!;
  f.s.before = (actions) => {
    if (actions.some((a) => a.Put?.Item?.state === 'PROCESSED')) {
      f.s.before = undefined;
      f.s.rows.delete(f.s.key('operations', f.message()));
    }
  };
  await assert.rejects(
    f.inbox.process(
      paymentMessage(
        { PK: work.PK, SK: work.SK, revision: work.revision },
        'STRIPE_EVENT',
      ),
      f.workflow,
    ),
  );
  assert.equal(
    [...f.s.rows.values()].find((r) => r.state === 'RECEIVED')!.state,
    'RECEIVED',
  );
  assert.ok(f.s.row('operations', work));
});

test('financial SDK capture uses full explicit amount, final capture and immutable key', async () => {
  const f = await paymentFixture();
  const t = transportFixture();
  t.respond({
    ...rawIntent(f.attempt().execution.parameters, 'succeeded'),
    amount_received: 900,
  });
  await t.provider.captureIntent({
    paymentAttemptId: f.cart().paymentAttemptId,
    orderId: f.cart().orderId,
    amountCents: 900,
    currency: 'usd',
    intentId: 'pi_AdapterFixture',
    idempotencyKey: `payment-capture:${f.cart().paymentAttemptId}`,
  });
  assert.ok(t.requests[0].url.endsWith('/pi_AdapterFixture/capture'));
  const body = new URLSearchParams(t.requests[0].body);
  assert.equal(body.get('amount_to_capture'), '900');
  assert.equal(body.get('final_capture'), 'true');
  assert.equal(
    t.requests[0].headers.get('Idempotency-Key'),
    `payment-capture:${f.cart().paymentAttemptId}`,
  );
});
test('financial SDK cancellation uses deterministic command and sanitized failure', async () => {
  const f = await paymentFixture();
  const t = transportFixture();
  t.respond(rawIntent(f.attempt().execution.parameters, 'canceled'));
  const c = {
    paymentAttemptId: f.cart().paymentAttemptId,
    orderId: f.cart().orderId,
    amountCents: 900,
    currency: 'usd',
    intentId: 'pi_AdapterFixture',
    idempotencyKey: `payment-cancel:${f.cart().paymentAttemptId}`,
  };
  await t.provider.cancelIntent(c);
  assert.ok(t.requests[0].url.endsWith('/pi_AdapterFixture/cancel'));
  assert.equal(
    new URLSearchParams(t.requests[0].body).get('cancellation_reason'),
    'abandoned',
  );
  t.fail();
  await assert.rejects(t.provider.cancelIntent(c), /PROVIDER_UNKNOWN/);
  assert.equal(t.requests.length, 2);
});

test('adapter rejects manual confirmation snapshots from Elements flow', async () => {
  const f = await paymentFixture();
  const t = transportFixture();
  t.respond({
    ...rawIntent(f.attempt().execution.parameters, 'requires_capture'),
    confirmation_method: 'manual',
  });
  await assert.rejects(t.reader.retrieveIntent('pi_AdapterFixture'));
});
