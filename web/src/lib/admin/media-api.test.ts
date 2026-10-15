import { it, expect, vi } from 'vitest';
import { adminRelay, mediaRelay, type AdminConfig } from './server';
import { mediaInput, mediaPath, type MediaTarget } from './media-contract';
vi.mock('server-only', () => ({}));
const productId = '01K00000000000000000000001';
const target: MediaTarget = { productId, kind: 'manifest' };
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
async function setup(
  response: () => Response = () =>
    json({ manifest: { version: 1, productId, revision: 0, images: [] } }),
) {
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
    return response();
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
const req = (
  cookie: string,
  method = 'GET',
  body?: unknown,
  origin = 'https://shop.test',
) =>
  new Request('https://shop.test/api/admin/products/' + productId + '/media', {
    method,
    headers: {
      cookie,
      origin,
      'content-type': 'application/json',
      'idempotency-key': '11111111-1111-4111-8111-111111111111',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
it('reads through sealed session with server-only token and no-store', async () => {
  const s = await setup();
  const r = await mediaRelay(req(s.cookie), target, config, s.fetcher);
  expect(r.status).toBe(200);
  expect(r.headers.get('cache-control')).toContain('no-store');
  expect(await r.text()).not.toContain('synthetic.access.signature');
  const call = s.calls.at(-1)!;
  expect(call.url).toBe(
    'https://api.test/admin/products/' + productId + '/media',
  );
  expect(call.init?.cache).toBe('no-store');
  expect((call.init?.headers as Record<string, string>).Authorization).toBe(
    'Bearer synthetic.access.signature',
  );
  expect(call.init?.redirect).toBe('error');
});
it('missing session never reaches media backend', async () => {
  const s = await setup();
  const r = await mediaRelay(req(''), target, config, s.fetcher);
  expect(r.status).toBe(401);
  expect(s.calls).toHaveLength(0);
});
it('cross-origin and cross-site writes are rejected before forwarding', async () => {
  const s = await setup();
  let r = await mediaRelay(
    req(
      s.cookie,
      'PUT',
      { expectedRevision: 0, images: [] },
      'https://evil.test',
    ),
    target,
    config,
    s.fetcher,
  );
  expect(r.status).toBe(403);
  const q = req(s.cookie, 'PUT', { expectedRevision: 0, images: [] });
  q.headers.set('sec-fetch-site', 'cross-site');
  r = await mediaRelay(q, target, config, s.fetcher);
  expect(r.status).toBe(403);
  expect(s.calls).toHaveLength(0);
});
it('same-origin manifest writes preserve revisions and ordering', async () => {
  const s = await setup();
  const images = [{ mediaId: productId, alt: 'Cookie' }];
  await mediaRelay(
    req(s.cookie, 'PUT', { expectedRevision: 2, images }),
    target,
    config,
    s.fetcher,
  );
  expect(JSON.parse(String(s.calls.at(-1)!.init!.body))).toEqual({
    expectedRevision: 2,
    images,
  });
});
it('unknown processor claims are rejected without media fetch', async () => {
  const s = await setup();
  const t: MediaTarget = {
    productId,
    kind: 'complete',
    itemId: 'a'.repeat(64),
  };
  const r = await mediaRelay(
    req(s.cookie, 'POST', { result: { state: 'READY' } }),
    t,
    config,
    s.fetcher,
  );
  expect(r.status).toBe(400);
  expect(s.calls.every((x) => x.url.endsWith('/admin/me'))).toBe(true);
});
it('payloads are bounded and binary content is rejected', async () => {
  const s = await setup();
  let r = await mediaRelay(
    req(s.cookie, 'PUT', { extra: 'x'.repeat(17000) }),
    target,
    config,
    s.fetcher,
  );
  expect(r.status).toBe(413);
  const q = req(s.cookie, 'PUT', {});
  q.headers.set('content-type', 'image/png');
  r = await mediaRelay(q, target, config, s.fetcher);
  expect(r.status).toBe(400);
});
it('sanitized unavailable and conflict codes survive relay without raw details', async () => {
  for (const [code, status] of [
    ['MEDIA_UPLOAD_UNAVAILABLE', 503],
    ['MEDIA_PROCESSOR_UNAVAILABLE', 503],
    ['MEDIA_REVISION_CONFLICT', 409],
    ['UPLOAD_RESULT_EXPIRED', 410],
    ['PRODUCT_WRITES_NOT_READY', 503],
  ] as const) {
    const s = await setup(() =>
      json({ code, message: 'private AWS details' }, status),
    );
    const r = await mediaRelay(req(s.cookie), target, config, s.fetcher);
    expect(r.status).toBe(status);
    expect(await r.json()).toEqual({
      code,
      message:
        'Unable to complete the media request. Reload or contact the operator.',
    });
  }
});
it('malformed backend success cannot leak internal fields', async () => {
  const s = await setup(() =>
    json({
      manifest: {
        version: 1,
        productId,
        revision: 0,
        images: [],
        token: 'secret',
      },
    }),
  );
  const r = await mediaRelay(req(s.cookie), target, config, s.fetcher);
  expect(r.status).toBe(502);
  expect(await r.text()).not.toContain('secret');
});
it('cross-Product backend response is rejected', async () => {
  const s = await setup(() =>
    json({
      manifest: {
        version: 1,
        productId: '01K00000000000000000000002',
        revision: 1,
        images: [],
      },
    }),
  );
  expect(
    (await mediaRelay(req(s.cookie), target, config, s.fetcher)).status,
  ).toBe(502);
});
it('paths, queries and methods cannot become arbitrary proxy destinations', async () => {
  expect(() =>
    mediaPath({ ...target, productId: '../escape' }, 'GET'),
  ).toThrow();
  expect(() =>
    mediaPath({ productId, kind: 'status', itemId: '../escape' }, 'GET'),
  ).toThrow();
  const s = await setup();
  const q = new Request(
    'https://shop.test/api/admin/products/x/media?key=secret',
    { headers: { cookie: s.cookie } },
  );
  expect((await mediaRelay(q, target, config, s.fetcher)).status).toBe(400);
  expect(
    (await mediaRelay(req(s.cookie, 'DELETE'), target, config, s.fetcher))
      .status,
  ).toBe(400);
  expect(s.calls).toHaveLength(0);
});
it('input validation rejects duplicates, oversized galleries, blank alt and injected identity', () => {
  for (const images of [
    [{ mediaId: productId, alt: '' }],
    Array(7).fill({ mediaId: productId, alt: 'x' }),
    Array(2).fill({ mediaId: productId, alt: 'x' }),
  ])
    expect(() =>
      mediaInput({ expectedRevision: 0, images }, 'manifest'),
    ).toThrow();
  expect(() =>
    mediaInput(
      {
        contentType: 'image/png',
        bytes: 1,
        sha256: 'a'.repeat(64),
        subject: 'other',
      },
      'uploads',
    ),
  ).toThrow();
});
it('upload idempotency key forwards unchanged and unavailable response creates no success', async () => {
  const s = await setup(() => json({ code: 'MEDIA_UPLOAD_UNAVAILABLE' }, 503));
  const r = await mediaRelay(
    req(s.cookie, 'POST', {
      contentType: 'image/png',
      bytes: 1000,
      sha256: 'a'.repeat(64),
    }),
    { productId, kind: 'uploads' },
    config,
    s.fetcher,
  );
  expect(r.status).toBe(503);
  expect(
    (s.calls.at(-1)!.init!.headers as Record<string, string>)[
      'Idempotency-Key'
    ],
  ).toBe('11111111-1111-4111-8111-111111111111');
});

it('upload authorization is scoped, short-lived and rejects arbitrary fields or destination', async () => {
  const { mediaResponse } = await import('./media-contract');
  const uploadId = 'a'.repeat(64),
    expiresAt = Math.floor((Date.now() + 60000) / 1000) * 1000;
  const fields: Record<string, string> = {
    'Content-Type': 'image/png',
    'x-amz-checksum-algorithm': 'SHA256',
    'x-amz-checksum-sha256': Buffer.alloc(32).toString('base64'),
    'x-amz-server-side-encryption': 'AES256',
    success_action_status: '204',
    bucket: 'batch-and-batter-dev-product-media-302154194958-us-east-2',
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': 'LOCALONLY',
    'X-Amz-Date': '20261014T000000Z',
    'X-Amz-Security-Token': 'LOCALONLY',
    key: `staging/products/${productId}/${uploadId}/source`,
  };
  const conditions = [
    ...Object.entries(fields).map(([k, v]) => ({ [k]: v })),
    ['content-length-range', 1000, 1000],
  ];
  fields.Policy = Buffer.from(
    JSON.stringify({
      expiration: new Date(expiresAt).toISOString(),
      conditions,
    }),
  ).toString('base64');
  fields['X-Amz-Signature'] = 'synthetic-only';
  const authorization = {
    url: 'https://batch-and-batter-dev-product-media-302154194958-us-east-2.s3.us-east-2.amazonaws.com/',
    fields,
    expiresAt,
  };
  const upload = {
    productId,
    uploadId,
    mediaId: productId,
    state: 'PENDING',
    expiresAt: Date.now() + 900000,
  };
  expect(
    mediaResponse({ upload, authorization }, { productId, kind: 'uploads' }),
  ).toEqual({ upload, authorization });
  for (const bad of [
    { ...authorization, url: 'https://evil.test/' },
    { ...authorization, fields: { ...fields, key: 'other' } },
    { ...authorization, fields: { ...fields, secretAccessKey: 'forbidden' } },
    { ...authorization, expiresAt: 1 },
  ])
    expect(() =>
      mediaResponse(
        { upload, authorization: bad },
        { productId, kind: 'uploads' },
      ),
    ).toThrow();
});

it('READY query reuses encrypted session relay, validates cursor and remains no-store', async () => {
  const s = await setup(() => json({ assets: [], nextCursor: null }));
  const t: MediaTarget = { productId, kind: 'ready' };
  const request = new Request(
    'https://shop.test/api/admin/products/' + productId + '/media?view=ready',
    { headers: { cookie: s.cookie } },
  );
  const r = await mediaRelay(request, t, config, s.fetcher);
  expect(r.status).toBe(200);
  expect(r.headers.get('cache-control')).toContain('no-store');
  expect(s.calls.at(-1)?.url).toBe(
    'https://api.test/admin/products/' + productId + '/media?view=ready',
  );
  expect(JSON.stringify(await r.json())).not.toContain('synthetic.access');
  const bad = await mediaRelay(
    new Request(request.url + '&extra=x', { headers: { cookie: s.cookie } }),
    t,
    config,
    s.fetcher,
  );
  expect(bad.status).toBe(400);
  const noSession = await mediaRelay(
    new Request(request.url),
    t,
    config,
    s.fetcher,
  );
  expect(noSession.status).toBe(401);
});
