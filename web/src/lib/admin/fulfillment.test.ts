import { it, expect, vi } from 'vitest';
import { relayFulfillment } from './server';
import { denverToday, Fulfillment } from '../../components/admin/fulfillment';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
vi.mock('server-only', () => ({}));
it('fulfillment relays reject cross-origin writes, unsupported methods, and missing authentication', async () => {
  const c = {
    NODE_ENV: 'production',
    ADMIN_ORIGIN: 'https://shop.test',
    ADMIN_API_BASE_URL: 'https://api.test',
    ADMIN_COGNITO_REGION: 'us-east-2',
    ADMIN_COGNITO_CLIENT_ID: 'Synthetic',
    ADMIN_SESSION_KEY: '12'.repeat(32),
  };
  const fetcher = vi.fn<typeof fetch>();
  for (const [method, origin, id, status] of [
    ['POST', 'https://evil.test', '01K00000000000000000000001', 403],
    ['PUT', 'https://shop.test', '01K00000000000000000000001', 405],
    ['GET', 'https://shop.test', undefined, 401],
    ['POST', 'https://shop.test', '01K00000000000000000000001', 401],
  ] as const) {
    const r = await relayFulfillment(
      new Request('https://shop.test/api/admin/fulfillment', {
        method,
        headers: { origin },
      }),
      id,
      c,
      fetcher,
    );
    expect(r.status).toBe(status);
    expect(r.headers.get('cache-control')).toContain('no-store');
  }
  expect(fetcher).not.toHaveBeenCalled();
});
it('queue exposes date and truthful page counts with no fabricated history', () => {
  const html = renderToStaticMarkup(
    createElement(Fulfillment, { expiresAt: Date.now() + 900000 }),
  );
  expect(html).toContain('Pickup date');
  expect(html).toContain('Counts cover this retrieved page');
  expect(html).toContain('awaiting preparation');
  expect(html).toContain('aria-current="page"');
});
it('today uses Denver across UTC date boundaries', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-23T01:00:00Z'));
  expect(denverToday()).toBe('2026-10-22');
  vi.useRealTimers();
});
