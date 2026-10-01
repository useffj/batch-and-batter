import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { configuration, handler } from './server.mjs';
import {
  API,
  ORIGIN,
  setup,
  preview,
  elementsOptions,
  startRequest,
  confirmRequest,
  paymentView,
} from './contract.mjs';
import { createFlow, createContinuation, newKey } from './flow.mjs';
const cartId = '01K5J100000000000000000001';
const productId = '01K5J100000000000000000002';
const capability = Buffer.alloc(32, 1).toString('base64url');
const etag = '"' + 'a'.repeat(64) + '"';
const contact = {
  name: 'Sandbox Fixture',
  email: 'fixture@example.invalid',
  phone: '+12025550100',
  smsTransactionalConsent: false,
};
const input = { pickupDate: '2099-10-08', customer: contact };
const cart = {
  cartId,
  dropId: cartId,
  etag,
  amount: 1000,
  currency: 'usd',
  shoppingExpiresAt: '2099-10-05T18:00:00.000Z',
  pickups: [{ date: input.pickupDate }],
};
const body = {
  cart: {
    ...cart,
    status: 'ACTIVE',
    items: [{ productId, quantity: 2, priceCents: 500 }],
  },
};
const request = () => ({
  cartId,
  capability,
  etag,
  key: newKey(),
  body: { ...structuredClone(input), confirmationTokenId: 'ctoken_mockOnly' },
});
const config = { publishableKey: 'pk_test_mockOnly', allowStart: false };

