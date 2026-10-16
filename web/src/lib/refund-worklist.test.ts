import { createElement } from 'react';
import { test, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ReadOnlyRefundDetails,
  RefundWorklistView,
  financialStatuses,
  type RefundDetail,
} from '../components/admin/refund-worklist';
import { refundWorklistRelay } from './admin/server';
vi.mock('server-only', () => ({}));
test('display-only evidence separates amounts and does not include execution actions', () => {
  const d: RefundDetail = {
    order: {
      orderId: 'synthetic',
      reference: null,
      customerName: 'Synthetic',
      dropId: 'synthetic',
      pickupDate: '2026-10-22',
      currency: 'usd',
      originalTotalCents: 945,
      capturedCents: 945,
      refundedCents: 100,
      reservedCents: 50,
      availableCents: 795,
      blocked: false,
      returned: {},
      updatedAt: '2026-10-22T18:00:00Z',
    },
    operation: {
      operationId: 'synthetic',
      amountCents: 50,
      status: 'PENDING',
      updatedAt: '2026-10-22T18:00:00Z',
      createdAt: '2026-10-22T18:00:00Z',
      providerId: null,
      checks: 2,
      disposition: 'DO_NOT_RESTOCK',
      items: [],
    },
    audit: [],
    nextCursor: 'synthetic',
  };
  const html = renderToStaticMarkup(
    createElement(ReadOnlyRefundDetails, { data: d }),
  );
  for (const label of [
    'Original Order total',
    'Captured payment amount',
    'Confirmed refunded total',
    'Reserved / in progress',
    'Available to refund',
    'Not recorded',
    'More recorded transitions remain',
    '$7.95',
  ])
    expect(html).toContain(label);
  expect(html).not.toContain('<button');
  expect(html).not.toContain('Authorize refund');
  expect(html).not.toContain('Process or reconcile');
});
test('worklist displays bounded coverage and separate triage rules', () => {
  const html = renderToStaticMarkup(
    createElement(RefundWorklistView, { expiresAt: Date.now() + 900000 }),
  );
  expect(financialStatuses).toHaveLength(7);
  for (const label of [
    'not a snapshot',
    '60 minutes',
    '24 hours',
    'Attention only',
    'Read-only recorded evidence',
  ])
    expect(html).toContain(label);
  expect(html).not.toContain('Retry refund');
});
for (const method of ['POST', 'PUT', 'DELETE'])
  test('read relay rejects ' + method, async () => {
    const f = vi.fn<typeof fetch>();
    const r = await refundWorklistRelay(
      new Request('https://shop.test/api/admin/refund-worklist', { method }),
      {
        NODE_ENV: 'development',
        ADMIN_ORIGIN: 'https://shop.test',
        ADMIN_API_BASE_URL: 'https://api.test',
        ADMIN_COGNITO_REGION: 'us-east-2',
        ADMIN_COGNITO_CLIENT_ID: 'Synthetic',
        ADMIN_SESSION_KEY: '12'.repeat(32),
      },
      f,
    );
    expect(r.status).toBe(405);
    expect(f).not.toHaveBeenCalled();
    expect(r.headers.get('cache-control')).toContain('no-store');
  });
