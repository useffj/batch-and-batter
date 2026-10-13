import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { adminRelay, authorize, type AdminConfig } from './server';
import { adminRequest } from './client';
import { composition } from './contract';
import { DropOverview } from '../../components/admin/overview';
import { Login } from '../../components/admin/login';
import { Dashboard } from '../../components/admin/dashboard';
vi.mock('server-only', () => ({}));
const config: AdminConfig = {
  NODE_ENV: 'production',
  ADMIN_ORIGIN: 'https://shop.test',
  ADMIN_API_BASE_URL: 'https://api.test/dev',
  ADMIN_COGNITO_REGION: 'us-west-2',
  ADMIN_COGNITO_CLIENT_ID: 'syntheticClient',
  ADMIN_SESSION_KEY: '12'.repeat(32),
};
const dropId = '01K00000000000000000000000',
  productId = '01K00000000000000000000001';
const token = 'synthetic.access.signature';
const payload = () => ({
  drop: {
    dropId,
    name: 'Friday cookie collection',
    status: 'PAUSED',
    timezone: 'America/Denver',
    pickupLocation: 'Batch & Batter pickup counter',
    pickupInstructions: 'Bring your order confirmation.',
  },
  products: [
    {
      product: {
        productId,
        name: 'Brown butter chocolate chip',
        active: false,
      },
      dropProduct: { dropId, productId, active: false },
    },
  ],
  inventory: [
    { dropId, productId, total: 100, reserved: 8, sold: 62, available: 30 },
  ],
  pickupDates: [
    {
      dropId,
      date: '2026-10-16',
      startTime: '16:00',
      endTime: '19:00',
      timezone: 'America/Denver',
      active: true,
    },
  ],
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const mock = () =>
  vi.fn<typeof fetch>(async (url, options) => {
    if (String(url).includes('cognito-idp')) {
      if (
        new Headers(options?.headers)
          .get('x-amz-target')
          ?.endsWith('GlobalSignOut')
      )
        return new Response(null, { status: 200 });
      return json({
        AuthenticationResult: {
          AccessToken: token,
          ExpiresIn: 900,
          IdToken: 'unused-id-token',
          RefreshToken: 'unused-refresh-token',
        },
      });
    }
    if (String(url).endsWith('/admin/me'))
      return json({
        authenticated: true,
        subject: 'synthetic-sub',
        username: 'synthetic-admin',
      });
    if (String(url).endsWith('/assignment')) return json({ dropId });
    return json(payload());
  });
function request(
  action: string,
  body?: unknown,
  cookie = '',
  origin = 'https://shop.test',
) {
  return new Request(`https://shop.test/api/admin/${action}`, {
    method: action === 'dashboard' ? 'GET' : 'POST',
    headers: {
      origin,
      cookie,
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const cookie = (response: Response, challenge = false) =>
  response.headers
    .getSetCookie()
    .find((s) =>
      s.startsWith(`__Host-bb-admin${challenge ? '-challenge' : ''}=`),
    )!
    .split(';')[0];
async function login(fetcher = mock()) {
  return adminRelay(
    request('login', { username: 'admin', password: 'synthetic-password' }),
    'login',
    config,
    fetcher,
  );
}
afterEach(() => vi.useRealTimers());

describe('server-managed administrator sessions', () => {
  it('keeps tokens encrypted and validates backend identity before admitting login', async () => {
    const fetcher = mock(),
      response = await login(fetcher);
    expect(await response.json()).toEqual({ authenticated: true });
    const header = response.headers.getSetCookie()[0];
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=strict');
    expect(header).toContain('Path=/');
    expect(header).not.toContain(token);
    expect(header).not.toContain('unused');
    expect(response.headers.get('cache-control')).toBe('no-store, private');
    const session = await authorize(cookie(response), config, fetcher);
    expect(session.token).toBe(token);
    expect(fetcher.mock.calls[1][0]).toBe('https://api.test/dev/admin/me');
  });
  it('missing, tampered, duplicate and wrong-key cookies fail before network access', async () => {
    const valid = cookie(await login());
    for (const value of [
      '',
      valid.slice(0, -4) + 'AAAA',
      valid + '; ' + valid,
    ]) {
      const fetcher = mock(),
        response = await adminRelay(
          request('dashboard', undefined, value),
          'dashboard',
          config,
          fetcher,
        );
      expect(response.status).toBe(401);
      expect(fetcher).not.toHaveBeenCalled();
    }
    expect(
      (
        await adminRelay(
          request('dashboard', undefined, valid),
          'dashboard',
          { ...config, ADMIN_SESSION_KEY: '34'.repeat(32) },
          mock(),
        )
      ).status,
    ).toBe(401);
  });
  it('expired encrypted sessions fail locally and clear cookies', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
    const valid = cookie(await login());
    vi.advanceTimersByTime(900001);
    const fetcher = mock(),
      response = await adminRelay(
        request('dashboard', undefined, valid),
        'dashboard',
        config,
        fetcher,
      );
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe('EXPIRED');
    expect(fetcher).not.toHaveBeenCalled();
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });
  it.each([401, 403])(
    'backend identity rejection %s prevents discovery and clears session',
    async (status) => {
      const valid = cookie(await login()),
        fetcher = vi.fn<typeof fetch>(async () =>
          json({ message: 'sensitive' }, status),
        );
      const response = await adminRelay(
        request('dashboard', undefined, valid),
        'dashboard',
        config,
        fetcher,
      );
      expect(response.status).toBe(status);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(await response.text()).not.toContain('sensitive');
      expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    },
  );
  it('non-admin cannot obtain an authenticated session after Cognito sign-in', async () => {
    const fetcher = mock();
    fetcher
      .mockImplementationOnce(async () =>
        json({ AuthenticationResult: { AccessToken: token, ExpiresIn: 900 } }),
      )
      .mockImplementationOnce(async () => json({}, 403));
    const response = await login(fetcher);
    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });
  it.each(['login', 'challenge', 'logout'] as const)(
    'rejects cross-origin %s before calls',
    async (action) => {
      const fetcher = mock();
      const response = await adminRelay(
        request(action, {}, '', 'https://evil.test'),
        action,
        config,
        fetcher,
      );
      expect(response.status).toBe(403);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it('missing configuration fails closed without network calls', async () => {
    const fetcher = mock();
    const response = await adminRelay(
      request('login', {}),
      'login',
      {},
      fetcher,
    );
    expect(response.status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('sign-out clears both cookies and sends only access token to Cognito', async () => {
    const valid = cookie(await login()),
      fetcher = mock();
    const response = await adminRelay(
      request('logout', {}, valid),
      'logout',
      config,
      fetcher,
    );
    expect(await response.json()).toEqual({
      signedOut: true,
      revocationConfirmed: true,
    });
    expect(response.headers.getSetCookie()).toHaveLength(2);
    expect(
      response.headers.getSetCookie().every((s) => s.includes('Max-Age=0')),
    ).toBe(true);
    expect(fetcher.mock.calls[0][1]?.body).toBe(
      JSON.stringify({ AccessToken: token }),
    );
  });
  it('provider outage still signs out locally without claiming global revocation', async () => {
    const valid = cookie(await login()),
      fetcher = vi.fn<typeof fetch>(async () => {
        throw new TypeError('private-detail');
      });
    const response = await adminRelay(
      request('logout', {}, valid),
      'logout',
      config,
      fetcher,
    );
    expect(await response.json()).toEqual({
      signedOut: true,
      revocationConfirmed: false,
    });
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});

it('network timeout is sanitized as service unavailable', async () => {
  const valid = cookie(await login());
  const fetcher = vi.fn<typeof fetch>(async () => {
    throw new DOMException('sensitive timeout detail', 'TimeoutError');
  });
  const response = await adminRelay(
    request('dashboard', undefined, valid),
    'dashboard',
    config,
    fetcher,
  );
  expect(response.status).toBe(502);
  expect((await response.json()).code).toBe('UNAVAILABLE');
});
it('rejected cross-origin sign-in cannot overwrite session cookies', async () => {
  const response = await adminRelay(
    request('login', {}, '', 'https://other.test'),
    'login',
    config,
    mock(),
  );
  expect(response.status).toBe(403);
  expect(response.headers.get('set-cookie')).toBeNull();
});
it('expired challenge cannot contact Cognito', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
  const fetcher = mock();
  fetcher.mockImplementationOnce(async () =>
    json({ ChallengeName: 'SMS_MFA', Session: 'synthetic-challenge' }),
  );
  const pending = cookie(await login(fetcher), true);
  vi.advanceTimersByTime(180001);
  fetcher.mockClear();
  const response = await adminRelay(
    request('challenge', { answer: '123456' }, pending),
    'challenge',
    config,
    fetcher,
  );
  expect(response.status).toBe(401);
  expect(fetcher).not.toHaveBeenCalled();
});

describe('authentication security corrections', () => {
  it('server-rendered login uses a fixed POST target without requiring hydration', () => {
    const html = renderToStaticMarkup(createElement(Login));
    const form = html.match(/<form\b[^>]*>/)?.[0];
    expect(form).toContain('method="post"');
    expect(form).toContain('action="/api/admin/login"');
    expect(html).not.toMatch(/formmethod="get"|formaction=/i);
    // Explicit POST protects native Enter/submit when JS is absent; no
    // disabling is needed because the native fallback is safe and fails closed.
    expect(html).toContain('type="submit"');
    expect(html).not.toContain('type="submit" disabled');
  });
  it.each(['login', 'challenge'] as const)(
    'native %s POST is rejected without echoing credentials',
    async (action) => {
      const native = new Request(`https://shop.test/api/admin/${action}`, {
        method: 'POST',
        headers: {
          origin: 'https://shop.test',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          username: 'synthetic-admin',
          password: 'synthetic-password',
          answer: '654321',
        }),
      });
      const fetcher = mock();
      const response = await adminRelay(native, action, config, fetcher);
      expect(response.ok).toBe(false);
      expect(fetcher).not.toHaveBeenCalled();
      expect(native.url).not.toMatch(/synthetic|654321|\?/);
      expect(await response.text()).not.toMatch(/synthetic-password|654321/);
      expect(response.headers.get('location')).toBeNull();
    },
  );
  it.each(['login', 'challenge'] as const)(
    'hydrated %s sends secrets only in its POST body',
    async (action) => {
      const fetcher = vi.fn<typeof fetch>(async () =>
        json({ authenticated: true }),
      );
      const body =
        action === 'login'
          ? { username: 'synthetic-admin', password: 'synthetic-password' }
          : { answer: '654321' };
      await adminRequest(action, body, undefined, fetcher);
      expect(fetcher.mock.calls[0][0]).toBe(`/api/admin/${action}`);
      expect(fetcher.mock.calls[0][1]?.method).toBe('POST');
      expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string)).toEqual(
        body,
      );
      const source = readFileSync(
        resolve('src/components/admin/login.tsx'),
        'utf8',
      );
      expect(source).toContain(
        "action={challenge ? '/api/admin/challenge' : '/api/admin/login'}",
      );
      expect(source).toContain('onSubmit={submit}');
      expect(source).toContain('event.preventDefault()');
    },
  );
  it('accepts an empty streamed HTTP 200 GlobalSignOut response', async () => {
    const valid = cookie(await login());
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response('', { status: 200 }),
    );
    const response = await adminRelay(
      request('logout', {}, valid),
      'logout',
      config,
      fetcher,
    );
    expect(await response.json()).toEqual({
      signedOut: true,
      revocationConfirmed: true,
    });
    expect(
      response.headers
        .getSetCookie()
        .every((value) => value.includes('Max-Age=0')),
    ).toBe(true);
  });
  it.each([
    [400, null],
    [500, null],
    [202, null],
    [204, null],
    [200, '{'],
    [200, '{}'],
    [200, 'unexpected-provider-detail'],
  ] as const)(
    'does not confirm GlobalSignOut status %s body %s',
    async (status, body) => {
      const valid = cookie(await login());
      const fetcher = vi.fn<typeof fetch>(
        async () => new Response(body, { status }),
      );
      const response = await adminRelay(
        request('logout', {}, valid),
        'logout',
        config,
        fetcher,
      );
      expect(await response.json()).toEqual({
        signedOut: true,
        revocationConfirmed: false,
      });
      expect(response.headers.getSetCookie()).toHaveLength(2);
      expect(
        response.headers
          .getSetCookie()
          .every((value) => value.includes('Max-Age=0')),
      ).toBe(true);
    },
  );
  it('empty success is still invalid for InitiateAuth', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 200 }),
    );
    const response = await login(fetcher);
    expect(response.status).toBe(502);
    expect((await response.json()).code).toBe('INVALID');
  });
});

describe('Cognito challenges', () => {
  it.each(['NEW_PASSWORD_REQUIRED', 'SMS_MFA', 'SOFTWARE_TOKEN_MFA'])(
    'supports %s without exposing the session',
    async (challenge) => {
      const fetcher = mock();
      fetcher.mockImplementationOnce(async () =>
        json({
          ChallengeName: challenge,
          Session: 'opaque-cognito-session',
          ChallengeParameters: { requiredAttributes: '[]' },
        }),
      );
      const response = await login(fetcher);
      expect(await response.json()).toEqual({ challenge });
      expect(response.headers.get('set-cookie')).not.toContain(
        'opaque-cognito-session',
      );
      const pending = cookie(response, true);
      const done = await adminRelay(
        request(
          'challenge',
          {
            answer:
              challenge === 'NEW_PASSWORD_REQUIRED'
                ? 'New-password123!'
                : '123456',
          },
          pending,
        ),
        'challenge',
        config,
        fetcher,
      );
      expect(done.status).toBe(200);
      expect(await done.json()).toEqual({ authenticated: true });
      expect(JSON.parse(fetcher.mock.calls[1][1]?.body as string).Session).toBe(
        'opaque-cognito-session',
      );
    },
  );
  it.each(['MFA_SETUP', 'CUSTOM_CHALLENGE', 'SELECT_MFA_TYPE'])(
    'unsupported %s fails closed',
    async (challenge) => {
      const fetcher = mock();
      fetcher.mockImplementationOnce(async () =>
        json({ ChallengeName: challenge, Session: 'secret' }),
      );
      const response = await login(fetcher);
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe('CHALLENGE');
    },
  );
  it('required attributes outside the approved pool setup fail closed', async () => {
    const fetcher = mock();
    fetcher.mockImplementationOnce(async () =>
      json({
        ChallengeName: 'NEW_PASSWORD_REQUIRED',
        Session: 'secret',
        ChallengeParameters: { requiredAttributes: '["email"]' },
      }),
    );
    expect((await login(fetcher)).status).toBe(400);
  });
  it.each([
    ['NotAuthorizedException', 'CREDENTIALS'],
    ['CodeMismatchException', 'CODE'],
    ['InvalidPasswordException', 'PASSWORD'],
  ])('sanitizes %s', async (type, code) => {
    const fetcher = mock();
    fetcher.mockImplementationOnce(async () =>
      json({ __type: type, message: 'private-provider-detail' }, 400),
    );
    const response = await login(fetcher);
    expect((await response.json()).code).toBe(code);
  });
});

describe('protected dashboard data', () => {
  it('authorizes, discovers, then composes; no business mutations or token leakage', async () => {
    const valid = cookie(await login()),
      fetcher = mock();
    const response = await adminRelay(
        request('dashboard', undefined, valid),
        'dashboard',
        config,
        fetcher,
      ),
      body = await response.json();
    expect(body.overview.drop.dropId).toBe(dropId);
    expect(body.overview.inventory[0]).toMatchObject({
      total: 100,
      reserved: 8,
      sold: 62,
      available: 30,
    });
    expect(body.overview.products[0].active).toBe(false);
    expect(body.loadedAt).toBeTruthy();
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.test/dev/admin/me',
      'https://api.test/dev/admin/storefront/assignment',
      `https://api.test/dev/admin/drops/${dropId}/composition`,
    ]);
    for (const [url, options] of fetcher.mock.calls) {
      expect(options?.method).toBe('GET');
      expect(options?.cache).toBe('no-store');
      expect(String(url)).not.toContain(token);
    }
    expect(JSON.stringify(body)).not.toMatch(
      /synthetic.access|unused-id|unused-refresh|synthetic-sub/,
    );
  });
  it('unassigned is explicit and skips composition', async () => {
    const valid = cookie(await login()),
      fetcher = mock();
    fetcher
      .mockImplementationOnce(async () =>
        json({ authenticated: true, subject: 's', username: 'u' }),
      )
      .mockImplementationOnce(async () => json({ dropId: null }));
    const response = await adminRelay(
      request('dashboard', undefined, valid),
      'dashboard',
      config,
      fetcher,
    );
    expect((await response.json()).overview).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([
    [409, 'BROKEN_STOREFRONT_ASSIGNMENT', 'BROKEN_ASSIGNMENT'],
    [500, 'INTERNAL_ERROR', 'UNAVAILABLE'],
  ])(
    'assignment %s never turns into empty inventory',
    async (status, code, expected) => {
      const valid = cookie(await login()),
        fetcher = mock();
      fetcher
        .mockImplementationOnce(async () =>
          json({ authenticated: true, subject: 's', username: 'u' }),
        )
        .mockImplementationOnce(async () => json({ code }, status as number));
      const response = await adminRelay(
        request('dashboard', undefined, valid),
        'dashboard',
        config,
        fetcher,
      );
      const body = await response.json();
      expect(body.code).toBe(expected);
      expect(body).not.toHaveProperty('overview');
    },
  );
  it('rejects inconsistent inventory, duplicate rows, foreign Drop IDs and invalid pickup dates', () => {
    const invalid = payload();
    invalid.inventory[0].available = 999;
    expect(() => composition(invalid, dropId)).toThrow();
    const duplicate = payload();
    duplicate.inventory.push(duplicate.inventory[0]);
    expect(() => composition(duplicate, dropId)).toThrow();
    const foreign = payload();
    foreign.products[0].dropProduct.dropId = productId;
    expect(() => composition(foreign, dropId)).toThrow();
    const badDate = payload();
    badDate.pickupDates[0].date = '2026-02-30';
    expect(() => composition(badDate, dropId)).toThrow();
  });
  it('refresh makes a fresh credentialed no-store GET each time', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json({ overview: null }));
    await adminRequest('dashboard', undefined, undefined, fetcher);
    await adminRequest('dashboard', undefined, undefined, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][1]).toMatchObject({
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
    });
  });
});

