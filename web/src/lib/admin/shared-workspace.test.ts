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
import { summaryOf } from './products';
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
