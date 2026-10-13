import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SSMClient } from '@aws-sdk/client-ssm';
import {
  createSessionKeyLoader,
  KEY_CACHE_MS,
  SESSION_PARAMETER,
  SESSION_PARAMETER_ARN,
} from './session-key';
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@aws-sdk/client-ssm', async (original) => ({
  ...(await original<typeof import('@aws-sdk/client-ssm')>()),
  SSMClient: class {
    send = send;
  },
}));
const key = 'aB'.repeat(32); // Synthetic; never an operational key.
const config = {
  NODE_ENV: 'production',
  ADMIN_SESSION_KEY_PARAMETER: SESSION_PARAMETER,
  ADMIN_ORIGIN: 'https://shop.test',
  ADMIN_API_BASE_URL: 'https://api.test',
  ADMIN_COGNITO_REGION: 'us-east-2',
  ADMIN_COGNITO_CLIENT_ID: 'syntheticClient',
};
const response = () => ({
  Parameter: {
    Name: SESSION_PARAMETER,
    ARN: SESSION_PARAMETER_ARN,
    Type: 'SecureString',
    Value: key,
  },
});
const loader = (now?: () => number) =>
  createSessionKeyLoader(new SSMClient({}), now);
beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue(response());
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('reads the exact SecureString using decryption and validates uppercase hex', async () => {
  expect(await loader()(config)).toBe(key);
  expect(send.mock.calls[0][0].input).toEqual({
    Name: SESSION_PARAMETER,
    WithDecryption: true,
  });
  expect(send.mock.calls[0][1].abortSignal).toBeInstanceOf(AbortSignal);
});
it.each([undefined, '', '/other', SESSION_PARAMETER + ':1'])(
  'rejects missing or wrong parameter configuration %# without AWS or production fallback',
  async (name) => {
    await expect(
      loader()({
        ...config,
        ADMIN_SESSION_KEY_PARAMETER: name,
        ADMIN_SESSION_KEY: key,
      }),
    ).rejects.toThrow('configuration is unavailable');
    expect(send).not.toHaveBeenCalled();
  },
);
it.each([
  undefined,
  {},
  { ...response().Parameter, Name: '/other' },
  {
    ...response().Parameter,
    ARN: SESSION_PARAMETER_ARN.replace('302154194958', '111111111111'),
  },
  { ...response().Parameter, ARN: undefined },
  { ...response().Parameter, Type: 'String' },
  { ...response().Parameter, Type: 'StringList' },
  ...[
    undefined,
    '',
    'a'.repeat(63),
    'a'.repeat(65),
    'g'.repeat(64),
    key + '\n',
    ' ' + key,
  ].map((Value) => ({ ...response().Parameter, Value })),
])('rejects malformed identity, type or key %#', async (Parameter) => {
  send.mockResolvedValue({ Parameter });
  await expect(loader()(config)).rejects.toThrow(
    'configuration is unavailable',
  );
});
it.each([
  'ParameterNotFound',
  'AccessDeniedException',
  'ThrottlingException',
  'network',
  'AbortError',
])('sanitizes %s and retries on a later request', async (name) => {
  const load = loader();
  send.mockRejectedValueOnce(Object.assign(new Error(key), { name }));
  await expect(load(config)).rejects.toThrow(
    /^Administrator session configuration is unavailable\.$/,
  );
  expect(await load(config)).toBe(key);
  expect(send).toHaveBeenCalledTimes(2);
});
it('expires cached values, never serves stale on error, and loads a rotated key', async () => {
  let now = 0;
  const load = loader(() => now);
  await load(config);
  now = KEY_CACHE_MS - 1;
  expect(await load(config)).toBe(key);
  expect(send).toHaveBeenCalledTimes(1);
  now++;
  send.mockRejectedValueOnce(new Error('outage'));
  await expect(load(config)).rejects.toThrow();
  send.mockResolvedValue({
    Parameter: { ...response().Parameter, Value: '34'.repeat(32) },
  });
  expect(await load(config)).toBe('34'.repeat(32));
  expect(send).toHaveBeenCalledTimes(3);
});
it('coalesces concurrent initial requests', async () => {
  let finish!: (value: ReturnType<typeof response>) => void;
  send.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const load = loader();
  const requests = Array.from({ length: 12 }, () => load(config));
  expect(send).toHaveBeenCalledTimes(1);
  finish(response());
  expect(await Promise.all(requests)).toEqual(Array(12).fill(key));
});
it.each(['development', 'test'])(
  'permits explicit validated local key only in %s without SSM config',
  async (NODE_ENV) => {
    expect(await loader()({ NODE_ENV, ADMIN_SESSION_KEY: key })).toBe(key);
    expect(send).not.toHaveBeenCalled();
    await expect(
      loader()({ NODE_ENV, ADMIN_SESSION_KEY: 'bad' }),
    ).rejects.toThrow();
  },
);
it('never falls back to local key when configured SSM fails', async () => {
  send.mockRejectedValue(new Error('outage'));
  await expect(
    loader()({ ...config, NODE_ENV: 'development', ADMIN_SESSION_KEY: key }),
  ).rejects.toThrow();
});
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
const request = (action: string, cookie = '') =>
  new Request(`https://shop.test/api/admin/${action}`, {
    method: action === 'dashboard' ? 'GET' : 'POST',
    headers: {
      origin: config.ADMIN_ORIGIN,
      cookie,
      'content-type': 'application/json',
    },
    ...(action === 'dashboard'
      ? {}
      : {
          body: JSON.stringify({
            username: 'synthetic',
            password: 'synthetic',
            answer: '123456',
          }),
        }),
  });
