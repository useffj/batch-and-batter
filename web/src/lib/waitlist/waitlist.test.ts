import { it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  JoinWaitlist,
  Unsubscribe,
} from '../../components/storefront/waitlist';
import { WaitlistManagement } from '../../components/admin/waitlists';
import { waitlistRelay } from './relay';
import { waitlistAdminRelay } from '../admin/server';
vi.mock('server-only', () => ({}));
const config = {
  NODE_ENV: 'production',
  ADMIN_ORIGIN: 'https://shop.test',
  ADMIN_API_BASE_URL: 'https://api.test',
  ADMIN_COGNITO_REGION: 'us-east-2',
  ADMIN_COGNITO_CLIENT_ID: 'Synthetic',
  ADMIN_SESSION_KEY: '12'.repeat(32),
};
it('waitlist and opt-out controls are accessible and contain no stored credentials', () => {
  const html = renderToStaticMarkup(
    createElement(JoinWaitlist, {
      dropId: 'test',
      productId: 'test',
      name: 'Cookie',
    }),
  );
  expect(html).toContain('Join Waitlist');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('role="status"');
  const opt = renderToStaticMarkup(createElement(Unsubscribe));
  expect(opt).toContain('Unsubscribe');
  expect(opt).toContain('disabled');
});
it('administrator view requires explicit availability review and approval', () => {
  const html = renderToStaticMarkup(
    createElement(WaitlistManagement, { expiresAt: Date.now() + 10000 }),
  );
  expect(html).toContain('Waitlist Management');
  expect(html).toContain('Review availability');
  expect(html).toContain('first-come, first-served');
  expect(html).not.toContain('Approve availability emails');
  expect(html).toContain('operator investigation');
});
it('public native GET, cross-site and native form POST cannot send email data upstream', async () => {
  const fetcher = vi.fn<typeof fetch>();
  for (const [method, headers, status] of [
    ['GET', {}, 405],
    [
      'POST',
      {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://shop.test',
      },
      403,
    ],
    [
      'POST',
      { 'content-type': 'application/json', origin: 'https://evil.test' },
      403,
    ],
  ] as const) {
    const r = await waitlistRelay(
      new Request('https://shop.test/api/waitlist/join', { method, headers }),
      'join',
      {},
      fetcher,
    );
    expect(r.status).toBe(status);
    expect(r.headers.get('cache-control')).toContain('no-store');
  }
  expect(fetcher).not.toHaveBeenCalled();
});
it('public relay bounds request bodies', async () => {
  const fetcher = vi.fn<typeof fetch>();
  const r = await waitlistRelay(
    new Request('https://shop.test/api/waitlist/join', {
      method: 'POST',
      headers: {
        origin: 'https://shop.test',
        'content-type': 'application/json',
      },
      body: 'x'.repeat(2049),
    }),
    'join',
    {},
    fetcher,
  );
  expect(r.status).toBe(503);
  expect(fetcher).not.toHaveBeenCalled();
});
it('admin waitlists preserve session and same-origin checks', async () => {
  const fetcher = vi.fn<typeof fetch>();
  for (const [action, method, origin, status] of [
    ['list', 'GET', 'https://shop.test', 401],
    ['campaign', 'POST', 'https://evil.test', 403],
    ['review', 'POST', 'https://shop.test', 401],
  ] as const) {
    const r = await waitlistAdminRelay(
      new Request('https://shop.test/api/admin/waitlists/' + action, {
        method,
        headers: { origin, 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      }),
      action,
      config,
      fetcher,
    );
    expect(r.status).toBe(status);
    expect(r.headers.get('cache-control')).toContain('no-store');
  }
  expect(fetcher).not.toHaveBeenCalled();
});

it('only eligible sold-out product cards offer Join Waitlist', async () => {
  const { Storefront } = await import('../../components/storefront/storefront');
  const drop = {
    id: '01K00000000000000000000001',
    name: 'Synthetic Drop',
    description: 'Test',
    status: 'OPEN' as const,
    opensAt: '2026-09-01T12:00:00Z',
    quantityLimit: 12,
    timezone: 'America/Denver',
    pickupLocation: 'Test',
    pickupInstructions: 'Test',
    pickupDates: [],
    products: [
      {
        id: '01K00000000000000000000002',
        name: 'Cookie',
        priceCents: 400,
        available: 0,
        cookieUnits: 1,
      },
    ],
  };
  expect(
    renderToStaticMarkup(
      createElement(Storefront, { result: { kind: 'ready', drop } }),
    ),
  ).toContain('Join Waitlist');
  expect(
    renderToStaticMarkup(
      createElement(Storefront, {
        result: {
          kind: 'ready',
          drop: { ...drop, products: [{ ...drop.products[0], available: 3 }] },
        },
      }),
    ),
  ).not.toContain('Join Waitlist');
  expect(
    renderToStaticMarkup(
      createElement(Storefront, {
        result: { kind: 'ready', drop: { ...drop, status: 'CLOSED' } },
      }),
    ),
  ).not.toContain('Join Waitlist');
});