describe('accessible overview presentation', () => {
  it('renders correct quantities, inactive status, dates and timezone', () => {
    const html = renderToStaticMarkup(
      createElement(DropOverview, { overview: composition(payload(), dropId) }),
    );
    for (const value of [
      'Friday cookie collection',
      'Inactive',
      'Total',
      '100',
      'Reserved',
      '8',
      'Sold',
      '62',
      'Available',
      '30',
      'Friday, October 16, 2026',
      '4:00 PM',
      '7:00 PM',
      'America/Denver',
      'Batch &amp; Batter pickup counter',
    ])
      expect(html).toContain(value);
    expect(html).not.toContain(token);
  });
  it('renders empty products, missing references, missing inventory and orphan inventory explicitly', () => {
    const view = composition(payload(), dropId);
    view.products[0].name = null;
    view.products[0].active = null;
    view.inventory[0].productId = '01K00000000000000000000002';
    const html = renderToStaticMarkup(
      createElement(DropOverview, { overview: view }),
    );
    for (const value of [
      'Missing product reference',
      'Inventory record missing',
      'Unmatched inventory',
    ])
      expect(html).toContain(value);
    view.products = [];
    expect(
      renderToStaticMarkup(createElement(DropOverview, { overview: view })),
    ).toContain('No products are assigned');
    expect(
      renderToStaticMarkup(createElement(DropOverview, { overview: null })),
    ).toContain('No Drop assigned');
  });
  it('uses labeled controls, native buttons, skip navigation and focus styles', () => {
    const loginHtml = renderToStaticMarkup(createElement(Login)),
      dashboardHtml = renderToStaticMarkup(
        createElement(Dashboard, { expiresAt: Date.now() + 900000 }),
      );
    expect(loginHtml).toContain('for="username"');
    expect(loginHtml).toContain('for="password"');
    expect(loginHtml.toLowerCase()).toContain(
      'autocomplete="current-password"',
    );
    expect(loginHtml).toContain('type="submit"');
    expect(dashboardHtml).toContain('Skip to overview');
    expect(dashboardHtml).toContain('aria-current="page"');
    expect(dashboardHtml).toContain('Loading administrative information');
    const css = readFileSync(resolve('src/app/admin/admin.css'), 'utf8');
    expect(css).toContain(':focus-visible');
    expect(css).toContain('minmax(0, 1fr)');
  });
  it('keeps tokens and persistent browser storage out of client modules', () => {
    for (const path of [
      'src/lib/admin/client.ts',
      'src/components/admin/dashboard.tsx',
      'src/components/admin/login.tsx',
    ]) {
      expect(readFileSync(resolve(path), 'utf8')).not.toMatch(
        /localStorage|sessionStorage|console\.|AccessToken|RefreshToken|ADMIN_SESSION_KEY/,
      );
    }
  });
});

// Optional static fixture artifact: never a Next route or an authentication bypass.
if (process.env.BB_ADMIN_PREVIEW === '1') {
  it('writes a clearly labeled isolated local preview', () => {
    const directory = resolve('.next/admin-preview');
    mkdirSync(directory, { recursive: true });
    const css = readFileSync(resolve('src/app/admin/admin.css'), 'utf8');
    const content = renderToStaticMarkup(
      createElement(DropOverview, { overview: composition(payload(), dropId) }),
    );
    writeFileSync(
      resolve(directory, 'index.html'),
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LOCAL SYNTHETIC PREVIEW — Batch & Batter</title><style>*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif;line-height:1.6;overflow-wrap:anywhere}main{max-width:70rem;margin:auto;padding:1rem}${css}</style><body><main class="admin-main"><p role="status"><strong>LOCAL SYNTHETIC PREVIEW · Fixture data only · No authentication or live services</strong></p><h1>Overview</h1>${content}</main></body></html>`,
    );
  });
}
