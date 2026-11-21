import { it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Products } from '../../components/admin/products';
import {
  adminRelay,
  catalogRelay,
  dropRelay,
  mediaRelay,
  mediaImageRelay,
} from './server';
import profile from './shared-profile.json';
import { summaryOf, fieldsOf } from './products';
vi.mock('server-only', () => ({}));
const cfg = {
  ...profile,
  STOREFRONT_API_BASE_URL: 'https://storefront.invalid/',
  NODE_ENV: 'production',
  ADMIN_SESSION_KEY: '12'.repeat(32),
};
const sharedId = '01K00000000000000000000001',
  isolatedId = '01K00000000000000000000002';
const stamp = '2026-01-01T00:00:00.000Z';
const product = (productId: string) => ({
  productId,
  name: 'Cookie',
  slug: 'cookie',
  description: '',
  active: true,
  ingredients: [],
  allergens: [],
  createdAt: stamp,
  updatedAt: stamp,
});
const json = (v: unknown, status = 200) => Response.json(v, { status });
it('uses independent Product identities and forwards the access token only to the fixed workspace API', async () => {
  const calls: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname.startsWith('cognito-idp.'))
      return json({
        AuthenticationResult: {
          AccessToken: 'fixture.access.token',
          ExpiresIn: 900,
        },
      });
    calls.push(url.href);
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer fixture.access.token',
    );
    expect(init?.redirect).toBe('error');
    expect(init?.cache).toBe('no-store');
    const id =
      url.origin === profile.ADMIN_MEDIA_API_BASE_URL ? isolatedId : sharedId;
    if (url.pathname === '/admin/me')
      return json({
        authenticated: true,
        subject: 'fixture',
        username: 'fixture',
      });
    if (url.pathname === '/admin/products')
      return json({ products: [summaryOf(product(id))], nextCursor: null });
    if (url.pathname === '/admin/products/' + id)
      return json({ product: product(id) });
    if (
      url.pathname === '/admin/products/' + isolatedId + '/media' &&
      id === isolatedId
    )
      return json({
        manifest: { version: 1, productId: id, revision: 0, images: [] },
      });
    if (
      url.pathname.endsWith('/assets/' + sharedId) &&
      url.search === '?view=image' &&
      id === isolatedId
    )
      return new Response(Uint8Array.of(1), {
        headers: { 'content-type': 'image/webp' },
      });
    if (url.pathname === '/admin/drops')
      return json({ drops: [], nextCursor: null });
    if (url.pathname.endsWith('/draft'))
      return json({ code: 'VALIDATION_ERROR', message: 'Invalid draft' }, 400);
    return json({ code: 'PRODUCT_NOT_FOUND' }, 404);
  };
  const login = await adminRelay(
    new Request(cfg.ADMIN_ORIGIN + '/api/admin/login', {
      method: 'POST',
      headers: { origin: cfg.ADMIN_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'fixture', password: 'synthetic' }),
    }),
    'login',
    cfg,
    transport,
  );
  const cookie = login.headers
    .getSetCookie()
    .find((x) => x.startsWith('__Host-bb-admin='))!
    .split(';')[0];
  const req = (method = 'GET') =>
    new Request(cfg.ADMIN_ORIGIN + '/api/admin/test', {
      method,
      headers: {
        cookie,
        origin: cfg.ADMIN_ORIGIN,
        'content-type': 'application/json',
      },
      ...(method === 'PUT' ? { body: '{}' } : {}),
    });
  for (const photo of [false, true]) {
    calls.length = 0;
    const id = photo ? isolatedId : sharedId,
      base = photo
        ? profile.ADMIN_MEDIA_API_BASE_URL
        : profile.ADMIN_API_BASE_URL;
    const list = await catalogRelay(req(), undefined, cfg, transport, photo);
    expect((await list.json()).products[0].productId).toBe(id);
    const detail = await catalogRelay(req(), id, cfg, transport, photo);
    expect((await detail.json()).product.productId).toBe(id);
    expect(calls).toEqual([
      base + '/admin/me',
      base + '/admin/products',
      base + '/admin/me',
      base + '/admin/products/' + id,
    ]);
  }
  calls.length = 0;
  expect(
    (await catalogRelay(req('PUT'), sharedId, cfg, transport)).status,
  ).toBe(405);
  expect(calls).toEqual([]);
  expect((await dropRelay(req(), [], cfg, transport)).status).toBe(200);
  expect(
    (await dropRelay(req('PUT'), [sharedId, 'draft'], cfg, transport)).status,
  ).toBe(400);
  expect(
    calls.every((url) => url.startsWith(profile.ADMIN_API_BASE_URL + '/')),
  ).toBe(true);
  expect(calls).toContain(
    profile.ADMIN_API_BASE_URL + '/admin/drops/' + sharedId + '/draft',
  );
  calls.length = 0;
  expect(
    (
      await mediaRelay(
        req(),
        { productId: sharedId, kind: 'manifest' },
        cfg,
        transport,
      )
    ).status,
  ).toBe(404);
  expect(calls.some((url) => url.endsWith('/media'))).toBe(false);
  calls.length = 0;
  expect(
    (
      await mediaRelay(
        req(),
        { productId: isolatedId, kind: 'manifest' },
        cfg,
        transport,
      )
    ).status,
  ).toBe(200);
  expect(
    (await mediaImageRelay(req(), isolatedId, sharedId, cfg, transport)).status,
  ).toBe(200);
  expect(
    calls.every((url) =>
      url.startsWith(profile.ADMIN_MEDIA_API_BASE_URL + '/'),
    ),
  ).toBe(true);
  expect(
    (
      await catalogRelay(
        new Request(cfg.ADMIN_ORIGIN),
        undefined,
        cfg,
        transport,
        true,
      )
    ).status,
  ).toBe(401);
});
it.each(['shared', 'photography'] as const)(
  'labels %s and omits Product write controls',
  (workspace) => {
    const html = renderToStaticMarkup(
      createElement(Products, { workspace, expiresAt: Date.now() + 600000 }),
    );
    expect(html).toContain(
      workspace === 'shared'
        ? 'Products — Shared DEV'
        : 'Choose an isolated Product',
    );
    expect(html).not.toContain('Add Cookie');
    expect(html).not.toContain('View / Edit');
  },
);

