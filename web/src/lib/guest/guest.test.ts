import { it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  GuestOrderDetails,
  ManageOrder,
  guestDate,
  guestTime,
  type GuestView,
} from '../../components/guest/manage-order';
import { guestRelay } from './relay';
import { guestAccessRelay } from '../admin/server';
vi.mock('server-only', () => ({}));
it('guest presentation uses human dates and frozen historical prices without internal identities', () => {
  const data = {
    order: {
      reference: 'BB-SYNTHETIC',
      items: [{ name: 'Chocolate cookie', quantity: 2, unitPriceCents: 425 }],
      subtotalCents: 850,
      taxCents: 70,
      feeCents: 25,
      totalCents: 945,
      currency: 'usd',
      paymentStatus: 'CAPTURED',
      status: 'PAID',
      pickup: {
        date: '2026-10-22',
        startTime: '16:00',
        endTime: '19:00',
        location: 'Synthetic bakery',
        instructions: '',
      },
      fulfillmentStatus: null,
    },
  } as GuestView;
  const html = renderToStaticMarkup(createElement(GuestOrderDetails, { data }));
  for (const text of [
    '$9.45',
    '$4.25',
    'Thursday, October 22',
    '4:00 PM',
    '7:00 PM',
    'Not recorded',
  ])
    expect(html).toContain(text);
  expect(guestDate('2026-11-01')).toBe('Sunday, November 1');
  expect(guestTime('15:00')).toBe('3:00 PM');
});
it('guest landing does not expose data or require Cognito', () => {
  const html = renderToStaticMarkup(createElement(ManageOrder));
  expect(html).toContain('Your order');
  expect(html).toContain('Refunds and cancellations are not available');
  expect(html).not.toContain('localStorage');
  expect(html).not.toContain('Cognito');
});
it('guest relay rejects cross-origin, GET, query and oversized bodies without upstream calls', async () => {
  const fetcher = vi.fn<typeof fetch>(),
    config = {
      NODE_ENV: 'production',
      STOREFRONT_API_BASE_URL: 'https://api.test',
      STOREFRONT_CURRENCY: 'USD',
    };
  for (const [method, origin, query, body] of [
    ['GET', 'https://shop.test', '', undefined],
    ['POST', 'https://evil.test', '', '{}'],
    ['POST', 'https://shop.test', '?token=secret', '{}'],
    ['POST', 'https://shop.test', '', 'x'.repeat(2049)],
  ] as const) {
    const r = await guestRelay(
      new Request('https://shop.test/api/order/manage/view' + query, {
        method,
        headers: { origin, 'Content-Type': 'application/json' },
        body,
      }),
      'view',
      config,
      fetcher,
    );
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.headers.get('cache-control')).toContain('no-store');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
  }
  expect(fetcher).not.toHaveBeenCalled();
});
it('admin reissue relay requires same-origin and encrypted authenticated session', async () => {
  const config = {
      NODE_ENV: 'production',
      ADMIN_ORIGIN: 'https://shop.test',
      ADMIN_API_BASE_URL: 'https://api.test',
      ADMIN_COGNITO_REGION: 'us-east-2',
      ADMIN_COGNITO_CLIENT_ID: 'Synthetic',
      ADMIN_SESSION_KEY: '12'.repeat(32),
    },
    fetcher = vi.fn<typeof fetch>();
  for (const origin of ['https://evil.test', 'https://shop.test']) {
    const r = await guestAccessRelay(
      new Request('https://shop.test/api/admin/orders/id/access/reissue', {
        method: 'POST',
        headers: { origin, 'Content-Type': 'application/json' },
        body: '{}',
      }),
      '01K00000000000000000000001',
      'reissue',
      config,
      fetcher,
    );
    expect([401, 403]).toContain(r.status);
  }
  expect(fetcher).not.toHaveBeenCalled();
});
