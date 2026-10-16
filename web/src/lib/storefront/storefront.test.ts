import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Storefront } from '../../components/storefront/storefront';
import { loadStorefront, parseDropResponse, publicEndpoint } from './client';
const config = {
  STOREFRONT_API_BASE_URL: 'https://public.example.test',
  STOREFRONT_CURRENCY: 'USD',
  NODE_ENV: 'production',
};
function fixture() {
  return {
    drop: {
      id: '01K00000000000000000000000',
      quantityLimit: 18,
      name: 'October cookies',
      description: 'Fresh cookies',
      status: 'OPEN',
      opensAt: '2020-10-03T18:00:00.000Z',
      timezone: 'America/Denver',
      pickupLocation: 'Test pickup location',
      pickupInstructions: 'Bring your order number.',
      products: [
        {
          id: '01K00000000000000000000001',
          cookieUnits: 2,
          name: 'Chocolate cookie',
          description: 'A buttery cookie with a soft center.',
          ingredients: ['Flour', 'Butter'],
          allergens: ['Wheat', 'Milk'],
          priceCents: 525,
          availability: { total: 20, reserved: 5, sold: 0, available: 15 },
        },
        {
          id: '01K00000000000000000000002',
          cookieUnits: 1,
          name: 'Vanilla cookie',
          description: 'A buttery cookie with a soft center.',
          ingredients: ['Flour', 'Butter'],
          allergens: ['Wheat', 'Milk'],
          priceCents: 450,
          availability: { total: 20, reserved: 0, sold: 20, available: 0 },
        },
      ],
      pickupDates: [
        {
          date: '2026-10-03',
          startTime: '16:00',
          endTime: '19:00',
          timezone: 'America/Denver',
        },
      ],
    },
  };
}
function render(value: unknown) {
  return renderToStaticMarkup(
    createElement(Storefront, {
      result: { kind: 'ready', drop: parseDropResponse(value) },
    }),
  );
}
afterEach(() => vi.useRealTimers());
describe('authoritative storefront presentation', () => {
  it('renders OPEN, multiple products, prices and informational availability', () => {
    const html = render(fixture());
    for (const value of [
      'Open',
      'Chocolate cookie',
      'Vanilla cookie',
      '$5.25',
      '$4.50',
      '15 available',
      'None currently available',
      'does not reserve inventory',
    ])
      expect(html).toContain(value);
    expect(html.match(/<h1(?:\s[^>]*)?>/g)).toHaveLength(1);
    expect(html).toContain('aria-labelledby="cookies"');
    expect(html).toContain('<ul');
    expect(html).toContain('Add to Cart');
    expect(html).not.toMatch(/<form|<script/);
  });
  it.each(['SCHEDULED', 'PAUSED', 'SOLD_OUT', 'CLOSED'])(
    'renders %s without pretending ordering is available',
    (state) => {
      const f = fixture();
      f.drop.status = state;
      const html = render(f);
      expect(html).toContain('Ordering is not currently available');
      if (state === 'SCHEDULED') {
        expect(html).toContain('Upcoming');
        expect(html).toContain('12:00 PM');
        expect(html).toContain('Opening is confirmed by the store');
        expect(html).not.toContain('>Open<'); // Past timestamp never changes authoritative state.
      }
    },
  );
  it('formats pickup calendar date without timezone day shift', () => {
    const html = render(fixture());
    for (const s of [
      'Saturday, October 3, 2026',
      '4:00 PM–7:00 PM',
      'America/Denver',
      'Test pickup location',
      'Bring your order number.',
    ])
      expect(html).toContain(s);
  });
  it('handles null Drop', () =>
    expect(render({ drop: null })).toContain(
      'Fresh cookies are in the works.',
    ));
  it('handles permitted empty lists', () => {
    const f = fixture();
    f.drop.products = [];
    f.drop.pickupDates = [];
    expect(render(f)).toContain('No products are listed');
    expect(render(f)).toContain('No pickup dates are listed');
  });
  it('escapes untrusted text and does not render storage IDs', () => {
    const f = fixture();
    f.drop.name = '<script>alert(1)</script>';
    const html = render({
      drop: { ...f.drop, privateField: 'PRIVATE_INTERNAL_ID' },
    });
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('PRIVATE_INTERNAL_ID');
  });
  it.each(['invalid', 'unavailable'] as const)(
    'shows safe accessible %s UI',
    (kind) => {
      const html = renderToStaticMarkup(
        createElement(Storefront, { result: { kind } }),
      );
      expect(html).toContain('role="status"');
      expect(html).toContain('Reload Drop information');
      expect(html).not.toMatch(/stack trace|Error:|undefined/);
    },
  );
});
describe('bounded public response validation', () => {
  it.each([
    undefined,
    {},
    [],
    { drop: {} },
    { drop: { ...fixture().drop, status: 'DRAFT' } },
    { drop: { ...fixture().drop, status: 'COMPLETED' } },
    { drop: { ...fixture().drop, status: 'BOGUS' } },
    { drop: { ...fixture().drop, timezone: 'invalid' } },
    { drop: { ...fixture().drop, opensAt: '2026-02-30T00:00:00Z' } },
    {
      drop: {
        ...fixture().drop,
        products: Array(101).fill(fixture().drop.products[0]),
      },
    },
  ])('rejects malformed contract %#', (value) =>
    expect(() => parseDropResponse(value)).toThrow(),
  );
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '525'])(
    'rejects invalid price %s',
    (priceCents) => {
      const f = fixture();
      Object.assign(f.drop.products[0], { priceCents });
      expect(() => parseDropResponse(f)).toThrow();
    },
  );
  it('rejects inconsistent inventory rather than substituting availability', () => {
    const f = fixture();
    f.drop.products[0].availability.available = 19;
    expect(() => parseDropResponse(f)).toThrow();
  });
  it.each([
    { date: '2026-02-30' },
    { startTime: '24:00' },
    { endTime: '15:00' },
    { timezone: 'invalid' },
  ])('rejects malformed pickup %#', (change) => {
    const f = fixture();
    Object.assign(f.drop.pickupDates[0], change);
    expect(() => parseDropResponse(f)).toThrow();
  });
});
describe('configuration and network boundary', () => {
  it('preserves an API stage base path', () =>
    expect(
      publicEndpoint({
        ...config,
        STOREFRONT_API_BASE_URL: 'https://public.example.test/dev/',
      }).href,
    ).toBe('https://public.example.test/dev/drops/current'));
  it.each([
    'http://public.example.test',
    'https://user:password@example.test',
    'https://example.test?key=value',
    'https://example.test#hash',
  ])('rejects unsafe base URL %#', (url) =>
    expect(() =>
      publicEndpoint({ ...config, STOREFRONT_API_BASE_URL: url }),
    ).toThrow(),
  );
  it('allows HTTP localhost only in development', () => {
    expect(
      publicEndpoint({
        ...config,
        NODE_ENV: 'development',
        STOREFRONT_API_BASE_URL: 'http://127.0.0.1:9000',
      }).protocol,
    ).toBe('http:');
    expect(() =>
      publicEndpoint({
        ...config,
        STOREFRONT_API_BASE_URL: 'http://127.0.0.1:9000',
      }),
    ).toThrow();
  });
  it('fails closed without explicit currency or API configuration', async () => {
    const request = vi.fn();
    expect(await loadStorefront({}, request)).toEqual({ kind: 'unavailable' });
    expect(request).not.toHaveBeenCalled();
    expect(() =>
      publicEndpoint({ ...config, STOREFRONT_CURRENCY: 'EUR' }),
    ).toThrow();
  });
  it('uses a read-only uncached credential-free request', async () => {
    const request = vi.fn().mockResolvedValue(Response.json(fixture()));
    expect((await loadStorefront(config, request)).kind).toBe('ready');
    const options = request.mock.calls[0][1];
    expect(options).toMatchObject({
      method: 'GET',
      cache: 'no-store',
      redirect: 'error',
      headers: { Accept: 'application/json' },
    });
    expect(options.body).toBeUndefined();
    expect(options.headers.Authorization).toBeUndefined();
  });
  it.each([400, 500, 503])('handles HTTP %s safely', async (status) => {
    expect(
      await loadStorefront(
        config,
        vi
          .fn()
          .mockResolvedValue(new Response('raw sensitive error', { status })),
      ),
    ).toEqual({ kind: 'unavailable' });
  });
  it('does not leak thrown network errors', async () =>
    expect(
      await loadStorefront(
        config,
        vi.fn().mockRejectedValue(new Error('sensitive')),
      ),
    ).toEqual({ kind: 'unavailable' }));
  it.each([
    'not json',
    JSON.stringify({ drop: { status: 'BOGUS' } }),
    ' '.repeat(262145),
  ])('rejects invalid/oversized body %#', async (body) => {
    expect(
      await loadStorefront(
        config,
        vi.fn().mockResolvedValue(
          new Response(body, {
            headers: { 'content-type': 'application/json' },
          }),
        ),
      ),
    ).toEqual({ kind: 'invalid' });
  });
  it('rejects HTML responses', async () =>
    expect(
      await loadStorefront(
        config,
        vi.fn().mockResolvedValue(new Response('<html>')),
      ),
    ).toEqual({ kind: 'invalid' }));
  it('aborts slow requests within five seconds', async () => {
    vi.useFakeTimers();
    const request = vi.fn(
      (_url, options) =>
        new Promise<Response>((_resolve, reject) =>
          options.signal.addEventListener('abort', () =>
            reject(new Error('aborted')),
          ),
        ),
    );
    const result = loadStorefront(config, request);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toEqual({ kind: 'unavailable' });
  });
});