const writeConfig = { ...cfg, ADMIN_SHARED_PRODUCT_WRITES_ENABLED: 'true' };
const creationKey = '11111111-1111-4111-8111-111111111111';
async function writableSession() {
  const transport = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname.startsWith('cognito-idp.'))
      return json({
        AuthenticationResult: {
          AccessToken: 'fixture.access.token',
          ExpiresIn: 900,
        },
      });
    if (url.pathname === '/admin/me')
      return json({
        authenticated: true,
        subject: 'shared-admin',
        username: 'fixture',
      });
    const fields = init?.body ? JSON.parse(String(init.body)) : {};
    return json(
      { product: { ...product(sharedId), ...fields } },
      init?.method === 'POST' ? 201 : 200,
    );
  });
  const login = await adminRelay(
    new Request(cfg.ADMIN_ORIGIN + '/api/admin/login', {
      method: 'POST',
      headers: { origin: cfg.ADMIN_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'fixture', password: 'synthetic' }),
    }),
    'login',
    writeConfig,
    transport,
  );
  const cookie = login.headers
    .getSetCookie()
    .find((x) => x.startsWith('__Host-bb-admin='))!
    .split(';')[0];
  transport.mockClear();
  const request = (
    method: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    new Request(cfg.ADMIN_ORIGIN + '/api/admin/products', {
      method,
      headers: {
        cookie,
        origin: cfg.ADMIN_ORIGIN,
        'content-type': 'application/json',
        'Idempotency-Key': creationKey,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const fields = fieldsOf(product(sharedId));
  return { transport, request, fields, cookie };
}
it('relays enabled shared creates and edits to the shared API with the original key and revision', async () => {
  const { transport, request, fields } = await writableSession();
  const create = await catalogRelay(
    request('POST', fields),
    undefined,
    writeConfig,
    transport,
  );
  expect(create.status).toBe(201);
  expect((await create.json()).product.productId).toBe(sharedId);
  const edit = await catalogRelay(
    request('PUT', { ...fields, description: 'Changed', revision: stamp }),
    sharedId,
    writeConfig,
    transport,
  );
  expect(edit.status).toBe(200);
  const writes = transport.mock.calls.filter(
    ([, init]) => init?.method !== 'GET',
  );
  expect(writes).toHaveLength(2);
  expect(String(writes[0][0])).toBe(
    profile.ADMIN_API_BASE_URL + '/admin/products',
  );
  expect(String(writes[1][0])).toBe(
    profile.ADMIN_API_BASE_URL + '/admin/products/' + sharedId,
  );
  expect(new Headers(writes[0][1]?.headers).get('idempotency-key')).toBe(
    creationKey,
  );
  expect(new Headers(writes[1][1]?.headers).get('if-match')).toBe(stamp);
  expect(JSON.parse(String(writes[1][1]?.body))).toEqual({
    ...fields,
    description: 'Changed',
  });
  for (const [, init] of writes) {
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer fixture.access.token',
    );
    expect(new Headers(init?.headers).has('cookie')).toBe(false);
    expect(init).toMatchObject({ cache: 'no-store', redirect: 'error' });
  }
});
it('requires the capability, same origin, an idempotency key and an explicit edit revision', async () => {
  const { transport, request, fields } = await writableSession();
  expect(
    (await catalogRelay(request('POST', fields), undefined, cfg, transport))
      .status,
  ).toBe(405);
  expect(
    (
      await catalogRelay(
        request('POST', fields),
        undefined,
        writeConfig,
        transport,
        true,
      )
    ).status,
  ).toBe(405);
  expect(
    (
      await catalogRelay(
        request('POST', fields, { origin: 'https://elsewhere.invalid' }),
        undefined,
        writeConfig,
        transport,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await catalogRelay(
        request('POST', fields, { 'sec-fetch-site': 'cross-site' }),
        undefined,
        writeConfig,
        transport,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await catalogRelay(
        request('POST', fields, { 'Idempotency-Key': '' }),
        undefined,
        writeConfig,
        transport,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await catalogRelay(
        request('PUT', fields),
        sharedId,
        writeConfig,
        transport,
      )
    ).status,
  ).toBe(400);
  expect(transport.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(
    true,
  );
});
it('keeps shared receipt lookup blocked and exposes actionable writer errors', async () => {
  const { transport, request, fields, cookie } = await writableSession();
  const receipt = new Request(
    cfg.ADMIN_ORIGIN + '/api/admin/products?creationKey=' + creationKey,
    { headers: { cookie } },
  );
  expect(
    (await catalogRelay(receipt, undefined, writeConfig, transport)).status,
  ).toBe(405);
  expect(transport).not.toHaveBeenCalled();
  const normal = transport.getMockImplementation()!;
  for (const [status, code] of [
    [409, 'STATUS_CHANGE_UNAVAILABLE'],
    [428, 'REVISION_REQUIRED'],
    [503, 'UNAVAILABLE'],
  ] as const) {
    transport.mockImplementation((url, init) =>
      init?.method === 'PUT'
        ? Promise.resolve(json({ code }, status))
        : normal(url, init),
    );
    const result = await catalogRelay(
      request('PUT', { ...fields, revision: stamp }),
      sharedId,
      writeConfig,
      transport,
    );
    expect(result.status).toBe(status);
    expect((await result.json()).code).toBe(code);
  }
});
it('shows enabled shared editing while photography stays read-only', async () => {
  const { ProductEditor } = await import('../../components/admin/products');
  const sharedHtml = renderToStaticMarkup(
    createElement(Products, {
      workspace: 'shared',
      sharedWritesEnabled: true,
      expiresAt: Date.now() + 600000,
    }),
  );
  expect(sharedHtml).toContain('Add Cookie');
  expect(sharedHtml).toContain('Products — Shared DEV');
  expect(sharedHtml).toContain('Photography');
  const photoHtml = renderToStaticMarkup(
    createElement(Products, {
      workspace: 'photography',
      sharedWritesEnabled: true,
      expiresAt: Date.now() + 600000,
    }),
  );
  expect(photoHtml).not.toContain('Add Cookie');
  const props = {
    shared: true,
    onSaved: () => {},
    onDirty: () => {},
    onClose: () => {},
  };
  const edit = renderToStaticMarkup(
    createElement(ProductEditor, { ...props, product: product(sharedId) }),
  );
  expect(edit).toMatch(/<select[^>]*id="product-active"[^>]*disabled/);
  expect(edit).not.toContain('Gallery changes');
  const create = renderToStaticMarkup(createElement(ProductEditor, props));
  expect(create).toContain('<option value="active" selected="">');
  expect(create).not.toMatch(/<select[^>]*id="product-active"[^>]*disabled/);
});
