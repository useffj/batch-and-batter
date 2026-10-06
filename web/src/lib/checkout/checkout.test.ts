import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Stripe, StripeElements } from '@stripe/stripe-js';
import { CartPanel } from '../../components/cart/cart';
import { CheckoutSummary, Checkout } from '../../components/checkout/checkout';
import { type Lock } from '../cart/client';
import {
  CheckoutClient,
  elementsOptions,
  expressOptions,
  markerKey,
  parseCheckout,
} from './client';
import {
  customer,
  startBody,
  payment,
  paymentMessages,
  pickupAllowed,
  type CheckoutSnapshot,
  type Payment,
} from './contract';
import { projectPricing, publishableKey } from './pricing';
import { checkoutRelay } from './relay';
const id = '01K00000000000000000000001',
  dropId = '01K00000000000000000000002',
  productId = '01K00000000000000000000003';
const etag = '"' + 'a'.repeat(64) + '"',
  paymentTag = '"' + 'b'.repeat(64) + '"';
const now = Date.parse('2026-10-06T12:00:00.000Z');
const config = {
  NODE_ENV: 'test',
  STOREFRONT_API_BASE_URL: 'https://backend.test/dev',
  STOREFRONT_CURRENCY: 'USD',
  CHECKOUT_PRICING_MODE: 'dev-zero-tax-fee',
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_mock',
};
const contact = {
  name: ' Guest ',
  email: 'guest@example.test',
  phone: '+13035550123',
  smsTransactionalConsent: false,
};
const body = {
  confirmationTokenId: 'ctoken_mock',
  pickupDate: '2026-10-08',
  customer: contact,
};
const key = `v1.${now}.${Buffer.alloc(32, 1).toString('base64url')}`;
const capability = Buffer.alloc(32, 2).toString('base64url');
const cookie =
  'bb-cart-local=' +
  Buffer.from(JSON.stringify({ token: capability, cartId: id })).toString(
    'base64url',
  );
function fresh(): CheckoutSnapshot {
  return {
    cart: {
      cartId: id,
      dropId,
      status: 'ACTIVE',
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      shoppingExpiresAt: new Date(now + 480000).toISOString(),
      items: [{ productId, quantity: 2, priceCents: 525, cookieUnits: 1 }],
    },
    etag,
    payment: null,
    paymentEtag: null,
    serverNow: now,
    available: true,
    summary: { currency: 'USD', subtotal: 1050, tax: 0, fees: 0, total: 1050 },
    drop: {
      id: dropId,
      name: 'Cookies',
      description: '',
      status: 'OPEN',
      opensAt: new Date(now - 1000).toISOString(),
      timezone: 'UTC',
      quantityLimit: 12,
      pickupLocation: 'Kitchen',
      pickupInstructions: 'Front door',
      products: [
        {
          id: productId,
          name: 'Cookie',
          priceCents: 999,
          cookieUnits: 1,
          available: 10,
        },
      ],
      pickupDates: [
        {
          date: '2026-10-08',
          startTime: '16:00',
          endTime: '19:00',
          timezone: 'UTC',
        },
      ],
    },
  };
}
function pending(status: Payment['status'] = 'processing'): CheckoutSnapshot {
  const s = fresh();
  s.available = false;
  s.cart!.status =
    status === 'paid'
      ? 'CONVERTED'
      : status === 'expired'
        ? 'EXPIRED'
        : status === 'failed'
          ? 'CANCELLED'
          : 'PAYMENT_PENDING';
  s.payment = {
    orderId: dropId,
    paymentAttemptId: productId,
    status,
    paymentDeadline: new Date(now + 240000).toISOString(),
    continuationGeneration: 1,
    ...(status === 'action_required'
      ? { clientSecret: 'pi_mock_secret_transient' }
      : {}),
  };
  s.paymentEtag = paymentTag;
  return s;
}
const response = (value: unknown, status = 200, tag = etag) =>
  Response.json(value, {
    status,
    headers: { etag: tag, date: new Date(now).toUTCString() },
  });
