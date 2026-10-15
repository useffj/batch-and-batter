import { it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { OrderDetails, money, type Order } from '../../components/admin/orders';
import { ordersRelay } from './server';
vi.mock('server-only', () => ({}));
it('renders persisted financial snapshots and missing fulfillment honestly', () => {
  const order = {
    displayOrderNumber: 'BB-23456789ABCD',
    status: 'PAYMENT_PENDING',
    paymentStatus: 'CREATED',
    customer: {
      name: 'Synthetic',
      email: 'synthetic@example.test',
      phone: '+15555550123',
    },
    items: [{ name: 'Historical cookie', quantity: 2, unitPriceCents: 425 }],
    subtotalCents: 850,
    taxCents: 70,
    feeCents: 25,
    totalCents: 945,
    currency: 'usd',
    pickup: {
      date: '2026-10-22',
      startTime: '16:00',
      endTime: '19:00',
      timezone: 'America/Denver',
      location: 'Synthetic bakery',
      instructions: 'Synthetic only',
    },
    createdAt: '2026-10-18T18:00:00Z',
    updatedAt: '2026-10-18T18:00:00Z',
  } as Order;
  const html = renderToStaticMarkup(createElement(OrderDetails, { order }));
  for (const text of [
    'Historical cookie',
    '$4.25',
    '$8.50',
    '$0.70',
    '$0.25',
    '$9.45',
    'Not recorded',
    'Payment pending',
    'Created',
    'Synthetic bakery',
  ])
    expect(html).toContain(text);
  expect(html).not.toContain('Ready for pickup');
  expect(money(429, 'usd')).toBe('$4.29');
});
it('orders relay rejects missing session and cross-site reads without upstream access', async () => {
  const fetcher = vi.fn<typeof fetch>();
  const c = {
    NODE_ENV: 'production',
    ADMIN_ORIGIN: 'https://shop.test',
    ADMIN_API_BASE_URL: 'https://api.test',
    ADMIN_COGNITO_REGION: 'us-east-2',
    ADMIN_COGNITO_CLIENT_ID: 'Synthetic',
    ADMIN_SESSION_KEY: '12'.repeat(32),
  };
  expect(
    (
      await ordersRelay(
        new Request('https://shop.test/api/admin/orders'),
        undefined,
        c,
        fetcher,
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await ordersRelay(
        new Request('https://shop.test/api/admin/orders', {
          headers: { 'sec-fetch-site': 'cross-site' },
        }),
        undefined,
        c,
        fetcher,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await ordersRelay(
        new Request('https://shop.test/api/admin/orders', { method: 'POST' }),
        undefined,
        c,
        fetcher,
      )
    ).status,
  ).toBe(405);
  expect(fetcher).not.toHaveBeenCalled();
});
