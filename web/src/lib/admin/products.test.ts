import { it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  catalogPage,
  catalogProduct,
  productFields,
  fieldErrors,
  fieldsOf,
  summaryOf,
  generatedSlug,
  nameChange,
  mergeCatalog,
  needsDeactivationConfirmation,
} from './products';
import {
  catalogRelay,
  adminRelay,
  type AdminConfig,
  PRODUCT_JSON_LIMIT,
} from './server';
import { productRequest, submissionGate } from './product-client';
import { ProductEditor, Products } from '../../components/admin/products';
vi.mock('server-only', () => ({}));
const p = {
  productId: '01K00000000000000000000001',
  name: 'Synthetic cookie',
  slug: 'synthetic-cookie',
  description: 'Synthetic only',
  ingredients: ['Butter'],
  allergens: ['Milk'],
  active: false,
  createdAt: '2026-10-01T12:00:00.000Z',
  updatedAt: '2026-10-01T12:00:00.000Z',
};
const config: AdminConfig = {
  NODE_ENV: 'production',
  ADMIN_ORIGIN: 'https://shop.test',
  ADMIN_API_BASE_URL: 'https://api.test',
  ADMIN_COGNITO_REGION: 'us-east-2',
  ADMIN_COGNITO_CLIENT_ID: 'Synthetic',
  ADMIN_SESSION_KEY: '12'.repeat(32),
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
async function setup(status = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('cognito-idp'))
      return json({
        AuthenticationResult: {
          AccessToken: 'synthetic.access.signature',
          ExpiresIn: 900,
        },
      });
    if (String(url).endsWith('/admin/me'))
      return json({
        authenticated: true,
        subject: 'synthetic',
        username: 'synthetic',
      });
    return status === 200
      ? json(
          init?.method === 'GET' && String(url).endsWith('/products')
            ? { products: [summaryOf(p)], nextCursor: null }
            : { product: p },
        )
      : json({ message: 'Do not forward raw errors' }, status);
  });
  const login = await adminRelay(
    new Request('https://shop.test/api/admin/login', {
      method: 'POST',
      headers: {
        origin: 'https://shop.test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        username: 'synthetic',
        password: 'synthetic-only',
      }),
    }),
    'login',
    config,
    fetcher,
  );
  const cookie = login.headers
    .getSetCookie()
    .find((x) => x.startsWith('__Host-bb-admin='))!
    .split(';')[0];
  calls.length = 0;
  return { fetcher, cookie, calls };
}
function request(
  cookie: string,
  method = 'GET',
  body?: unknown,
  origin = 'https://shop.test',
) {
  return new Request('https://shop.test/api/admin/products', {
    method,
    headers: { cookie, origin, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
it('projects all inactive catalog details, no invented price or media', () => {
  expect(
    catalogPage({ products: [summaryOf(p)], nextCursor: null }).products[0],
  ).toEqual(summaryOf(p));
  expect(() => productFields({ ...fieldsOf(p), priceCents: 100 })).toThrow();
  expect(() =>
    productFields({ ...fieldsOf(p), imageUrl: 'https://fake.test' }),
  ).toThrow();
});
it.each([
  { name: '' },
  { slug: 'Bad slug' },
  { ingredients: [''] },
  { allergens: [''] },
])('validates reusable fields %j', (patch) => {
  expect(() => productFields({ ...fieldsOf(p), ...patch })).toThrow();
});
it('preserves arrays and descriptions; detects invalid records and pagination', () => {
  expect(fieldsOf(catalogProduct(p))).toEqual(fieldsOf(p));
  expect(fieldErrors({ ...fieldsOf(p), name: ' ' })).toHaveProperty('name');
  expect(catalogPage({ products: [], nextCursor: 'abc' }).nextCursor).toBe(
    'abc',
  );
  expect(() =>
    catalogPage({ products: [summaryOf(p), summaryOf(p)], nextCursor: null }),
  ).toThrow();
  expect(() => catalogProduct({ ...p, productId: 'bad' })).toThrow();
});
it('rejects unauthorized catalog access before backend calls', async () => {
  const f = vi.fn<typeof fetch>();
  const r = await catalogRelay(request(''), undefined, config, f);
  expect(r.status).toBe(401);
  expect(f).not.toHaveBeenCalled();
});
it('forwards access token server-side only and returns no-store product DTO', async () => {
  const { fetcher, cookie, calls } = await setup();
  const r = await catalogRelay(request(cookie), undefined, config, fetcher);
  expect(r.status).toBe(200);
  expect(r.headers.get('cache-control')).toBe('no-store, private');
  expect(await r.text()).not.toContain('synthetic.access.signature');
  expect(calls.map((x) => x.url)).toEqual([
    'https://api.test/admin/me',
    'https://api.test/admin/products',
  ]);
  expect(new Headers(calls[1].init?.headers).get('authorization')).toBe(
    'Bearer synthetic.access.signature',
  );
});
it('requires same Origin before product mutations', async () => {
  const { fetcher, cookie, calls } = await setup();
  const r = await catalogRelay(
    request(cookie, 'POST', fieldsOf(p), 'https://evil.test'),
    undefined,
    config,
    fetcher,
  );
  expect(r.status).toBe(403);
  expect(calls).toHaveLength(0);
});
it('validates create body and never forwards forbidden monetary fields', async () => {
  const { fetcher, cookie, calls } = await setup();
  const r = await catalogRelay(
    request(cookie, 'POST', { ...fieldsOf(p), priceCents: 1 }),
    undefined,
    config,
    fetcher,
  );
  expect(r.status).toBe(400);
  expect(calls).toHaveLength(1);
});
it('edit forwards original revision through If-Match, not persisted fields', async () => {
  const { fetcher, cookie, calls } = await setup();
  const r = await catalogRelay(
    request(cookie, 'PUT', { ...fieldsOf(p), revision: p.updatedAt }),
    p.productId,
    config,
    fetcher,
  );
  expect(r.status).toBe(200);
  expect(new Headers(calls[1].init?.headers).get('if-match')).toBe(p.updatedAt);
  expect(JSON.parse(String(calls[1].init?.body))).toEqual(fieldsOf(p));
});
it.each([400, 404, 409, 500, 401, 403])(
  'maps backend failure %s without diagnostic leakage',
  async (status) => {
    const { fetcher, cookie } = await setup(status);
    const r = await catalogRelay(request(cookie), undefined, config, fetcher);
    expect(r.status).toBe(status === 500 ? 502 : status);
    expect(await r.text()).not.toContain('Do not forward');
  },
);
it('requires a revision on edit', async () => {
  const { fetcher, cookie, calls } = await setup();
  expect(
    (
      await catalogRelay(
        request(cookie, 'PUT', fieldsOf(p)),
        p.productId,
        config,
        fetcher,
      )
    ).status,
  ).toBe(400);
  expect(calls).toHaveLength(1);
});
it('submission gate rejects accidental concurrent submissions and releases after failure', async () => {
  const gate = submissionGate();
  let resolve!: () => void;
  let calls = 0;
  const a = gate(async () => {
    calls++;
    await new Promise<void>((r) => {
      resolve = r;
    });
  });
  await gate(async () => {
    calls++;
  });
  expect(calls).toBe(1);
  resolve();
  await a;
  await expect(
    gate(async () => {
      throw Error();
    }),
  ).rejects.toThrow();
  await gate(async () => {
    calls++;
  });
  expect(calls).toBe(2);
});
it('browser transport uses same-origin credentials, no caching, and no tokens', async () => {
  const f = vi.fn<typeof fetch>(async () =>
    json({ products: [], nextCursor: null }),
  );
  await productRequest('', 'GET', undefined, undefined, f);
  expect(f.mock.calls[0][1]).toMatchObject({
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
  });
});
it('form preserves editable values, native labels and keyboard controls', () => {
  const html = renderToStaticMarkup(
    createElement(ProductEditor, {
      product: p,
      onSaved: () => {},
      onClose: () => {},
      onDirty: () => {},
    }),
  );
  for (const v of [
    'Synthetic cookie',
    'Synthetic only',
    'Butter',
    'Milk',
    'Price set per Drop',
    'Technical details',
    'for="product-name"',
    'for="product-allergens"',
    'type="submit"',
  ])
    expect(html).toContain(v);
  expect(html).not.toContain('type="number"');
  const page = renderToStaticMarkup(
    createElement(Products, { expiresAt: Date.now() + 900000 }),
  );
  expect(page).toContain('Skip to products');
  expect(page).toContain('Loading products');
  expect(page).toContain('Add Cookie');
});

it.each([
  ['Chocolate Chip', 'chocolate-chip'],
  ['  Crème & Cocoa! ', 'creme-cocoa'],
  ['東京 🍪', 'cookie'],
  ['123 / Triple---Chocolate', '123-triple-chocolate'],
])('generates a backend-valid slug for %s', (name, slug) => {
  expect(generatedSlug(name)).toBe(slug);
  expect(productFields({ ...fieldsOf(p), name, slug }).slug).toBe(slug);
});
it('name changes preserve manual and saved slugs, while new automatic slugs follow names', () => {
  const fields = { ...fieldsOf(p), slug: 'custom-label' };
  expect(nameChange(fields, 'New Name', true).slug).toBe('new-name');
  expect(nameChange(fields, 'New Name', false).slug).toBe('custom-label');
});
it('requires confirmation only when an existing active product becomes inactive', () => {
  expect(needsDeactivationConfirmation({ ...p, active: true }, p)).toBe(true);
  expect(needsDeactivationConfirmation(p, p)).toBe(false);
  expect(needsDeactivationConfirmation(undefined, p)).toBe(false);
  expect(needsDeactivationConfirmation(p, { ...p, active: true })).toBe(false);
});
it('merges continuation pages without duplicate IDs, retaining later values', () => {
  const a = summaryOf(p),
    b = { ...a, productId: '01K00000000000000000000002' };
  expect(mergeCatalog([a], [b, { ...a, name: 'Changed' }])).toEqual([
    { ...a, name: 'Changed' },
    b,
  ]);
});
it('compact Unicode summaries fit UTF-8 JSON bounds without altering full details', () => {
  const large = {
    ...p,
    name: '🍪'.repeat(200),
    description: '\u0000東京'.repeat(2000),
  };
  const summary = summaryOf(large);
  expect(Buffer.byteLength(JSON.stringify(summary.name))).toBeLessThanOrEqual(
    512,
  );
  expect(
    Buffer.byteLength(JSON.stringify(summary.description)),
  ).toBeLessThanOrEqual(1024);
  expect(summary.nameTruncated && summary.descriptionTruncated).toBe(true);
  expect(catalogProduct(large)).toEqual(large);
});
it('accepts the reproduced large catalog as summaries, with continuation intact', async () => {
  const { fetcher, cookie } = await setup();
  const original = fetcher.getMockImplementation()!;
  const products = Array.from({ length: 100 }, (_, i) => ({
    ...p,
    productId: '01K' + String(i).padStart(23, '0'),
    description: 'x'.repeat(3000),
  }));
  expect(
    Buffer.byteLength(JSON.stringify({ products, nextCursor: 'abc' })),
  ).toBeGreaterThan(262144);
  fetcher.mockImplementation((url, init) =>
    String(url).endsWith('/products')
      ? Promise.resolve(
          json({ products: products.map(summaryOf), nextCursor: 'abc' }),
        )
      : original(url, init),
  );
  const response = await catalogRelay(
    request(cookie),
    undefined,
    config,
    fetcher,
  );
  expect(response.status).toBe(200);
  const page = await response.json();
  expect(page.products).toHaveLength(100);
  expect(page.nextCursor).toBe('abc');
});
it('full detail preserves a very large escaped record beyond the list cap', async () => {
  const { fetcher, cookie } = await setup();
  const original = fetcher.getMockImplementation()!;
  const large = {
    ...p,
    description: '\u0000'.repeat(350000),
    ingredients: ['東京'],
    allergens: ['Milk'],
  };
  fetcher.mockImplementation((url, init) =>
    String(url).endsWith('/' + p.productId)
      ? Promise.resolve(json({ product: large }))
      : original(url, init),
  );
  const response = await catalogRelay(
    request(cookie),
    p.productId,
    config,
    fetcher,
  );
  expect(response.status).toBe(200);
  expect((await response.json()).product).toEqual(large);
});
it.each([0, 1])(
  'enforces full-detail serialized byte boundary +%s',
  async (extra) => {
    const { fetcher, cookie } = await setup();
    const original = fetcher.getMockImplementation()!;
    const product = { ...p, description: '' };
    product.description = 'x'.repeat(
      PRODUCT_JSON_LIMIT -
        Buffer.byteLength(JSON.stringify({ product })) +
        extra,
    );
    fetcher.mockImplementation((url, init) =>
      String(url).endsWith('/' + p.productId)
        ? Promise.resolve(json({ product }))
        : original(url, init),
    );
    const r = await catalogRelay(request(cookie), p.productId, config, fetcher);
    expect(r.status).toBe(extra ? 502 : 200);
    if (extra) expect((await r.json()).code).toBe('PRODUCT_TOO_LARGE');
  },
);
it('rejects oversized writes explicitly before the mutation request', async () => {
  const { fetcher, cookie, calls } = await setup();
  const r = await catalogRelay(
    request(cookie, 'POST', {
      ...fieldsOf(p),
      description: 'x'.repeat(PRODUCT_JSON_LIMIT),
    }),
    undefined,
    config,
    fetcher,
  );
  expect(r.status).toBe(413);
  expect((await r.json()).code).toBe('PRODUCT_TOO_LARGE');
  expect(calls).toHaveLength(1);
});
it('large edited details are forwarded intact with the original revision', async () => {
  const { fetcher, cookie, calls } = await setup();
  const large = {
    ...fieldsOf(p),
    description: '\u0000'.repeat(350000),
    ingredients: ['東京'],
    allergens: ['Milk'],
  };
  const r = await catalogRelay(
    request(cookie, 'PUT', { ...large, revision: p.updatedAt }),
    p.productId,
    config,
    fetcher,
  );
  expect(r.status).toBe(200);
  expect(JSON.parse(String(calls[1].init?.body))).toEqual(large);
  expect(new Headers(calls[1].init?.headers).get('if-match')).toBe(p.updatedAt);
});
