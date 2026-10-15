import { it, expect, vi } from 'vitest';
import { adminRelay, dropRelay, type AdminConfig } from './server';
vi.mock('server-only', () => ({}));
const config: AdminConfig = {
  NODE_ENV: 'production',
  ADMIN_ORIGIN: 'https://shop.test',
  ADMIN_API_BASE_URL: 'https://api.test',
  ADMIN_COGNITO_REGION: 'us-east-2',
  ADMIN_COGNITO_CLIENT_ID: 'Synthetic',
  ADMIN_SESSION_KEY: '12'.repeat(32),
};
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const id = '01K00000000000000000000001';
it('fails closed before upstream access for missing sessions, cross-origin writes and non-allowlisted routes', async () => {
  const fetcher = vi.fn<typeof fetch>();
  for (const [method, segments, origin, expected] of [
    ['GET', [], 'https://shop.test', 401],
    ['PUT', [id, 'draft'], 'https://attacker.test', 403],
    ['DELETE', [id, 'draft'], 'https://shop.test', 405],
    ['POST', [id, '../publish'], 'https://shop.test', 405],
  ] as const) {
    const result = await dropRelay(
      new Request('https://shop.test/api/admin/drops', {
        method,
        headers: { origin },
      }),
      [...segments],
      config,
      fetcher,
    );
    expect(result.status).toBe(expected);
    expect(result.headers.get('cache-control')).toContain('no-store');
  }
  expect(fetcher).not.toHaveBeenCalled();
});
it('uses the encrypted session access token, checks admin authorization and forwards only fixed Drop paths without caching', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('cognito-idp'))
      return response({
        AuthenticationResult: {
          AccessToken: 'synthetic.access.signature',
          ExpiresIn: 900,
        },
      });
    if (String(url).endsWith('/admin/me'))
      return response({
        authenticated: true,
        subject: 'synthetic',
        username: 'synthetic',
      });
    return response({ drop: { dropId: id } });
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
  const result = await dropRelay(
    new Request('https://shop.test/api/admin/drops/' + id + '/draft', {
      method: 'PUT',
      headers: {
        cookie,
        origin: 'https://shop.test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ revision: 'synthetic' }),
    }),
    [id, 'draft'],
    config,
    fetcher,
  );
  expect(result.status).toBe(200);
  expect(calls.map((c) => c.url)).toEqual([
    'https://api.test/admin/me',
    'https://api.test/admin/drops/' + id + '/draft',
  ]);
  expect(calls[1].init?.cache).toBe('no-store');
  expect(calls[1].init?.redirect).toBe('error');
  expect(new Headers(calls[1].init?.headers).get('Authorization')).toBe(
    'Bearer synthetic.access.signature',
  );
  expect(await result.text()).not.toContain('synthetic.access.signature');
});