it('allowlists public product information and escapes customer-visible details', () => {
  const f = fixture();
  Object.assign(f.drop.products[0], {
    description: '<script>private()</script>',
    PK: 'PRIVATE_KEY',
    adminNotes: 'PRIVATE_NOTE',
  });
  const d = parseDropResponse(f)!;
  expect(Object.keys(d.products[0]).sort()).toEqual(
    [
      'id',
      'name',
      'description',
      'ingredients',
      'allergens',
      'priceCents',
      'available',
      'cookieUnits',
    ].sort(),
  );
  const html = render(f);
  expect(html).toContain('&lt;script&gt;');
  expect(html).toContain('Flour, Butter');
  expect(html).toContain('Wheat, Milk');
  expect(html).not.toMatch(/PRIVATE_KEY|PRIVATE_NOTE|<script/);
});
it.each([
  { ingredients: null },
  { allergens: [''] },
  { allergens: Array(101).fill('Milk') },
  { description: 'x'.repeat(4001) },
])('rejects malformed product information %j', (patch) => {
  const f = fixture();
  Object.assign(f.drop.products[0], patch);
  expect(() => parseDropResponse(f)).toThrow();
});
it('does not imply missing allergen information means allergen-free', () => {
  const f = fixture();
  f.drop.products[0].allergens = [];
  expect(render(f)).toContain('No allergen information listed.');
  expect(render(f)).toContain('Contact the bakery before ordering.');
});