function req(value?: unknown, overrides: Record<string, string> = {}) {
  return new Request('https://shop.test/api/checkout', {
    method: value === undefined ? 'GET' : 'POST',
    headers: {
      cookie,
      origin: 'https://shop.test',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      'if-match': etag,
      'idempotency-key': key,
      ...overrides,
    },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
}
function mockBackend(s = fresh()) {
  return vi.fn(async (url: URL | RequestInfo) => {
    const path = String(url);
    if (path.endsWith('/drops/current')) {
      const d = s.drop!;
      return response({
        drop: {
          ...d,
          products: d.products.map((p) => ({
            ...p,
            availability: { total: 10, reserved: 0, sold: 0, available: 10 },
          })),
        },
      });
    }
    if (path.endsWith('/payment/start'))
      return response({ cart: { ...s.cart, status: 'PAYMENT_PENDING' } }, 201);
    if (path.endsWith('/payment/confirm'))
      return response({ accepted: true }, 202);
    if (path.endsWith('/payment'))
      return response({ payment: s.payment }, 200, paymentTag);
    return response({
      cart: {
        ...s.cart,
        ...(s.payment
          ? {
              paymentAttemptId: s.payment.paymentAttemptId,
              orderId: s.payment.orderId,
              paymentDeadline: s.payment.paymentDeadline,
            }
          : {}),
      },
      expired: s.cart?.status === 'EXPIRED',
    });
  });
}
function memory() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
    removeItem: (k: string) => {
      data.delete(k);
    },
  };
}
function serial(): Lock {
  let tail = Promise.resolve();
  return (work) => {
    const result = tail.then(work);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}
function providers() {
  const token = vi
      .fn()
      .mockResolvedValue({ confirmationToken: { id: 'ctoken_mock' } }),
    submit = vi.fn().mockResolvedValue({});
  return {
    token,
    submit,
    stripe: { createConfirmationToken: token } as unknown as Stripe,
    elements: { submit } as unknown as StripeElements,
  };
}
describe('approved DEV pricing and fields', () => {
  it('uses reserved prices and quantities rather than catalog prices', () => {
    expect(projectPricing(fresh().cart!, config)).toEqual(fresh().summary);
    const html = renderToStaticMarkup(
      createElement(CheckoutSummary, {
        snapshot: fresh(),
        pickup: '2026-10-08',
      }),
    );
    expect(html).toContain('$10.50');
    expect(html).not.toContain('$19.98');
    for (const label of [
      'Subtotal',
      'Tax',
      'Fees',
      'Total',
      'Kitchen',
      '16:00',
      '19:00',
    ])
      expect(html).toContain(label);
    expect(html.match(/\$0\.00/g)).toHaveLength(2);
  });
  it.each([undefined, '', 'production', 'zero-tax'])(
    'missing/unsupported mode %s fails closed',
    (mode) =>
      expect(
        projectPricing(fresh().cart!, {
          ...config,
          CHECKOUT_PRICING_MODE: mode,
        }),
      ).toBeNull(),
  );
  it.each([undefined, 'EUR', 'usd'])(
    'currency %s is not silently defaulted',
    (currency) =>
      expect(
        projectPricing(fresh().cart!, {
          ...config,
          STOREFRONT_CURRENCY: currency,
        }),
      ).toBeNull(),
  );
  it('uses the same display amount for deferred Elements and card-only scope', () =>
    expect(elementsOptions(fresh().summary!)).toMatchObject({
      amount: 1050,
      currency: 'usd',
      captureMethod: 'manual',
      allowedPaymentMethodTypes: ['card'],
      paymentMethodCreation: 'manual',
    }));
  it('Express Checkout excludes unrelated wallets', () =>
    expect(expressOptions.paymentMethods).toEqual({
      applePay: 'auto',
      googlePay: 'auto',
      amazonPay: 'never',
      link: 'never',
      paypal: 'never',
      klarna: 'never',
    }));
  it.each([true, false])(
    'consent %s remains explicit',
    (smsTransactionalConsent) =>
      expect(customer({ ...contact, smsTransactionalConsent })).toEqual({
        ...contact,
        name: 'Guest',
        smsTransactionalConsent,
      }),
  );
  it.each([
    { name: '' },
    { name: ' '.repeat(10) },
    { name: 'x'.repeat(201) },
    { email: 'a..b@example.test' },
    { email: 'bad' },
    { phone: '3035550123' },
    { phone: '+03035550123' },
    { phone: '+1 3035550123' },
    { smsTransactionalConsent: undefined },
  ])('rejects invalid customer %#', (patch) =>
    expect(() => customer({ ...contact, ...patch })).toThrow(),
  );
  it('accepts E.164 lengths and rejects unknown customer fields', () => {
    expect(customer({ ...contact, phone: '+12345678' }).phone).toBe(
      '+12345678',
    );
    expect(() => customer({ ...contact, marketing: true })).toThrow();
  });
  it.each([
    'total',
    'subtotal',
    'tax',
    'fees',
    'currency',
    'price',
    'paymentIntentId',
  ])('rejects browser financial or provider field %s', (field) =>
    expect(() => startBody({ ...body, [field]: 1 })).toThrow(),
  );
  it('uses exact current start shape and validates calendar dates', () => {
    expect(Object.keys(startBody(body)).sort()).toEqual([
      'confirmationTokenId',
      'customer',
      'pickupDate',
    ]);
    expect(() => startBody({ ...body, pickupDate: '2026-02-30' })).toThrow();
  });
  it('pickup remains valid on the same day only before its local end', () => {
    const p = fresh().drop!.pickupDates[0];
    expect(pickupAllowed(p, Date.parse('2026-10-08T18:59:00Z'))).toBe(true);
    expect(pickupAllowed(p, Date.parse('2026-10-08T19:00:00Z'))).toBe(false);
  });
  it.each([undefined, '', 'sk_test_example', 'pk_live_example'])(
    'key %s fails closed',
    (value) => expect(publishableKey(value)).toBeNull(),
  );
});
describe('same-origin relay', () => {
  it('reads fixed Cart/drop paths, projects pricing, hides capability and has no-store', async () => {
    const upstream = mockBackend();
    const r = await checkoutRelay(req(), 'read', config, upstream);
    const text = await r.text();
    expect(r.status).toBe(200);
    expect(JSON.parse(text).available).toBe(true);
    expect(text).not.toContain(capability);
    expect(r.headers.get('cache-control')).toContain('no-store');
    expect(r.headers.get('set-cookie')).toBeNull();
    expect(String(upstream.mock.calls[0][0])).toBe(
      `https://backend.test/dev/carts/${id}`,
    );
  });
  it('adds capability server-side and forwards exact submission/revision without financial amounts', async () => {
    const upstream = vi
      .fn()
      .mockResolvedValue(
        response({ cart: { ...fresh().cart, status: 'PAYMENT_PENDING' } }, 201),
      );
    const r = await checkoutRelay(req(body), 'start', config, upstream);
    expect(r.status).toBe(201);
    expect(upstream.mock.calls[0][1]).toMatchObject({
      redirect: 'error',
      cache: 'no-store',
      headers: {
        'X-Cart-Token': capability,
        'If-Match': etag,
        'Idempotency-Key': key,
      },
    });
    expect(JSON.parse(upstream.mock.calls[0][1].body)).toEqual({
      ...body,
      customer: { ...contact, name: 'Guest' },
    });
    expect(await r.json()).toEqual({ accepted: true });
  });
  it.each(['https://evil.test', 'null', 'https://shop.test.evil.test'])(
    'rejects origin %s before upstream',
    async (origin) => {
      const upstream = vi.fn();
      expect(
        (await checkoutRelay(req(body, { origin }), 'start', config, upstream))
          .status,
      ).toBe(403);
      expect(upstream).not.toHaveBeenCalled();
    },
  );
  it('rejects cross-site reads and forwarded-origin spoofing', async () => {
    const cases: Record<string, string>[] = [
      { 'sec-fetch-site': 'cross-site' },
      { origin: 'https://evil.test', 'x-forwarded-host': 'evil.test' },
    ];
    for (const headers of cases)
      expect(
        (await checkoutRelay(req(undefined, headers), 'read', config, vi.fn()))
          .status,
      ).toBe(403);
  });
  it.each(['', 'bb-cart-local=bad', cookie + '; ' + cookie])(
    'absent/invalid/duplicate session %# fails closed',
    async (cookie) => {
      const upstream = vi.fn();
      expect(
        (
          await checkoutRelay(
            req(undefined, { cookie }),
            'read',
            config,
            upstream,
          )
        ).status,
      ).toBe(401);
      expect(upstream).not.toHaveBeenCalled();
    },
  );
  it('bounds bodies, rejects extra fields and malformed revisions', async () => {
    for (const value of [
      { ...body, total: 1050 },
      { ...body, customer: { ...contact, name: 'x'.repeat(20000) } },
    ])
      expect(
        (await checkoutRelay(req(value), 'start', config, vi.fn())).status,
      ).toBe(400);
    expect(
      (
        await checkoutRelay(
          req(body, { 'if-match': '*' }),
          'start',
          config,
          vi.fn(),
        )
      ).status,
    ).toBe(400);
  });
  it.each([
    {},
    { CHECKOUT_PRICING_MODE: 'unknown' },
    { NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: '' },
  ])('configuration fails closed %#', async (patch) => {
    const cfg = Object.keys(patch).length
      ? { ...config, ...patch }
      : { ...config, CHECKOUT_PRICING_MODE: undefined };
    const upstream = vi.fn();
    expect(
      (await checkoutRelay(req(body), 'start', cfg, upstream)).status,
    ).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });
  it.each(['EXPIRED', 'CANCELLED'] as const)(
    'terminal Cart %s cannot pay',
    async (status) => {
      const s = fresh();
      s.cart!.status = status;
      const r = await checkoutRelay(req(), 'read', config, mockBackend(s));
      expect((await r.json()).available).toBe(false);
    },
  );
  it('expired shopping timestamp cannot pay even if worker has not released inventory', async () => {
    const s = fresh();
    s.cart!.shoppingExpiresAt = new Date(now - 1).toISOString();
    expect(
      (
        await (
          await checkoutRelay(req(), 'read', config, mockBackend(s))
        ).json()
      ).available,
    ).toBe(false);
  });
  it('projects action secret only on authorized action state and never raw provider fields', async () => {
    const s = pending('action_required');
    const r = await checkoutRelay(req(), 'read', config, mockBackend(s));
    const value = await r.json();
    expect(value.payment.clientSecret).toBe(s.payment!.clientSecret);
    expect(value.paymentEtag).toBe(paymentTag);
    expect(r.headers.get('cache-control')).toContain('no-store');
    expect(r.headers.get('set-cookie')).toBeNull();
  });
  it('safe disabled/error projection never leaks provider messages', async () => {
    const upstream = vi.fn().mockResolvedValue(
      response(
        {
          code: 'PAYMENTS_DISABLED',
          message: 'raw provider data',
          requestId: 'internal',
        },
        503,
      ),
    );
    const r = await checkoutRelay(req(body), 'start', config, upstream);
    expect(await r.json()).toEqual({ code: 'PAYMENTS_DISABLED' });
  });
  it('malformed or ambiguous upstream is recovery, never success', async () => {
    const upstream = vi.fn().mockRejectedValue(new Error('private exception'));
    const r = await checkoutRelay(req(body), 'start', config, upstream);
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ code: 'RECOVERY_REQUIRED' });
  });
  it('continuation uses only fixed route and generation', async () => {
    const upstream = vi
      .fn()
      .mockResolvedValue(response({ accepted: true }, 202));
    expect(
      (
        await checkoutRelay(
          req({ continuationGeneration: 1 }, { 'if-match': paymentTag }),
          'continue',
          config,
          upstream,
        )
      ).status,
    ).toBe(202);
    expect(String(upstream.mock.calls[0][0]).endsWith('/payment/confirm')).toBe(
      true,
    );
    expect(JSON.parse(upstream.mock.calls[0][1].body)).toEqual({
      continuationGeneration: 1,
    });
  });
});
describe('payment lifecycle and concurrency', () => {
  it('opening/reloading does not validate Elements, create a token or start payment', async () => {
    const request = vi.fn().mockResolvedValue(response(fresh()));
    const c = new CheckoutClient(serial(), memory(), request);
    await c.restore();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe('/api/checkout');
    expect(request.mock.calls[0][1].method).toBe('GET');
  });
  it('validates Elements before creating token and submits exact body once', async () => {
    const p = providers(),
      store = memory();
    let accepted = false;
    const request = vi.fn(async (_url, init) => {
      if (init?.method === 'POST') {
        accepted = true;
        return response({ accepted: true }, 201);
      }
      return response(accepted ? pending() : fresh());
    });
    const c = new CheckoutClient(serial(), store, request);
    const result = await c.submit(
      fresh(),
      contact,
      body.pickupDate,
      p.stripe,
      p.elements,
    );
    expect(result.payment!.status).toBe('processing');
    expect(p.submit.mock.invocationCallOrder[0]).toBeLessThan(
      p.token.mock.invocationCallOrder[0],
    );
    const writes = request.mock.calls.filter(
      ([, init]) => init?.method === 'POST',
    );
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0][1]!.body as string)).toEqual({
      ...body,
      customer: { ...contact, name: 'Guest' },
    });
    expect(writes[0][1]!.headers['Idempotency-Key']).toMatch(
      /^v1\.\d{13}\.[\w-]{43}$/,
    );
    expect([...store.data.values()]).toEqual(['unresolved']);
  });
  it('Elements validation failure creates no token/start and safely clears marker', async () => {
    const p = providers();
    p.submit.mockResolvedValue({ error: { message: 'private' } });
    const store = memory(),
      request = vi.fn().mockResolvedValue(response(fresh()));
    await expect(
      new CheckoutClient(serial(), store, request).submit(
        fresh(),
        contact,
        body.pickupDate,
        p.stripe,
        p.elements,
      ),
    ).rejects.toThrow('secure payment form');
    expect(p.token).not.toHaveBeenCalled();
    expect(store.data.size).toBe(0);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('invalid contact/pickup prevents provider activity', async () => {
    const p = providers(),
      request = vi.fn().mockResolvedValue(response(fresh())),
      c = new CheckoutClient(serial(), memory(), request);
    await expect(
      c.submit(
        fresh(),
        { ...contact, phone: '123' },
        body.pickupDate,
        p.stripe,
        p.elements,
      ),
    ).rejects.toThrow();
    await expect(
      c.submit(fresh(), contact, '2026-11-01', p.stripe, p.elements),
    ).rejects.toThrow();
    expect(p.submit).not.toHaveBeenCalled();
  });
  it('duplicate clicks and concurrent tabs produce at most one token and start', async () => {
    const p = providers(),
      store = memory(),
      lock = serial();
    let accepted = false;
    const request = vi.fn(async (_url, init) => {
      if (init?.method === 'POST') {
        accepted = true;
        return response({ accepted: true }, 201);
      }
      return response(accepted ? pending() : fresh());
    });
    const a = new CheckoutClient(lock, store, request),
      b = new CheckoutClient(lock, store, request);
    const work = [
      a.submit(fresh(), contact, body.pickupDate, p.stripe, p.elements),
      a.submit(fresh(), contact, body.pickupDate, p.stripe, p.elements),
      b.submit(fresh(), contact, body.pickupDate, p.stripe, p.elements),
    ];
    const result = await Promise.allSettled(work);
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(p.token).toHaveBeenCalledTimes(1);
    expect(
      request.mock.calls.filter(([, init]) => init?.method === 'POST'),
    ).toHaveLength(1);
  });
  it('ambiguous start with ACTIVE backend blocks new token after reload', async () => {
    const p = providers(),
      store = memory(),
      lock = serial();
    const request = vi.fn(async (_url, init) => {
      if (init?.method === 'POST') throw new Error('lost response');
      return response(fresh());
    });
    await expect(
      new CheckoutClient(lock, store, request).submit(
        fresh(),
        contact,
        body.pickupDate,
        p.stripe,
        p.elements,
      ),
    ).rejects.toThrow('cannot confirm');
    const next = new CheckoutClient(lock, store, request);
    expect((await next.restore()).available).toBe(false);
    await expect(
      next.submit(fresh(), contact, body.pickupDate, p.stripe, p.elements),
    ).rejects.toThrow();
    expect(p.token).toHaveBeenCalledTimes(1);
    expect(store.getItem(markerKey(id))).toBe('unresolved');
  });
  it('accepted lost-response reload recovers canonical paid state with no replacement', async () => {
    const store = memory();
    store.setItem(markerKey(id), 'unresolved');
    const request = vi.fn().mockResolvedValue(response(pending('paid')));
    expect(
      (await new CheckoutClient(serial(), store, request).restore()).payment
        ?.status,
    ).toBe('paid');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('disabled admission is safely surfaced without fake success', async () => {
    const p = providers(),
      store = memory(),
      request = vi.fn(async (_url, init) =>
        response(
          init?.method === 'POST' ? { code: 'PAYMENTS_DISABLED' } : fresh(),
          init?.method === 'POST' ? 503 : 200,
        ),
      );
    await expect(
      new CheckoutClient(serial(), store, request).submit(
        fresh(),
        contact,
        body.pickupDate,
        p.stripe,
        p.elements,
      ),
    ).rejects.toThrow('not available');
    expect(store.data.size).toBe(0);
  });
  it('without locks or durable marker support payment fails closed', async () => {
    const p = providers();
    for (const c of [
      new CheckoutClient(null, memory(), vi.fn()),
      new CheckoutClient(serial(), null, vi.fn()),
    ])
      await expect(
        c.submit(fresh(), contact, body.pickupDate, p.stripe, p.elements),
      ).rejects.toThrow('current browser');
    expect(p.token).not.toHaveBeenCalled();
  });
  it('browser action success rereads backend and cannot itself mark paid', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(response(pending('action_required')))
      .mockResolvedValueOnce(response(pending('processing')));
    const handleNextAction = vi
      .fn()
      .mockResolvedValue({ paymentIntent: { status: 'succeeded' } });
    const result = await new CheckoutClient(
      serial(),
      memory(),
      request,
    ).authenticate({ handleNextAction } as unknown as Stripe);
    expect(result.payment!.status).toBe('processing');
    expect(handleNextAction).toHaveBeenCalledWith({
      clientSecret: 'pi_mock_secret_transient',
    });
    expect(request.mock.calls.map((c) => c[0])).toEqual([
      '/api/checkout',
      '/api/checkout',
    ]);
  });
  it('conditional continuation wakes the same attempt, without another token/confirmation', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(response(pending('action_required')))
      .mockResolvedValueOnce(response(pending('action_required')))
      .mockResolvedValueOnce(response({ accepted: true }, 202))
      .mockResolvedValueOnce(response(pending('processing')));
    const handleNextAction = vi.fn().mockResolvedValue({});
    const c = new CheckoutClient(serial(), memory(), request);
    const result = await c.authenticate({
      handleNextAction,
    } as unknown as Stripe);
    expect(result.payment!.paymentAttemptId).toBe(productId);
    expect(request.mock.calls[2][0]).toBe('/api/checkout/continue');
    expect(JSON.parse(request.mock.calls[2][1].body)).toEqual({
      continuationGeneration: 1,
    });
  });
  it('action error rereads but never issues a success wakeup', async () => {
    const request = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(response(pending('action_required'))),
      );
    await new CheckoutClient(serial(), memory(), request).authenticate({
      handleNextAction: async () => ({ error: { message: 'private' } }),
    } as unknown as Stripe);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('immutable deadline mismatch fails closed', async () => {
    const second = pending();
    second.payment!.paymentDeadline = new Date(now + 480000).toISOString();
    const request = vi
      .fn()
      .mockResolvedValueOnce(response(pending()))
      .mockResolvedValueOnce(response(second));
    const c = new CheckoutClient(serial(), memory(), request);
    await c.restore();
    await expect(c.restore()).rejects.toThrow('cannot confirm');
  });
  it('deadline closure retains backend processing, never fabricates expiry/release', async () => {
    const s = pending();
    s.serverNow = now + 600000;
    const c = new CheckoutClient(
      serial(),
      memory(),
      vi.fn().mockResolvedValue(response(s)),
    );
    expect((await c.restore()).payment!.status).toBe('processing');
  });
  it.each([
    'paid',
    'failed',
    'expired',
    'cancelled',
    'payment_pending',
    'processing',
    'action_required',
  ] as const)('actual state %s has safe customer presentation', (status) => {
    expect(payment(pending(status).payment).status).toBe(status);
    expect(paymentMessages[status]).toBeTruthy();
  });
  it('discards secret on non-actionable state and rejects unknown status', () => {
    expect(
      payment({ ...pending().payment, clientSecret: 'private' }).clientSecret,
    ).toBeUndefined();
    expect(() =>
      payment({ ...pending().payment, status: 'succeeded' }),
    ).toThrow();
  });
});
it('active Cart has intentional checkout entry; expired/nonactive do not', () => {
  for (const status of ['ACTIVE', 'EXPIRED', 'CANCELLED'] as const) {
    const s = fresh();
    s.cart!.status = status;
    const html = renderToStaticMarkup(
      createElement(CartPanel, {
        snapshot: {
          cart: s.cart,
          etag,
          serverNow: now,
          pending: false,
          expired: status === 'EXPIRED',
        },
        seconds: 120,
        busy: false,
        disabled: false,
        drop: s.drop,
        onChange: () => {},
        onRetry: () => {},
        onCheck: () => {},
        heading: createRef<HTMLHeadingElement>(),
      }),
    );
    expect(html.includes('Continue to checkout')).toBe(status === 'ACTIVE');
  }
});
it('missing key server rendering is safe and contains no payment fields', () => {
  const html = renderToStaticMarkup(
    createElement(Checkout, { publishableKey: null }),
  );
  expect(html).toContain('Checking your Cart');
  expect(html).not.toMatch(/cardNumber|clientSecret|ctoken_/);
});
it('checkout privacy boundaries and semantic controls are explicit', () => {
  const ui = readFileSync(
    new URL('../../components/checkout/checkout.tsx', import.meta.url),
    'utf8',
  );
  const client = readFileSync(new URL('./client.ts', import.meta.url), 'utf8');
  expect(ui).toContain('PaymentElement');
  expect(ui).toContain('ExpressCheckoutElement');
  expect(ui).toContain('reportValidity');
  expect(ui).toContain('role="alert"');
  expect(ui).toContain('aria-live="off"');
  expect(ui).toContain('heading.current?.focus');
  expect(ui + client).not.toMatch(
    /console\.|document\.cookie|sessionStorage|return_url|confirmPayment|cardNumber|card_number|cvc:/,
  );
  expect(client).toMatch(/setItem\(marker,\s*'unresolved'\)/);
  expect(client).not.toContain('JSON.stringify(contact)');
  expect(parseCheckout(fresh()).summary).toEqual(fresh().summary);
});
it('checkout is unavailable when no pickup window remains eligible', async () => {
  const s = fresh();
  s.drop!.pickupDates = [];
  const result = await checkoutRelay(req(), 'read', config, mockBackend(s));
  expect((await result.json()).available).toBe(false);
});
