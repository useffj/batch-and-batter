import { test, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { refundCents, refundLabels } from './refunds';
import { RefundReview } from '../components/admin/refunds';
import { guestAccessRelay } from './admin/server';
vi.mock('server-only', () => ({}));
for (const [value, cents] of [
  ['9.45', 945],
  ['0.01', 1],
  ['1.1', 110],
  ['0', null],
  ['1.001', null],
  ['-1', null],
  ['1e2', null],
  ['', null],
] as const)
  test('exact currency ' + value, () => expect(refundCents(value)).toBe(cents));
test('refund form never claims authorization means completed', () => {
  const html = renderToStaticMarkup(
    createElement(RefundReview, { orderId: '01K00000000000000000000001' }),
  );
  expect(html).toContain('separate from money returned');
  expect(html).toContain('full-refund entitlement');
  expect(html).not.toContain('localStorage');
  expect(refundLabels.PENDING).not.toContain('completed');
});
for (const action of ['authorize', 'reconcile'] as const)
  test(
    action + ' relay rejects cross-origin without contacting backend',
    async () => {
      const fetcher = vi.fn<typeof fetch>();
      const c = {
        NODE_ENV: 'production',
        ADMIN_ORIGIN: 'https://shop.test',
        ADMIN_API_BASE_URL: 'https://api.test',
        ADMIN_COGNITO_REGION: 'us-east-2',
        ADMIN_COGNITO_CLIENT_ID: 'Synthetic',
        ADMIN_SESSION_KEY: '12'.repeat(32),
      };
      const r = await guestAccessRelay(
        new Request('https://shop.test/api/admin/refunds', {
          method: 'POST',
          headers: {
            origin: 'https://evil.test',
            'content-type': 'application/json',
          },
          body: '{}',
        }),
        '01K00000000000000000000001',
        action,
        c,
        fetcher,
      );
      expect(r.status).toBe(403);
      expect(fetcher).not.toHaveBeenCalled();
      expect(r.headers.get('cache-control')).toContain('no-store');
    },
  );
