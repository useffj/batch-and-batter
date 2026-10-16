import { expect, it, vi } from 'vitest';
import { guestRelay } from '../guest/relay';
import { waitlistRelay } from '../waitlist/relay';
const config = {
  NODE_ENV: 'development',
  STOREFRONT_API_BASE_URL: 'http://127.0.0.1:4182',
  STOREFRONT_CURRENCY: 'USD',
};
it.each(['guest', 'waitlist'])(
  '%s accepts the actual host, never a caller-supplied forwarded origin',
  async (kind) => {
    for (const [origin, site, expected] of [
      ['http://127.0.0.1:4183', 'same-origin', 200],
      ['https://evil.test', 'same-origin', 403],
      ['http://localhost:4183', 'same-origin', 403],
      ['http://127.0.0.1:4183', 'cross-site', 403],
    ] as const) {
      const upstream = vi
        .fn()
        .mockResolvedValue(Response.json({ message: 'Accepted', order: {} }));
      const request = new Request('http://localhost:4183/api/test', {
        method: 'POST',
        headers: {
          host: '127.0.0.1:4183',
          origin,
          'x-forwarded-host': 'evil.test',
          'sec-fetch-site': site,
          'content-type': 'application/json',
        },
        body: JSON.stringify(
          kind === 'guest'
            ? { token: 'a'.repeat(43) }
            : {
                dropId: '01K5J100000000000000000001',
                productId: '01K5J100000000000000000002',
                email: 'synthetic@example.test',
                consent: true,
              },
        ),
      });
      const response =
        kind === 'guest'
          ? await guestRelay(request, 'view', config, upstream)
          : await waitlistRelay(request, 'join', config, upstream);
      expect(response.status).toBe(expected);
      expect(upstream).toHaveBeenCalledTimes(expected === 200 ? 1 : 0);
    }
  },
);