const cookieFrom = (r: Response, challenge = false) =>
  r.headers
    .getSetCookie()
    .find((s) =>
      s.startsWith(`__Host-bb-admin${challenge ? '-challenge' : ''}=`),
    )!
    .split(';')[0];
it('runtime preserves encrypted login, protected read-only dashboard, expiry and empty-body logout', async () => {
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.includes('cognito-idp')) {
      if (
        new Headers(options?.headers)
          .get('x-amz-target')
          ?.endsWith('GlobalSignOut')
      )
        return new Response(null, { status: 200 });
      return json({
        AuthenticationResult: {
          AccessToken: 'synthetic.access.signature',
          ExpiresIn: 900,
        },
      });
    }
    expect(options?.method).toBe('GET');
    if (url.endsWith('/admin/me'))
      return json({
        authenticated: true,
        subject: 'synthetic',
        username: 'synthetic',
      });
    if (url.endsWith('/assignment')) return json({ dropId: null });
    throw new Error('Unexpected business operation');
  });
  vi.stubGlobal('fetch', fetcher);
  const { adminRelay, authorize } = await import('./runtime');
  const before = Date.now();
  const login = await adminRelay(request('login'), 'login', config);
  expect(await login.clone().json()).toEqual({ authenticated: true });
  const cookie = cookieFrom(login);
  expect(login.headers.get('set-cookie')).toMatch(/HttpOnly/);
  expect(login.headers.get('set-cookie')).toMatch(/Secure/);
  expect(cookie).not.toContain(key);
  const session = await authorize(cookie, config);
  expect(session.expiresAt - before).toBeGreaterThanOrEqual(900000);
  expect(session.expiresAt - Date.now()).toBeLessThanOrEqual(900000);
  const dashboard = await adminRelay(
    request('dashboard', cookie),
    'dashboard',
    config,
  );
  expect((await dashboard.clone().json()).overview).toBeNull();
  const logout = await adminRelay(request('logout', cookie), 'logout', config);
  expect(await logout.clone().json()).toEqual({
    signedOut: true,
    revocationConfirmed: true,
  });
  for (const r of [login, dashboard, logout])
    expect(await r.text()).not.toMatch(
      new RegExp(`${key}|synthetic.access.signature`),
    );
  expect(send).toHaveBeenCalledTimes(1);
});
it.each(['SMS_MFA', 'SOFTWARE_TOKEN_MFA', 'NEW_PASSWORD_REQUIRED'])(
  'runtime preserves %s challenges',
  async (challenge) => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json({ ChallengeName: challenge, Session: 'synthetic' }),
      )
      .mockResolvedValueOnce(
        json({
          AuthenticationResult: {
            AccessToken: 'synthetic.access.signature',
            ExpiresIn: 900,
          },
        }),
      )
      .mockResolvedValueOnce(
        json({
          authenticated: true,
          subject: 'synthetic',
          username: 'synthetic',
        }),
      );
    vi.stubGlobal('fetch', fetcher);
    const { adminRelay } = await import('./runtime');
    const login = await adminRelay(request('login'), 'login', config);
    expect(await login.clone().json()).toEqual({ challenge });
    const result = await adminRelay(
      request('challenge', cookieFrom(login, true)),
      'challenge',
      config,
    );
    expect(await result.json()).toEqual({ authenticated: true });
  },
);
it('runtime sanitizes provider failures without logs, API secret leakage or SSR error leakage', async () => {
  const logs = [
    vi.spyOn(console, 'log'),
    vi.spyOn(console, 'error'),
    vi.spyOn(console, 'warn'),
  ];
  send.mockRejectedValue(new Error(key));
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const { adminRelay, authorize } = await import('./runtime');
  const result = await adminRelay(request('login'), 'login', config);
  expect(result.status).toBe(503);
  expect(result.headers.get('cache-control')).toBe('no-store, private');
  expect(await result.text()).not.toContain(key);
  await expect(authorize('', config)).rejects.toMatchObject({
    code: 'CONFIGURATION',
    status: 503,
  });
  for (const log of logs) expect(log).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});
