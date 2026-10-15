import { it, expect, vi } from 'vitest';
import { customersRelay } from './server';
import { Customers } from '../../components/admin/customers';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
vi.mock('server-only', () => ({}));
it('customer search fails closed on missing session, cross-origin, URL query and unsupported method', async () => {
  const c = {
      NODE_ENV: 'production',
      ADMIN_ORIGIN: 'https://shop.test',
      ADMIN_API_BASE_URL: 'https://api.test',
      ADMIN_COGNITO_REGION: 'us-east-2',
      ADMIN_COGNITO_CLIENT_ID: 'Synthetic',
      ADMIN_SESSION_KEY: '12'.repeat(32),
    },
    fetcher = vi.fn<typeof fetch>();
  for (const [url, method, origin, status] of [
    [
      'https://shop.test/api/admin/customers/search',
      'GET',
      'https://shop.test',
      405,
    ],
    [
      'https://shop.test/api/admin/customers/search',
      'POST',
      'https://evil.test',
      403,
    ],
    [
      'https://shop.test/api/admin/customers/search?query=test',
      'POST',
      'https://shop.test',
      400,
    ],
    [
      'https://shop.test/api/admin/customers/search',
      'POST',
      'https://shop.test',
      401,
    ],
  ] as const) {
    const r = await customersRelay(
      new Request(url, { method, headers: { origin } }),
      'search',
      c,
      fetcher,
    );
    expect(r.status).toBe(status);
    expect(r.headers.get('cache-control')).toContain('no-store');
  }
  expect(fetcher).not.toHaveBeenCalled();
});
it('Customers provides one labelled field, clear action and honest identity/coverage limits', () => {
  const html = renderToStaticMarkup(
    createElement(Customers, { expiresAt: Date.now() + 900000 }),
  );
  expect(html).toContain('Name or exact email');
  expect(html).toContain('Clear search');
  expect(html).toContain('Historical search coverage is incomplete');
  expect(html).toContain('does not verify');
  expect(html).toContain('aria-current="page"');
  expect(html).not.toContain('localStorage');
});
