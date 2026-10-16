import { it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CancellationRequest } from '../../components/guest/cancellation-request';
import { CancellationReview } from '../../components/admin/cancellation-review';
import { guestRelay } from './relay';
import { type CancellationView, requestTime } from '../order-requests';
const base: CancellationView = {
  hours: 24,
  deadline: '2026-10-21T22:00:00.000Z',
  eligible: true,
  exceptionEligible: false,
  unavailable: null,
  request: null,
};
const render = (data: CancellationView) =>
  renderToStaticMarkup(
    createElement(CancellationRequest, {
      data,
      send: async () => ({}),
      refresh: async () => {},
    }),
  );
it('timely cancellation shows exact Denver deadline and separate processing', () => {
  const html = render(base);
  expect(html).toContain('4:00 PM');
  expect(html).toContain('Request cancellation');
  expect(html).toContain('Financial processing is a separate step');
  expect(html).not.toContain('Issue Refund');
  expect(requestTime('2026-03-07T22:00:00.000Z')).toContain('3:00 PM');
});
it('late assistance is discretionary and unknown evidence exposes no action', () => {
  expect(
    render({ ...base, eligible: false, exceptionEligible: true }),
  ).toContain('Request assistance');
  expect(
    render({
      ...base,
      eligible: false,
      unavailable: 'Order eligibility requires bakery assistance.',
    }),
  ).not.toContain('Request cancellation</button>');
});
it('durable pending request never implies completed refund or cancellation', () => {
  const html = render({
    ...base,
    eligible: false,
    request: {
      requestId: 'synthetic',
      type: 'GUARANTEED',
      status: 'RECEIVED_PENDING_PROCESSING',
      reason: '<script>synthetic</script>',
      revision: 1,
      createdAt: '2026-10-20T18:00:00.000Z',
      updatedAt: '2026-10-20T18:00:00.000Z',
      eligibility: {
        deadline: base.deadline!,
        amountCents: 945,
        currency: 'usd',
        pickupDate: '2026-10-22',
        pickupStart: '16:00',
      },
    },
  });
  expect(html).toContain('financial processing pending');
  expect(html).toContain('does not confirm');
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('Request cancellation</button>');
});
it('administrator review does not offer financial execution', () => {
  const html = renderToStaticMarkup(
    createElement(CancellationReview, {
      orderId: '01K00000000000000000000101',
    }),
  );
  expect(html).toContain('Load request and review history');
  expect(html).not.toContain('Issue Refund');
});
it('request relay uses fixed JSON POST without putting bearer in URL', async () => {
  const token = 'A'.repeat(43),
    fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"received":true}'));
  const r = await guestRelay(
    new Request('https://shop.test/api/order/manage/request', {
      method: 'POST',
      headers: {
        origin: 'https://shop.test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        token,
        request: { requestId: 'synthetic', type: 'GUARANTEED', reason: '' },
      }),
    }),
    'request',
    {
      NODE_ENV: 'production',
      STOREFRONT_API_BASE_URL: 'https://api.test',
      STOREFRONT_CURRENCY: 'USD',
    },
    fetcher,
  );
  expect(r.status).toBe(200);
  expect(String(fetcher.mock.calls[0][0])).toBe(
    'https://api.test/orders/manage/request',
  );
  expect(fetcher.mock.calls[0][1]?.body).toContain(token);
  expect(r.headers.get('cache-control')).toContain('no-store');
});
