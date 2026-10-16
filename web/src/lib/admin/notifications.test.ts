import { it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import {
  NotificationRows,
  NotificationStatus,
} from '../../components/admin/notification-status';
import { notificationsRelay } from './server';
vi.mock('server-only', () => ({}));
it('message statuses distinguish suppression, uncertainty and missing records', () => {
  const html = renderToStaticMarkup(
    createElement(NotificationRows, {
      data: {
        notifications: [
          {
            key: 'CONFIRMATION#email',
            kind: 'CONFIRMATION',
            channel: 'email',
            status: 'UNCERTAIN',
            reason: 'DELIVERY_ACKNOWLEDGEMENT_UNKNOWN',
            updatedAt: '2026-10-20T18:00:00Z',
            pickupDate: '2026-10-22',
          },
        ],
        truncated: false,
        confirmationSms: 'NOT_CONFIGURED',
      },
    }),
  );
  expect(html).toContain('needs attention');
  expect(html).toContain('Do not resend without reconciliation');
  expect(html).toContain('Not recorded');
  expect(html).toContain('SMS: not configured');
});
it('message view is explicit and does not imply live sending', () => {
  const html = renderToStaticMarkup(
    createElement(NotificationStatus, { orderId: 'synthetic' }),
  );
  expect(html).toContain('View message status');
  expect(html).toContain('Live sending remains disabled');
  expect(html).not.toContain('localStorage');
});
it('notification relay rejects missing session, cross-site, write and query input', async () => {
  const c = {
      NODE_ENV: 'production',
      ADMIN_ORIGIN: 'https://shop.test',
      ADMIN_API_BASE_URL: 'https://api.test',
      ADMIN_COGNITO_REGION: 'us-east-2',
      ADMIN_COGNITO_CLIENT_ID: 'Synthetic',
      ADMIN_SESSION_KEY: '12'.repeat(32),
    },
    fetcher = vi.fn<typeof fetch>();
  for (const [method, query, site, status] of [
    ['GET', '', 'same-origin', 401],
    ['GET', '', 'cross-site', 403],
    ['POST', '', 'same-origin', 405],
    ['GET', '?cursor=x', 'same-origin', 400],
  ] as const) {
    const r = await notificationsRelay(
      new Request(
        'https://shop.test/api/admin/orders/id/notifications' + query,
        { method, headers: { 'sec-fetch-site': site } },
      ),
      '01K00000000000000000000001',
      c,
      fetcher,
    );
    expect(r.status).toBe(status);
    expect(r.headers.get('cache-control')).toContain('no-store');
  }
  expect(fetcher).not.toHaveBeenCalled();
});
