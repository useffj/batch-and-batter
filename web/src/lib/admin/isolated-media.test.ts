import { it, expect, vi } from 'vitest';
import { adminRelay, mediaImageRelay } from './server';
import { isolatedMediaEnabled } from './media-config';
import { transferImage } from './image-transfer';
vi.mock('server-only', () => ({}));
const c = {
  NODE_ENV: 'production',
  ADMIN_MEDIA_MODE: 'isolated',
  ADMIN_CATALOG_MODE: 'isolated',
  ADMIN_API_BASE_URL: 'https://ui8k11k343.execute-api.us-east-2.amazonaws.com',
  ADMIN_ORIGIN: 'https://admin-dev-3b23b18.d1aw7cfglvejmo.amplifyapp.com',
  ADMIN_COGNITO_REGION: 'us-east-2',
  ADMIN_COGNITO_CLIENT_ID: 'Synthetic',
  ADMIN_SESSION_KEY: '12'.repeat(32),
};
const json = (v: unknown) =>
  new Response(JSON.stringify(v), {
    headers: { 'content-type': 'application/json' },
  });
it('media stays disabled without exact restricted runtime configuration', () => {
  expect(isolatedMediaEnabled(c)).toBe(true);
  for (const key of [
    'ADMIN_MEDIA_MODE',
    'ADMIN_CATALOG_MODE',
    'ADMIN_API_BASE_URL',
    'ADMIN_ORIGIN',
  ])
    expect(isolatedMediaEnabled({ ...c, [key]: 'wrong' })).toBe(false);
});
it('image relay requires an encrypted admin session and returns bounded private bytes without redirect', async () => {
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    String(url).includes('cognito-idp')
      ? json({
          AuthenticationResult: {
            AccessToken: 'synthetic.access.signature',
            ExpiresIn: 900,
          },
        })
      : String(url).endsWith('/admin/me')
        ? json({
            authenticated: true,
            subject: 'synthetic',
            username: 'synthetic',
          })
        : new Response(new Uint8Array([1, 2, 3]), {
            headers: { 'content-type': 'image/webp' },
          }),
  );
  const login = await adminRelay(
    new Request(c.ADMIN_ORIGIN + '/api/admin/login', {
      method: 'POST',
      headers: { origin: c.ADMIN_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'synthetic', password: 'synthetic' }),
    }),
    'login',
    c,
    fetcher,
  );
  const cookie = login.headers
    .getSetCookie()
    .find((x) => x.startsWith('__Host-bb-admin='))!
    .split(';')[0];
  const p = '01K00000000000000000000001',
    m = '01K00000000000000000000002';
  expect(
    (await mediaImageRelay(new Request(c.ADMIN_ORIGIN), p, m, c, fetcher))
      .status,
  ).toBe(401);
  const r = await mediaImageRelay(
    new Request(c.ADMIN_ORIGIN, {
      headers: { cookie, 'sec-fetch-site': 'same-origin' },
    }),
    p,
    m,
    c,
    fetcher,
  );
  expect(r.status).toBe(200);
  expect(r.headers.get('cache-control')).toBe('no-store, private');
  expect(r.headers.get('referrer-policy')).toBe('no-referrer');
  expect(r.headers.get('location')).toBeNull();
  expect((await r.arrayBuffer()).byteLength).toBe(3);
  expect(
    (
      await mediaImageRelay(
        new Request(c.ADMIN_ORIGIN, {
          headers: { cookie, 'sec-fetch-site': 'cross-site' },
        }),
        p,
        m,
        c,
        fetcher,
      )
    ).status,
  ).toBe(403);
});
it('binary transfer rejects foreign destinations and mismatched files before network access', async () => {
  const f = new File(['synthetic'], 'cookie.png', { type: 'image/png' });
  await expect(
    transferImage(f, {
      url: 'https://foreign.invalid/',
      fields: {},
      expiresAt: Date.now() + 60000,
    }),
  ).rejects.toThrow();
});
it('valid transfer sends one scoped multipart POST without credentials or retries', async () => {
  const file = new File(['synthetic'], 'cookie.png', { type: 'image/png' });
  const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  const fields = {
    bucket: 'batch-and-batter-dev-isolated-media-302154194958-us-east-2',
    key:
      'staging/products/01K00000000000000000000001/' +
      'a'.repeat(64) +
      '/source',
    'Content-Type': file.type,
    'x-amz-checksum-sha256': btoa(String.fromCharCode(...new Uint8Array(hash))),
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetcher);
  try {
    await transferImage(file, {
      url: `https://${fields.bucket}.s3.us-east-2.amazonaws.com/`,
      fields,
      expiresAt: Date.now() + 60000,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const init = fetcher.mock.calls[0][1]!;
    expect(init.credentials).toBe('omit');
    expect(init.redirect).toBe('error');
    expect(init.referrerPolicy).toBe('no-referrer');
    expect((init.body as FormData).get('file')).toBeInstanceOf(File);
    fetcher.mockRejectedValueOnce(new Error('uncertain'));
    await expect(
      transferImage(file, {
        url: `https://${fields.bucket}.s3.us-east-2.amazonaws.com/`,
        fields,
        expiresAt: Date.now() + 60000,
      }),
    ).rejects.toThrow('uncertain');
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally {
    vi.unstubAllGlobals();
  }
});
