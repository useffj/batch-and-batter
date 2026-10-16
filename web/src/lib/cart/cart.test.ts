import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cartRelay } from './relay';
import { CartClient, milestone, remaining, type Lock } from './client';
import {
  operation,
  parseCart,
  reservationMessage,
  total,
  type Cart,
  type Snapshot,
} from './contract';
import { CartPanel } from '../../components/cart/cart';
const dropId = '01K00000000000000000000000',
  productId = '01K00000000000000000000001',
  otherId = '01K00000000000000000000002',
  cartId = '01K00000000000000000000003';
const config = {
  NODE_ENV: 'production',
  STOREFRONT_API_BASE_URL: 'https://backend.test/dev',
  STOREFRONT_CURRENCY: 'USD',
};
const etag = '"' + 'a'.repeat(64) + '"',
  newer = '"' + 'b'.repeat(64) + '"';
const now = Date.parse('2026-10-05T12:00:00.000Z');
function cart(): Cart {
  return {
    cartId,
    dropId,
    status: 'ACTIVE',
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    shoppingExpiresAt: new Date(now + 480000).toISOString(),
    items: [{ productId, quantity: 1, priceCents: 525, cookieUnits: 3 }],
  };
}
const create = {
  kind: 'create' as const,
  dropId,
  items: [{ productId, quantity: 1 }],
};
const snapshot = (c = cart()): Snapshot => ({
  cart: c,
  etag,
  expired: false,
  pending: false,
  serverNow: now,
});
function request(body?: unknown, cookie = '', origin = 'https://shop.test') {
  return new Request('https://shop.test/api/cart', {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      origin,
      host: 'shop.test',
      cookie,
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function cookieFrom(response: Response) {
  return response.headers.get('set-cookie')?.split(';')[0] ?? '';
}
function exclusive(): Lock {
  let tail = Promise.resolve();
  return async (work) => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  };
}
// HTTP boundary model with cookie delivery independently controllable from body delivery.
function harness() {
  let cookie = '',
    state: Cart | null = null,
    revision = etag;
  let loss:
    'backend' | 'browser-with-headers' | 'browser-without-headers' | null =
    null;
  let creations = 0;
  const receipts = new Map<
    string,
    { body: string; token: string; cart: Cart; etag: string }
  >();
  const calls: {
    method: string;
    url: string;
    body: string;
    token: string;
    key: string | null;
    ifMatch: string | null;
  }[] = [];
  const backend = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    const h = new Headers(init?.headers),
      method = init?.method ?? 'GET',
      body = String(init?.body ?? '');
    const token = h.get('x-cart-token')!,
      key = h.get('idempotency-key');
    calls.push({
      method,
      url: String(url),
      body,
      token,
      key,
      ifMatch: h.get('if-match'),
    });
    if (method === 'GET')
      return Response.json(
        { cart: state, expired: state?.status === 'EXPIRED' },
        { headers: { etag: revision, date: new Date(now).toUTCString() } },
      );
    const receipt = receipts.get(key!);
    if (receipt) {
      expect({ body, token }).toEqual({
        body: receipt.body,
        token: receipt.token,
      });
      return Response.json(
        { cart: receipt.cart },
        {
          status: method === 'POST' ? 201 : 200,
          headers: { etag: receipt.etag, date: new Date(now).toUTCString() },
        },
      );
    }
    if (method === 'POST') {
      state = cart();
      state.items = JSON.parse(body).items.map(
        (p: { productId: string; quantity: number }) => ({
          ...p,
          priceCents: 525,
          cookieUnits: 3,
        }),
      );
      creations++;
    }
    if (method === 'PUT') {
      if (h.get('if-match') !== revision)
        return Response.json({ code: 'CART_CONFLICT' }, { status: 409 });
      state = {
        ...state!,
        items: JSON.parse(body).items.map(
          (p: { productId: string; quantity: number }) => ({
            ...p,
            priceCents: 525,
            cookieUnits: 3,
          }),
        ),
      };
      revision = newer;
    }
    if (method === 'DELETE') state = { ...state!, status: 'CANCELLED' };
    receipts.set(key!, {
      body,
      token,
      cart: structuredClone(state!),
      etag: revision,
    });
    if (loss === 'backend') {
      loss = null;
      throw new Error('private token ' + token);
    }
    return Response.json(
      { cart: state },
      {
        status: method === 'POST' ? 201 : 200,
        headers: { etag: revision, date: new Date(now).toUTCString() },
      },
    );
  }) as unknown as typeof fetch;
  const browser = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
    const action = String(path).endsWith('/session')
      ? 'prepare'
      : init?.method === 'POST'
        ? 'execute'
        : 'read';
    const response = await cartRelay(
      request(init?.body ? JSON.parse(String(init.body)) : undefined, cookie),
      action,
      config,
      backend,
    );
    const isLost =
      action === 'execute' &&
      (loss === 'browser-with-headers' || loss === 'browser-without-headers');
    if (!(isLost && loss === 'browser-without-headers')) {
      const next = cookieFrom(response);
      if (next) cookie = next.endsWith('=') ? '' : next;
    }
    if (isLost) {
      loss = null;
      throw new Error('Response lost');
    }
    return response;
  }) as unknown as typeof fetch;
  const lock = exclusive();
  const client = new CartClient(lock, browser);
  return {
    client,
    second: new CartClient(lock, browser),
    calls,
    backend,
    browser,
    lose: (v: typeof loss) => {
      loss = v;
    },
    get cookie() {
      return cookie;
    },
    get state() {
      return state;
    },
    get creations() {
      return creations;
    },
  };
}
afterEach(() => vi.useRealTimers());
describe('durable first-create and mutation journal', () => {
  it('persists capability BEFORE any backend call, in a secure cookie only', async () => {
    const backend = vi.fn();
    const response = await cartRelay(
      request(create),
      'prepare',
      config,
      backend,
    );
    expect(backend).not.toHaveBeenCalled();
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^__Host-bb-cart=/);
    for (const attr of [
      'HttpOnly',
      'Secure',
      'SameSite=strict',
      'Path=/',
      'Max-Age=604800',
    ])
      expect(cookie).toContain(attr);
    const decoded = JSON.parse(
      Buffer.from(cookieFrom(response).split('=')[1], 'base64url').toString(),
    );
    expect(Buffer.from(decoded.token, 'base64url')).toHaveLength(32);
    expect(decoded.pending.key).toMatch(/^v1\.\d{13}\.[\w-]{43}$/);
    expect(await response.text()).toBe('{"pending":true}');
    expect(cookie).not.toContain('Domain=');
  });
  it.each([
    'backend',
    'browser-with-headers',
    'browser-without-headers',
  ] as const)(
    'recovers %s response loss using one Cart and the original capability/key/body',
    async (loss) => {
      const h = harness();
      h.lose(loss);
      await expect(h.client.change(create)).rejects.toThrow();
      expect(h.creations).toBe(1);
      const result = await h.second.retry();
      expect(result.cart?.cartId).toBe(cartId);
      expect(h.creations).toBe(1);
      const creates = h.calls.filter((c) => c.method === 'POST');
      for (const c of creates) expect(c).toEqual(creates[0]);
      expect(result).not.toHaveProperty('token');
      expect(JSON.stringify(result)).not.toContain(creates[0].token);
    },
  );
  it('lost bootstrap headers cannot reserve inventory; received bootstrap survives a changed prepare attempt', async () => {
    const backend = vi.fn();
    const first = await cartRelay(request(create), 'prepare', config, backend);
    const noCookie = await cartRelay(request({}), 'execute', config, backend);
    expect(noCookie.status).toBe(409);
    expect(backend).not.toHaveBeenCalled();
    const second = await cartRelay(
      request(
        { ...create, items: [{ productId, quantity: 9 }] },
        cookieFrom(first),
      ),
      'prepare',
      config,
      backend,
    );
    expect(second.headers.get('set-cookie')).toBeNull();
    expect(await second.json()).toEqual({ pending: true });
  });
  it('subsequent addition and quantity updates use same Cart, desired set, exact If-Match and immutable deadline', async () => {
    const h = harness();
    const first = await h.client.change(create);
    const next = await h.client.change({
      kind: 'replace',
      cartId,
      ifMatch: first.etag!,
      items: [
        { productId, quantity: 2 },
        { productId: otherId, quantity: 1 },
      ],
    });
    expect(h.creations).toBe(1);
    expect(next.cart?.shoppingExpiresAt).toBe(first.cart?.shoppingExpiresAt);
    expect(h.calls.find((c) => c.method === 'PUT')).toMatchObject({
      url: 'https://backend.test/dev/carts/' + cartId + '/items',
      ifMatch: etag,
    });
    expect(total(next.cart!, 'priceCents')).toBe(1575);
    expect(total(next.cart!, 'cookieUnits')).toBe(9);
    expect((await h.second.restore()).cart?.shoppingExpiresAt).toBe(
      first.cart?.shoppingExpiresAt,
    );
  });
  it('ambiguous PUT retries same revision/body/key/capability, then refreshes current Cart', async () => {
    const h = harness();
    await h.client.change(create);
    h.lose('backend');
    await expect(
      h.client.change({
        kind: 'replace',
        cartId,
        ifMatch: etag,
        items: [{ productId, quantity: 2 }],
      }),
    ).rejects.toThrow();
    expect((await h.second.restore()).pending).toBe(true);
    expect((await h.second.retry()).cart?.items[0].quantity).toBe(2);
    const puts = h.calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(2);
    expect(puts[1]).toEqual(puts[0]);
  });
  it('two initial tabs serialize and create only one Cart; losing intent requires review', async () => {
    const h = harness();
    const results = await Promise.allSettled([
      h.client.change(create),
      h.second.change(create),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(h.creations).toBe(1);
    expect((await h.second.restore()).cart?.cartId).toBe(cartId);
  });
  it('two tabs with stale revisions cannot overwrite a newer quantity', async () => {
    const h = harness();
    await h.client.change(create);
    const changes = await Promise.allSettled([
      h.client.change({
        kind: 'replace',
        cartId,
        ifMatch: etag,
        items: [{ productId, quantity: 2 }],
      }),
      h.second.change({
        kind: 'replace',
        cartId,
        ifMatch: etag,
        items: [{ productId, quantity: 3 }],
      }),
    ]);
    expect(changes.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect((await h.second.restore()).cart?.items[0].quantity).toBe(2);
    expect(h.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });
  it('removing one line uses desired PUT; final release DELETE clears secure session', async () => {
    const h = harness();
    await h.client.change({
      ...create,
      items: [
        { productId, quantity: 1 },
        { productId: otherId, quantity: 1 },
      ],
    });
    const next = await h.client.change({
      kind: 'replace',
      cartId,
      ifMatch: etag,
      items: [{ productId, quantity: 1 }],
    });
    expect(next.cart?.items).toHaveLength(1);
    const result = await h.client.change({ kind: 'release', cartId });
    expect(result.cart?.status).toBe('CANCELLED');
    expect(h.cookie).toBe('');
    expect((await h.client.restore()).cart).toBeNull();
    const release = h.calls.find((c) => c.method === 'DELETE');
    expect(release?.body).toBe('');
    expect(release?.ifMatch).toBeNull();
  });
});
describe('relay trust boundary', () => {
  it.each([
    'https://evil.test',
    'null',
    'http://shop.test',
    'https://sibling.shop.test',
  ])('rejects origin %s without backend activity', async (origin) => {
    const backend = vi.fn();
    expect(
      (await cartRelay(request(create, '', origin), 'prepare', config, backend))
        .status,
    ).toBe(403);
    expect(backend).not.toHaveBeenCalled();
  });
  it('rejects forwarded-host origin spoofing', async () => {
    const r = request(create, '', 'https://evil.test');
    r.headers.set('x-forwarded-host', 'evil.test');
    expect((await cartRelay(r, 'prepare', config)).status).toBe(403);
  });
  it.each([
    { ...create, priceCents: 1 },
    { ...create, items: [] },
    { ...create, items: [{ productId: '../../payment/start', quantity: 1 }] },
    { ...create, items: [{ productId, quantity: 0 }] },
    {
      ...create,
      items: [
        { productId, quantity: 1 },
        { productId, quantity: 2 },
      ],
    },
  ])('rejects invalid request %#', async (body) =>
    expect((await cartRelay(request(body), 'prepare', config)).status).toBe(
      400,
    ),
  );
  it('bounds request body and execute body; validates cookie data', async () => {
    expect(
      (await cartRelay(request({ text: 'x'.repeat(16385) }), 'prepare', config))
        .status,
    ).toBe(400);
    expect(
      (await cartRelay(request({ text: 'x'.repeat(16385) }), 'execute', config))
        .status,
    ).toBe(400);
    expect(
      (
        await cartRelay(
          request(undefined, '__Host-bb-cart=broken'),
          'read',
          config,
        )
      ).status,
    ).toBe(401);
  });
  it.each(['not JSON', JSON.stringify({ cart: {} }), 'x'.repeat(16385)])(
    'keeps pending mutation on malformed response %#',
    async (body) => {
      const bootstrap = await cartRelay(request(create), 'prepare', config);
      const result = await cartRelay(
        request({}, cookieFrom(bootstrap)),
        'execute',
        config,
        vi.fn().mockResolvedValue(
          new Response(body, {
            headers: { 'content-type': 'application/json' },
          }),
        ),
      );
      expect(result.status).toBe(503);
      expect(result.headers.get('set-cookie')).toBeNull();
      expect(await result.json()).toMatchObject({
        code: 'INTERNAL_ERROR',
        pending: true,
      });
    },
  );
  it.each([
    'DROP_NOT_OPEN',
    'STOREFRONT_CONFLICT',
    'PRODUCT_NOT_AVAILABLE',
    'INSUFFICIENT_INVENTORY',
    'QUANTITY_LIMIT_EXCEEDED',
    'CART_CONFLICT',
    'IDEMPOTENCY_CONFLICT',
    'IDEMPOTENCY_KEY_EXPIRED',
  ])('projects real %s safely', async (code) => {
    const bootstrap = await cartRelay(request(create), 'prepare', config);
    const result = await cartRelay(
      request({}, cookieFrom(bootstrap)),
      'execute',
      config,
      vi.fn().mockResolvedValue(
        Response.json(
          {
            code,
            message: 'secret /private/path stack',
            headers: { token: 'secret' },
          },
          { status: 409 },
        ),
      ),
    );
    expect(result.status).toBe(409);
    expect(await result.text()).not.toContain('secret');
    expect(result.headers.get('cache-control')).toContain('no-store');
  });
  it.each(['PAUSED', 'CLOSED', 'SOLD_OUT', 'invented'])(
    'does not invent backend %s codes',
    async (code) => {
      const bootstrap = await cartRelay(request(create), 'prepare', config);
      const result = await cartRelay(
        request({}, cookieFrom(bootstrap)),
        'execute',
        config,
        vi.fn().mockResolvedValue(Response.json({ code }, { status: 409 })),
      );
      expect(await result.json()).toMatchObject({
        code: 'INTERNAL_ERROR',
        pending: true,
      });
    },
  );
  it('forwards ETag, private/no-store, fixed URL, no redirects; never logs secrets', async () => {
    const log = vi.spyOn(console, 'log');
    const h = harness();
    await h.client.change(create);
    const result = await cartRelay(
      request(undefined, h.cookie),
      'read',
      config,
      h.backend,
    );
    expect(result.headers.get('etag')).toBe(etag);
    expect(result.headers.get('cache-control')).toBe('no-store, private');
    expect(result.headers.get('vary')).toBe('Cookie');
    expect(JSON.stringify(await result.json())).not.toContain(h.calls[0].token);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
    expect(
      h.calls.every((c) => c.url.startsWith('https://backend.test/dev/carts')),
    ).toBe(true);
  });
  it('unauthorized clears cookie and projects no backend message', async () => {
    const h = harness();
    await h.client.change(create);
    const result = await cartRelay(
      request(undefined, h.cookie),
      'read',
      config,
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { code: 'UNAUTHORIZED', message: 'secret' },
            { status: 401 },
          ),
        ),
    );
    expect(result.status).toBe(401);
    expect(result.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(await result.text()).not.toContain('secret');
  });
  it('times out with a retained pending journal', async () => {
    vi.useFakeTimers();
    const bootstrap = await cartRelay(request(create), 'prepare', config);
    const backend = vi.fn(
      (_url, init) =>
        new Promise<Response>((_, reject) =>
          init.signal.addEventListener('abort', () =>
            reject(new Error('private')),
          ),
        ),
    );
    const pending = cartRelay(
      request({}, cookieFrom(bootstrap)),
      'execute',
      config,
      backend,
    );
    await vi.advanceTimersByTimeAsync(5000);
    const result = await pending;
    expect(result.status).toBe(503);
    expect(result.headers.get('set-cookie')).toBeNull();
  });
});
describe('expiry, presentation and accessibility', () => {
  function render(s: Snapshot, seconds = 120) {
    return renderToStaticMarkup(
      createElement(CartPanel, {
        snapshot: s,
        seconds,
        busy: false,
        disabled: false,
        drop: null,
        onChange: () => {},
        onRetry: () => {},
        onCheck: () => {},
        heading: createRef<HTMLHeadingElement>(),
      }),
    );
  }
  it('expired + ACTIVE is pending release; only terminal ownership says released', () => {
    const s = { ...snapshot(), expired: true };
    const html = render(s, 0);
    expect(html).toContain('We’re confirming');
    expect(html).not.toContain('Your reserved cookies have been released.');
    expect(html).not.toContain('aria-live="assertive"');
    for (const status of ['EXPIRED', 'CANCELLED'] as const) {
      expect(render(snapshot({ ...cart(), status }), 0)).toContain(
        'Your reserved cookies have been released.',
      );
    }
    for (const status of [
      'PAYMENT_PENDING',
      'PAYMENT_COMMITTING',
      'CONVERTED',
    ] as const)
      expect(reservationMessage({ ...cart(), status }, true)).not.toContain(
        'released',
      );
  });
  it('uses backend price/units for display math and semantic labeled quantity controls', () => {
    const s = snapshot({
      ...cart(),
      items: [{ productId, quantity: 2, priceCents: 777, cookieUnits: 3 }],
    });
    const html = render(s);
    expect(html).toContain('$15.54');
    expect(html).toContain('$7.77');
    expect(html).toContain('6 cookie units');
    expect(html).toContain('aria-label="Decrease quantity');
    expect(html).toContain('aria-label="Increase quantity');
    expect(html).toContain('aria-label="Remove');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('Checkout unavailable');
  });
  it('timer uses immutable server time plus monotonic elapsed, independent of browser wall clock', () => {
    const s = snapshot();
    vi.spyOn(Date, 'now').mockReturnValue(now + 86400000);
    expect(remaining(s, 100, 1100)).toBe(479000);
    expect(remaining(s, 100, 480100)).toBe(0);
    expect(s.cart?.shoppingExpiresAt).toBe(cart().shoppingExpiresAt);
    vi.restoreAllMocks();
  });
  it('announcements only change at milestones, never every second', () => {
    expect(milestone(400)).toBe('');
    expect(milestone(179)).toBe(milestone(178));
    expect(milestone(59)).toBe(milestone(58));
    expect(milestone(29)).toBe(milestone(28));
    expect(milestone(0)).toBe('Checking reservation status.');
  });
  it('validates overflow and rejects submitted prices or empty desired sets', () => {
    expect(() =>
      parseCart({
        ...cart(),
        items: [
          {
            productId,
            quantity: Number.MAX_SAFE_INTEGER,
            priceCents: 2,
            cookieUnits: 1,
          },
        ],
      }),
    ).toThrow();
    expect(() => operation({ ...create, priceCents: 1 })).toThrow();
    expect(() => operation({ ...create, items: [] })).toThrow();
  });
  it('source excludes browser capability storage and payment integration; includes resume and cross-tab coordination', () => {
    const ui = readFileSync('src/components/cart/cart.tsx', 'utf8'),
      client = readFileSync('src/lib/cart/client.ts', 'utf8');
    expect(ui + client).not.toMatch(
      /localStorage|sessionStorage|X-Cart-Token|payment\/start|stripe/i,
    );
    for (const hook of ['BroadcastChannel', 'navigator.locks'])
      expect(ui).toContain(hook);
  });
});
it('bootstrap body loss after Set-Cookie survives refresh and executes original intent', async () => {
  const first = await cartRelay(request(create), 'prepare', config);
  const cookie = cookieFrom(first);
  const restored = await cartRelay(request(undefined, cookie), 'read', config);
  expect(await restored.json()).toMatchObject({ cart: null, pending: true });
  const backend = vi
    .fn()
    .mockResolvedValue(
      Response.json({ cart: cart() }, { status: 201, headers: { etag } }),
    );
  const executed = await cartRelay(
    request({}, cookie),
    'execute',
    config,
    backend,
  );
  expect(executed.status).toBe(200);
  expect(backend.mock.calls[0][1].body).toBe(
    JSON.stringify({ dropId, items: create.items }),
  );
  expect(backend.mock.calls[0][1]).toMatchObject({
    cache: 'no-store',
    redirect: 'error',
  });
});
it('expired ACTIVE keeps session, while EXPIRED clears it and preserves historical deadline', async () => {
  const h = harness();
  await h.client.change(create);
  const pending = await cartRelay(
    request(undefined, h.cookie),
    'read',
    config,
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ cart: cart(), expired: true }, { headers: { etag } }),
      ),
  );
  expect(await pending.json()).toMatchObject({
    cart: { status: 'ACTIVE', shoppingExpiresAt: cart().shoppingExpiresAt },
    expired: true,
  });
  expect(pending.headers.get('set-cookie')).not.toContain('Max-Age=0');
  const terminal = await cartRelay(
    request(undefined, h.cookie),
    'read',
    config,
    vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { cart: { ...cart(), status: 'EXPIRED' }, expired: true },
          { headers: { etag } },
        ),
      ),
  );
  expect(terminal.headers.get('set-cookie')).toContain('Max-Age=0');
});
it('a native fetch implementation is invoked without a CartClient receiver', async () => {
  const native = vi.fn(function (this: unknown) {
    expect(this).toBeUndefined();
    return Promise.resolve(
      Response.json({
        cart: null,
        pending: false,
        expired: false,
        etag: null,
        serverNow: now,
      }),
    );
  });
  vi.stubGlobal('fetch', native);
  try {
    expect((await new CartClient(exclusive()).restore()).cart).toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});
it('handles malformed client relay data without rendering raw text', async () => {
  const client = new CartClient(
    exclusive(),
    vi.fn().mockResolvedValue(
      new Response('private stack /secret', {
        headers: { 'content-type': 'text/html' },
      }),
    ),
  );
  await expect(client.restore()).rejects.toThrow('We cannot reach your Cart');
});
it('configured cookie-unit limit disables increases at the limit, including multipacks', () => {
  const s = snapshot({
    ...cart(),
    items: [{ productId, quantity: 2, priceCents: 525, cookieUnits: 3 }],
  });
  const drop = {
    id: dropId,
    name: 'Drop',
    description: '',
    status: 'OPEN' as const,
    opensAt: new Date(now).toISOString(),
    timezone: 'UTC',
    pickupLocation: 'Kitchen',
    pickupInstructions: '',
    pickupDates: [],
    quantityLimit: 6,
    products: [
      {
        id: productId,
        name: 'Three-cookie pack',
        description: 'A buttery cookie with a soft center.',
        ingredients: ['Flour', 'Butter'],
        allergens: ['Wheat', 'Milk'],
        priceCents: 999,
        cookieUnits: 3,
        available: 100,
      },
    ],
  };
  const html = renderToStaticMarkup(
    createElement(CartPanel, {
      snapshot: s,
      seconds: 120,
      busy: false,
      disabled: false,
      drop,
      onChange: () => {},
      onRetry: () => {},
      onCheck: () => {},
      heading: createRef<HTMLHeadingElement>(),
    }),
  );
  expect(html).toContain('6 allowed');
  expect(html).toMatch(
    /aria-label="Increase quantity of Three-cookie pack" disabled/,
  );
  expect(html).toContain('$10.50');
  expect(html).not.toContain('$19.98');
});
it('PAUSED and CLOSED permit removal/decrease but disable acquisition controls', () => {
  for (const status of ['PAUSED', 'CLOSED', 'SOLD_OUT'] as const) {
    const s = snapshot({
      ...cart(),
      items: [{ productId, quantity: 2, priceCents: 525, cookieUnits: 3 }],
    });
    const drop = {
      id: dropId,
      name: 'Drop',
      description: '',
      status,
      opensAt: new Date(now).toISOString(),
      timezone: 'UTC',
      pickupLocation: 'Kitchen',
      pickupInstructions: '',
      pickupDates: [],
      quantityLimit: 18,
      products: [
        {
          id: productId,
          name: 'Cookie',
          description: 'A buttery cookie with a soft center.',
          ingredients: ['Flour', 'Butter'],
          allergens: ['Wheat', 'Milk'],
          priceCents: 999,
          cookieUnits: 3,
          available: 100,
        },
      ],
    };
    const html = renderToStaticMarkup(
      createElement(CartPanel, {
        snapshot: s,
        seconds: 120,
        busy: false,
        disabled: false,
        drop,
        onChange: () => {},
        onRetry: () => {},
        onCheck: () => {},
        heading: createRef<HTMLHeadingElement>(),
      }),
    );
    expect(html).toMatch(/aria-label="Increase quantity of Cookie" disabled/);
    expect(html).not.toMatch(
      /aria-label="Decrease quantity of Cookie" disabled/,
    );
    expect(html).not.toMatch(/aria-label="Remove Cookie from Cart" disabled/);
  }
});

it('without Web Locks, create/edit/release/retry fail closed before any request while restoration remains read-only', async () => {
  const request = vi.fn().mockResolvedValue(
    Response.json({
      cart: null,
      pending: false,
      expired: false,
      etag: null,
      serverNow: now,
    }),
  );
  const client = new CartClient(null, request);
  for (const op of [
    create,
    { kind: 'replace' as const, cartId, ifMatch: etag, items: create.items },
    { kind: 'release' as const, cartId },
  ]) {
    await expect(client.change(op)).rejects.toThrow('cannot safely update');
  }
  await expect(client.retry()).rejects.toThrow('cannot safely update');
  expect(request).not.toHaveBeenCalled();
  expect((await client.restore()).cart).toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][1]).toMatchObject({ method: 'GET' });
});

it('without Web Locks, the pending retry control is disabled', () => {
  const html = renderToStaticMarkup(
    createElement(CartPanel, {
      snapshot: { ...snapshot(), pending: true },
      seconds: 120,
      busy: false,
      disabled: true,
      canRetry: false,
      drop: null,
      onChange: () => {},
      onRetry: () => {},
      onCheck: () => {},
      heading: createRef<HTMLHeadingElement>(),
    }),
  );
  expect(html).toMatch(/<button disabled="">Retry saved change<\/button>/);
});