test('configuration rejects missing/live keys and every non-development environment', () => {
  for (const env of [
    {},
    {
      NODE_ENV: 'production',
      STRIPE_ACCEPTANCE_PUBLISHABLE_KEY: config.publishableKey,
    },
    {
      NODE_ENV: 'development',
      STRIPE_ACCEPTANCE_PUBLISHABLE_KEY: 'pk_live_mockOnly',
    },
  ])
    assert.throws(() => configuration(env));
  assert.deepEqual(
    configuration({
      NODE_ENV: 'development',
      STRIPE_ACCEPTANCE_PUBLISHABLE_KEY: config.publishableKey,
    }),
    config,
  );
});
test('setup rejects malformed IDs, noncanonical capabilities and arbitrary destination', () => {
  assert.deepEqual(setup({ cartId, capability }), { cartId, capability });
  for (const v of [
    { cartId: '../x', capability },
    { cartId, capability: 'secret' },
    { cartId, capability, url: 'https://example.invalid' },
  ])
    assert.throws(() => setup(v));
});
test('Elements amount comes from authoritative snapshot with dev USD fixture and manual card capture', () => {
  const p = preview(body, etag, cartId);
  assert.equal(p.amount, 1000);
  assert.deepEqual(elementsOptions(p), {
    mode: 'payment',
    amount: 1000,
    currency: 'usd',
    captureMethod: 'manual',
    paymentMethodTypes: ['card'],
    paymentMethodCreation: 'manual',
  });
  for (const altered of [
    { ...body.cart, status: 'PAYMENT_PENDING' },
    { ...body.cart, shoppingExpiresAt: '2000-01-01T00:00:00.000Z' },
    {
      ...body.cart,
      items: [
        { productId, quantity: Number.MAX_SAFE_INTEGER, priceCents: 500 },
      ],
    },
  ])
    assert.throws(() => preview({ cart: altered }, etag, cartId));
});
test('start schema rejects monetary authority, raw card data and nested extra fields', () => {
  for (const field of [
    'amount',
    'currency',
    'tax',
    'fee',
    'paymentDeadline',
    'card',
    'paymentIntentId',
    'orderId',
  ]) {
    const r = request();
    r.body[field] = 'rejected';
    assert.throws(() => startRequest(r));
  }
  const r = request();
  r.body.customer.cardNumber = 'mock';
  assert.throws(() => startRequest(r));
});
function flow(overrides = {}) {
  const calls = { submit: 0, token: 0, sent: [] };
  const pay = createFlow({
    cart,
    capability,
    elements: {
      submit: async () => {
        calls.submit++;
        return {};
      },
    },
    stripe: {
      createConfirmationToken: async () => {
        calls.token++;
        return { confirmationToken: { id: 'ctoken_mockOnly' } };
      },
    },
    send: async (r) => {
      calls.sent.push(structuredClone(r));
      return { accepted: true };
    },
    ...overrides,
  });
  return { pay, calls };
}
test('submit validation failure prevents token creation and backend start', async () => {
  const { pay, calls } = flow({
    elements: { submit: async () => ({ error: { message: 'sensitive' } }) },
  });
  assert.doesNotMatch(await pay(input), /sensitive/);
  assert.equal(calls.token, 0);
  assert.equal(calls.sent.length, 0);
});
test('token failure prevents backend start without leaking error objects', async () => {
  const { pay, calls } = flow({
    stripe: {
      createConfirmationToken: async () => ({
        error: { message: 'sensitive' },
      }),
    },
  });
  assert.doesNotMatch(await pay(input), /sensitive/);
  assert.equal(calls.sent.length, 0);
});
test('duplicate clicks and accepted resubmission cannot create duplicate tokens/starts', async () => {
  let resolve;
  const gate = new Promise((r) => {
    resolve = r;
  });
  const { pay, calls } = flow({
    elements: {
      submit: async () => {
        await gate;
        return {};
      },
    },
  });
  const first = pay(input);
  await pay(input);
  resolve();
  await first;
  await pay(input);
  assert.equal(calls.token, 1);
  assert.equal(calls.sent.length, 1);
});
test('ambiguous outcome replays exact token, capability, ETag, idempotency and customer snapshot', async () => {
  const sent = [];
  const { pay, calls } = flow({
    send: async (r) => {
      sent.push(structuredClone(r));
      throw new Error('sensitive provider object');
    },
  });
  assert.doesNotMatch(await pay(input), /sensitive/);
  await pay({
    pickupDate: '2099-10-09',
    customer: { ...contact, name: 'Changed' },
  });
  assert.equal(calls.token, 1);
  assert.deepEqual(sent[0], sent[1]);
  assert.equal(sent[0].capability, capability);
  assert.equal(sent[0].etag, etag);
  assert.match(sent[0].key, /^v1\.\d{13}\.[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(Object.keys(sent[0].body).sort(), [
    'confirmationTokenId',
    'customer',
    'pickupDate',
  ]);
});
async function relay(fn, upstream, allowStart = false) {
  const server = createServer(handler({ ...config, allowStart }, upstream));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(
      async (path, value, extra = {}) =>
        new Promise((resolve, reject) => {
          const req = httpRequest(
            `http://127.0.0.1:${server.address().port}${path}`,
            {
              method: 'POST',
              headers: {
                Host: '127.0.0.1:4242',
                Origin: ORIGIN,
                'Content-Type': 'application/json',
                'X-Acceptance-Client': 'loopback',
                ...extra,
              },
            },
            (res) => {
              let data = '';
              res.on('data', (c) => {
                data += c;
              });
              res.on('end', () =>
                resolve({
                  status: res.statusCode,
                  json: async () => JSON.parse(data),
                }),
              );
            },
          );
          req.on('error', reject);
          req.end(JSON.stringify(value));
        }),
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
test('relay blocks start by default, cross-origin, host attacks and arbitrary routes', async () => {
  let calls = 0;
  await relay(
    async (post) => {
      assert.equal((await post('/start', request())).status, 403);
      assert.equal(
        (
          await post(
            '/cart',
            { cartId, capability },
            { Origin: 'https://evil.invalid' },
          )
        ).status,
        403,
      );
      assert.equal(
        (await post('/cart', { cartId, capability }, { Host: 'evil.invalid' }))
          .status,
        403,
      );
      assert.equal((await post('/capture', {})).status, 404);
    },
    async () => {
      calls++;
    },
  );
  assert.equal(calls, 0);
});
test('relay forwards exact real start contract only to fixed dev API; suppresses response secrets', async () => {
  const r = request();
  let call;
  await relay(
    async (post) => {
      const response = await post('/start', r);
      assert.deepEqual(await response.json(), {
        accepted: true,
        status: 201,
        sent: 'yes',
      });
    },
    async (url, options) => {
      call = { url, options };
      return new Response(
        JSON.stringify({ client_secret: 'mock', customer: contact }),
        { status: 201 },
      );
    },
    true,
  );
  assert.equal(call.url, API + `/carts/${cartId}/payment/start`);
  assert.equal(call.options.redirect, 'error');
  assert.deepEqual(call.options.headers, {
    'Content-Type': 'application/json',
    'X-Cart-Token': capability,
    'If-Match': etag,
    'Idempotency-Key': r.key,
  });
  assert.deepEqual(JSON.parse(call.options.body), r.body);
});
test('relay rejects raw card payloads and configurable destinations before upstream access', async () => {
  let calls = 0;
  await relay(
    async (post) => {
      assert.equal(
        (await post('/start', { ...request(), card: { number: 'mock' } }))
          .status,
        400,
      );
      assert.equal(
        (
          await post('/cart', {
            cartId,
            capability,
            destination: 'https://stripe.com',
          })
        ).status,
        400,
      );
    },
    async () => {
      calls++;
    },
    true,
  );
  assert.equal(calls, 0);
});
test('Cart relay preserves response ETag, computes snapshot amount and filters response fields', async () => {
  const urls = [];
  await relay(
    async (post) => {
      const p = await (await post('/cart', { cartId, capability })).json();
      assert.equal(p.amount, 1000);
      assert.equal(p.etag, etag);
      assert.ok(!('capability' in p));
    },
    async (url) => {
      urls.push(url);
      return urls.length === 1
        ? new Response(JSON.stringify(body), { headers: { etag } })
        : new Response(
            JSON.stringify({
              drop: {
                id: cartId,
                status: 'OPEN',
                pickupDates: [
                  {
                    date: input.pickupDate,
                    startTime: '16:00',
                    endTime: '19:00',
                    timezone: 'America/Denver',
                  },
                ],
              },
            }),
          );
    },
  );
  assert.deepEqual(urls, [API + `/carts/${cartId}`, API + `/drops/${cartId}`]);
});
test('browser tooling has no persistent storage, logging or restricted-key access; production sources cannot import it', async () => {
  for (const name of [
    'browser.mjs',
    'flow.mjs',
    'contract.mjs',
    'server.mjs',
  ]) {
    const source = await readFile(new URL(name, import.meta.url), 'utf8');
    assert.doesNotMatch(
      source,
      /localStorage|sessionStorage|indexedDB|console\.|ssm:|GetParameter|sk_test_|rk_test_|whsec_/,
    );
  }
  const page = await readFile(
    new URL('../../web/src/app/page.tsx', import.meta.url),
    'utf8',
  );
  assert.match(page, /Coming Soon/);
  assert.doesNotMatch(page, /stripe|acceptance/);
  const build = await readFile(
    new URL('../../backend/scripts/build.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(build, /stripe-acceptance/);
  const files = await readdir(new URL('../../web/src/app/', import.meta.url));
  assert.deepEqual(files.sort(), ['globals.css', 'layout.tsx', 'page.tsx']);
});

const sensitive = [
  'ctoken_mockPrivate',
  'pi_mockPrivate',
  'pk_test_mockPrivate',
  'rk_test_mockPrivate',
  'whsec_mockPrivate',
  capability,
  'Idempotency-Key',
  contact.email,
  contact.phone,
  '4242424242424242',
  'CVC=123',
  'raw Stripe error',
];
const poison = sensitive.join(' ');
function safeStatus(value, code, sent) {
  assert.match(value, new RegExp(code));
  assert.ok(value.includes(`payment/start sent: ${sent}.`));
  for (const secret of sensitive) assert.ok(!value.includes(secret));
}
for (const [name, code, overrides, value] of [
  [
    'contact',
    'HARNESS_CONTACT_INVALID',
    {},
    { ...input, customer: { ...contact, phone: poison } },
  ],
  ['pickup', 'HARNESS_PICKUP_INVALID', {}, { ...input, pickupDate: poison }],
  [
    'expired',
    'HARNESS_CART_EXPIRED',
    { cart: { ...cart, shoppingExpiresAt: '2000-01-01T00:00:00Z' } },
    input,
  ],
  [
    'invalid deadline',
    'HARNESS_CART_EXPIRED',
    { cart: { ...cart, shoppingExpiresAt: poison } },
    input,
  ],
  [
    'elements returned error',
    'HARNESS_ELEMENTS_SUBMIT_FAILED',
    { elements: { submit: async () => ({ error: { message: poison } }) } },
    input,
  ],
  [
    'elements throw',
    'HARNESS_ELEMENTS_SUBMIT_FAILED',
    {
      elements: {
        submit: async () => {
          throw new Error(poison);
        },
      },
    },
    input,
  ],
  [
    'token returned error',
    'HARNESS_CONFIRMATION_TOKEN_FAILED',
    {
      stripe: {
        createConfirmationToken: async () => ({ error: { message: poison } }),
      },
    },
    input,
  ],
  [
    'token throw',
    'HARNESS_CONFIRMATION_TOKEN_FAILED',
    {
      stripe: {
        createConfirmationToken: async () => {
          throw new Error(poison);
        },
      },
    },
    input,
  ],
  [
    'request construction',
    'HARNESS_START_REQUEST_REJECTED',
    { key: () => poison },
    input,
  ],
])
  test(`sanitized ${name} failure never sends start`, async () => {
    const { pay, calls } = flow(overrides);
    safeStatus(await pay(value), code, 'no');
    assert.equal(calls.sent.length, 0);
  });
test('transport exceptions remain ambiguous and preserve identical request', async () => {
  const sent = [];
  const { pay } = flow({
    send: async (r) => {
      sent.push(structuredClone(r));
      throw new Error(poison);
    },
  });
  safeStatus(await pay(input), 'HARNESS_START_REQUEST_AMBIGUOUS', 'ambiguous');
  safeStatus(await pay(input), 'HARNESS_START_REQUEST_AMBIGUOUS', 'ambiguous');
  assert.deepEqual(sent[0], sent[1]);
});
for (const sent of ['yes', 'no', 'ambiguous'])
  test(`relay outcome ${sent} uses fixed diagnostic`, async () => {
    const { pay } = flow({
      send: async () => ({ accepted: false, sent, error: poison }),
    });
    safeStatus(
      await pay(input),
      sent === 'ambiguous'
        ? 'HARNESS_START_REQUEST_AMBIGUOUS'
        : 'HARNESS_START_REQUEST_REJECTED',
      sent,
    );
  });
for (const failure of ['rejected', 'transport', 'invalid'])
  test(`relay ${failure} redacts raw data and distinguishes dispatch`, async () => {
    let calls = 0;
    await relay(
      async (post) => {
        const r = request();
        if (failure === 'invalid') r.key = poison;
        const response = await post('/start', r);
        const output = await response.json();
        assert.equal(
          output.sent,
          failure === 'transport'
            ? 'ambiguous'
            : failure === 'invalid'
              ? 'no'
              : 'yes',
        );
        for (const secret of sensitive)
          assert.ok(!JSON.stringify(output).includes(secret));
      },
      async () => {
        calls++;
        if (failure === 'transport') throw new Error(poison);
        return new Response(poison, { status: 409 });
      },
      true,
    );
    assert.equal(calls, failure === 'invalid' ? 0 : 1);
  });

test('upstream 5xx is known sent but financial outcome ambiguous', async () => {
  await relay(
    async (post) => {
      const result = await (await post('/start', request())).json();
      const { pay } = flow({ send: async () => result });
      safeStatus(await pay(input), 'HARNESS_START_REQUEST_AMBIGUOUS', 'yes');
    },
    async () => new Response(poison, { status: 503 }),
    true,
  );
});
test('setup diagnostic is fixed and local tooling never logs raw failures', async () => {
  const { diagnostic } = await import('./flow.mjs');
  safeStatus(
    diagnostic('HARNESS_SETUP_INVALID'),
    'HARNESS_SETUP_INVALID',
    'no',
  );
  for (const name of ['browser.mjs', 'flow.mjs', 'server.mjs']) {
    const source = await readFile(new URL(name, import.meta.url), 'utf8');
    assert.doesNotMatch(
      source,
      /console\.|error\.message|JSON\.stringify\(error\)/,
    );
    const writes =
      source.match(/process\.(?:stdout|stderr)\.write\([\s\S]*?\);/g) ?? [];
    for (const write of writes) {
      for (const secret of sensitive) assert.ok(!write.includes(secret));
      assert.doesNotMatch(write, /\b(?:error|request|body|capability)\b/);
    }
  }
});

test('diagnostic renderer rejects unrecognized code and send-state values', async () => {
  const { diagnostic } = await import('./flow.mjs');
  safeStatus(diagnostic(poison, poison), 'HARNESS_SETUP_INVALID', 'ambiguous');
});

function continuationFixture(overrides = {}) {
  const calls = { action: 0, confirm: [], reads: 0, notices: [] };
  const actionView = {
    status: 'action_required',
    clientSecret: 'synthetic-private-action',
    etag,
    paymentDeadline: '2099-10-05T18:04:00.000Z',
    continuationGeneration: 1,
  };
  const continuePayment = createContinuation({
    cartId,
    capability,
    stripe: {
      handleNextAction: async (value) => {
        calls.action++;
        assert.deepEqual(value, { clientSecret: 'synthetic-private-action' });
        return {};
      },
    },
    getStatus: async () => {
      calls.reads++;
      return {
        ...actionView,
        ...(calls.reads > 2 ? { status: 'processing' } : {}),
      };
    },
    sendConfirm: async (request) => {
      calls.confirm.push(structuredClone(request));
      return { accepted: true, sent: 'yes' };
    },
    onStatus: (text) => calls.notices.push(text),
    sleep: async () => {},
    attempts: 2,
    ...overrides,
  });
  return { calls, continuePayment, actionView };
}
test('accepted start enters next action once and continues once with no new token', async () => {
  const c = continuationFixture();
  const f = flow({ continuePayment: c.continuePayment });
  const result = await f.pay(input);
  await f.pay(input);
  await c.continuePayment();
  assert.equal(f.calls.token, 1);
  assert.equal(f.calls.sent.length, 1);
  assert.equal(c.calls.action, 1);
  assert.equal(c.calls.confirm.length, 1);
  assert.deepEqual(c.calls.confirm[0].body, { continuationGeneration: 1 });
  assert.equal(c.calls.confirm[0].etag, etag);
  assert.match(result, /HARNESS_PAYMENT_PROCESSING/);
  assert.doesNotMatch(
    [result, ...c.calls.notices].join(' '),
    /synthetic-private-action|ctoken_|client_secret/,
  );
});
for (const kind of ['missing', 'throw', 'error']) {
  test(`next action ${kind} stops safely without continuation or repeated action`, async () => {
    let invocations = 0;
    const c = continuationFixture({
      stripe:
        kind === 'missing'
          ? {}
          : {
              handleNextAction: async () => {
                invocations++;
                if (kind === 'throw')
                  throw Error(
                    'private@example.invalid client_secret ctoken_private',
                  );
                return {
                  error: {
                    message:
                      'private@example.invalid client_secret ctoken_private',
                  },
                };
              },
            },
    });
    const result = await c.continuePayment();
    await c.continuePayment();
    assert.match(
      result,
      new RegExp(
        kind === 'error'
          ? 'HARNESS_AUTHENTICATION_FAILED'
          : 'HARNESS_NEXT_ACTION_UNAVAILABLE',
      ),
    );
    assert.match(result, /Payment start already accepted/);
    assert.doesNotMatch(result, /private@|client_secret|ctoken_/);
    assert.equal(c.calls.confirm.length, 0);
    assert.ok(invocations <= 1);
  });
}
for (const kind of ['throw', 'ambiguous', 'reject']) {
  test(`continuation ${kind} never automatically replays or repeats authentication`, async () => {
    let sent = 0;
    const c = continuationFixture({
      sendConfirm: async () => {
        sent++;
        if (kind === 'throw') throw Error('secret');
        return kind === 'ambiguous'
          ? { sent: 'ambiguous' }
          : { sent: 'yes', accepted: false };
      },
    });
    const result = await c.continuePayment();
    await c.continuePayment();
    assert.match(
      result,
      new RegExp(
        kind === 'reject'
          ? 'HARNESS_CONFIRM_REQUEST_REJECTED'
          : 'HARNESS_CONFIRM_REQUEST_AMBIGUOUS',
      ),
    );
    assert.equal(sent, 1);
    assert.equal(c.calls.action, 1);
  });
}
for (const afterAction of [false, true]) {
  test(`deadline ${afterAction ? 'after' : 'before'} authentication prevents continuation`, async () => {
    let clock = 0;
    const c = continuationFixture({
      now: () => clock,
      stripe: {
        handleNextAction: async () => {
          clock = Date.parse('2099-10-05T18:04:00.000Z');
          return {};
        },
      },
    });
    if (!afterAction) clock = Date.parse('2099-10-05T18:04:00.000Z');
    assert.match(await c.continuePayment(), /HARNESS_PAYMENT_DEADLINE_ELAPSED/);
    assert.equal(c.calls.confirm.length, 0);
  });
}
test('bounded polling waits for asynchronous action status and uses fresh payment ETag', async () => {
  let reads = 0;
  const fresh = '"' + 'b'.repeat(64) + '"';
  const c = continuationFixture({
    getStatus: async () => {
      reads++;
      return {
        ...c.actionView,
        status:
          reads === 1
            ? 'payment_pending'
            : reads === 4
              ? 'paid'
              : 'action_required',
        etag: reads >= 3 ? fresh : etag,
      };
    },
  });
  assert.match(await c.continuePayment(), /Backend reports paid/);
  assert.equal(c.calls.confirm[0].etag, fresh);
});
test('webhook advancement after browser action skips unnecessary continuation', async () => {
  let reads = 0;
  const c = continuationFixture({
    getStatus: async () => ({
      ...c.actionView,
      status: ++reads === 1 ? 'action_required' : 'processing',
    }),
  });
  assert.match(await c.continuePayment(), /HARNESS_PAYMENT_PROCESSING/);
  assert.equal(c.calls.confirm.length, 0);
});
test('payment relay allows only safe status fields and keeps client secret out of URLs and continuation', async () => {
  const upstreamCalls = [];
  await relay(
    async (call) => {
      const view = await (
        await call('/payment', { cartId, capability })
      ).json();
      assert.equal(view.clientSecret, 'synthetic-private-action');
      assert.equal(view.raw, undefined);
      const result = await (
        await call('/confirm', {
          cartId,
          capability,
          etag,
          key: newKey(),
          body: { continuationGeneration: 1 },
        })
      ).json();
      assert.equal(result.accepted, true);
    },
    async (url, options) => {
      upstreamCalls.push({ url, options });
      if (url.endsWith('/payment'))
        return new Response(
          JSON.stringify({
            payment: {
              status: 'action_required',
              paymentDeadline: '2099-10-05T18:04:00.000Z',
              continuationGeneration: 1,
              clientSecret: 'synthetic-private-action',
              raw: 'private',
            },
          }),
          { headers: { etag } },
        );
      return new Response('{}', { status: 202 });
    },
    true,
  );
  assert.equal(upstreamCalls.length, 2);
  assert.ok(
    upstreamCalls.every(
      (c) => !c.url.includes(capability) && !c.url.includes('secret'),
    ),
  );
  assert.doesNotMatch(upstreamCalls[1].options.body, /secret|ctoken|customer/);
});
test('payment view drops secrets outside action state and rejects malformed contracts', () => {
  const p = {
    status: 'processing',
    paymentDeadline: '2099-10-05T18:04:00.000Z',
    continuationGeneration: 1,
    clientSecret: 'private',
  };
  assert.equal(paymentView({ payment: p }, etag).clientSecret, undefined);
  assert.throws(() =>
    paymentView({ payment: { ...p, status: 'raw-private' } }, etag),
  );
  assert.throws(() =>
    confirmRequest({
      cartId,
      capability,
      etag,
      key: newKey(),
      body: { continuationGeneration: 1, clientSecret: 'private' },
    }),
  );
});

test('local continuation remains disabled by default and reports a continuation-specific code', async () => {
  await relay(
    async (call) => {
      const response = await call('/confirm', {
        cartId,
        capability,
        etag,
        key: newKey(),
        body: { continuationGeneration: 1 },
      });
      assert.equal(response.status, 403);
      assert.equal(
        (await response.json()).code,
        'HARNESS_CONFIRM_REQUEST_REJECTED',
      );
    },
    async () => {
      throw Error('Must not reach upstream');
    },
  );
});
test('concurrent accepted-flow events cannot duplicate an in-flight authentication', async () => {
  let finish;
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  let actions = 0;
  const c = continuationFixture({
    stripe: {
      handleNextAction: async () => {
        actions++;
        await gate;
        return {};
      },
    },
  });
  const first = c.continuePayment();
  await c.continuePayment();
  finish();
  await first;
  assert.equal(actions, 1);
  assert.equal(c.calls.confirm.length, 1);
});

for (const status of ['failed', 'expired', 'cancelled']) {
  test(`accepted start terminal ${status} stops without another token or request`, async () => {
    const c = continuationFixture({
      getStatus: async () => ({ status }),
    });
    const f = flow({ continuePayment: c.continuePayment });
    const result = await f.pay(input);
    await f.pay(input);
    assert.match(result, /HARNESS_PAYMENT_TERMINAL_FAILURE/);
    assert.match(result, /payment\/start sent: yes/);
    assert.equal(f.calls.token, 1);
    assert.equal(f.calls.sent.length, 1);
    assert.equal(c.calls.action, 0);
    assert.equal(c.calls.confirm.length, 0);
    assert.doesNotMatch(
      result,
      /ctoken_|client_secret|synthetic-private|paid\./,
    );
  });
}