it('all admin entry points use server-only runtime and never serialize its configuration into HTML', () => {
  for (const file of ['runtime.ts', 'session-key.ts', 'server.ts'])
    expect(readFileSync(resolve('src/lib/admin', file), 'utf8')).toContain(
      "import 'server-only'",
    );
  for (const action of ['login', 'challenge', 'dashboard', 'logout'])
    expect(
      readFileSync(resolve(`src/app/api/admin/${action}/route.ts`), 'utf8'),
    ).toContain('lib/admin/runtime');
  const page = readFileSync(resolve('src/app/admin/page.tsx'), 'utf8');
  expect(page).toContain('lib/admin/runtime');
  expect(page).toContain('<Dashboard expiresAt={expiresAt} />');
  expect(page).not.toMatch(/ADMIN_SESSION_KEY|\.\.\.config/);
});

it('SSM outage logout clears both correctly scoped cookies without leaking errors', async () => {
  send.mockRejectedValue(new Error(key));
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const logs = [
    vi.spyOn(console, 'log'),
    vi.spyOn(console, 'error'),
    vi.spyOn(console, 'warn'),
  ];
  const { adminRelay } = await import('./runtime');
  const r = await adminRelay(
    request(
      'logout',
      '__Host-bb-admin=synthetic; __Host-bb-admin-challenge=synthetic',
    ),
    'logout',
    config,
  );
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({
    signedOut: true,
    revocationConfirmed: false,
  });
  const cookies = r.headers.getSetCookie();
  expect(cookies).toHaveLength(2);
  for (const name of ['__Host-bb-admin', '__Host-bb-admin-challenge']) {
    const cookie = cookies.find((value) => value.startsWith(name + '='))!;
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=strict');
    expect(cookie).not.toMatch(/Domain=|synthetic/);
  }
  expect(r.headers.get('cache-control')).toBe('no-store, private');
  expect(fetcher).not.toHaveBeenCalled();
  for (const log of logs) expect(log).not.toHaveBeenCalled();
});
it('cache-expiry SSM failure still permits local logout and leaves other operations closed', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000000);
  const { loadSessionKey } = await import('./session-key');
  await loadSessionKey(config);
  clock.mockReturnValue(1000000 + KEY_CACHE_MS);
  send.mockRejectedValue(new Error('private SSM failure'));
  vi.stubGlobal('fetch', vi.fn());
  const { adminRelay, authorize } = await import('./runtime');
  const r = await adminRelay(request('logout'), 'logout', config);
  expect(r.status).toBe(200);
  expect(r.headers.getSetCookie()).toHaveLength(2);
  expect(await r.json()).toEqual({
    signedOut: true,
    revocationConfirmed: false,
  });
  for (const action of ['login', 'challenge', 'dashboard'] as const) {
    const failed = await adminRelay(request(action), action, config);
    expect(failed.status).toBe(503);
    expect(failed.headers.getSetCookie()).toHaveLength(0);
  }
  await expect(authorize('', config)).rejects.toMatchObject({
    code: 'CONFIGURATION',
  });
});
it.each([
  ['GET', 'https://shop.test', 'same-origin', 405],
  ['PUT', 'https://shop.test', 'same-origin', 405],
  ['POST', 'https://evil.test', 'cross-site', 403],
  ['POST', '', 'same-origin', 403],
  ['POST', 'https://shop.test', 'cross-site', 403],
])(
  'rejects invalid logout before SSM or cookie changes %#',
  async (method, origin, site, status) => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const { adminRelay } = await import('./runtime');
    const r = await adminRelay(
      new Request('https://shop.test/api/admin/logout', {
        method: String(method),
        headers: { origin: String(origin), 'sec-fetch-site': String(site) },
      }),
      'logout',
      config,
    );
    expect(r.status).toBe(status);
    expect(r.headers.getSetCookie()).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  },
);
it('Cognito failure through runtime still completes local logout', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      json({
        AuthenticationResult: {
          AccessToken: 'synthetic.access.signature',
          ExpiresIn: 900,
        },
      }),
    )
    .mockResolvedValueOnce(
      json({
        authenticated: true,
        subject: 'synthetic',
        username: 'synthetic',
      }),
    )
    .mockRejectedValueOnce(new Error('private Cognito failure'));
  vi.stubGlobal('fetch', fetcher);
  const { adminRelay } = await import('./runtime');
  const login = await adminRelay(request('login'), 'login', config);
  const r = await adminRelay(
    request('logout', cookieFrom(login)),
    'logout',
    config,
  );
  expect(await r.json()).toEqual({
    signedOut: true,
    revocationConfirmed: false,
  });
  expect(r.headers.getSetCookie()).toHaveLength(2);
});
it('existing UI distinguishes completed local logout from provider revocation', () => {
  const dashboard = readFileSync(
    resolve('src/components/admin/dashboard.tsx'),
    'utf8',
  );
  const login = readFileSync(resolve('src/components/admin/login.tsx'), 'utf8');
  expect(dashboard).toContain(
    "result.revocationConfirmed ? 'signed-out' : 'local-sign-out'",
  );
  expect(login).toContain(
    'You have signed out of this browser. Provider-wide sign-out could not be confirmed; other sessions may remain active.',
  );
});
