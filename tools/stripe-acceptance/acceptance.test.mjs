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
} from './contract.mjs';
import { createFlow, newKey } from './flow.mjs';
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
      assert.deepEqual(await response.json(), { accepted: true, status: 201 });
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
