import { it, expect, vi } from 'vitest';
import { previewData } from './preview';
import { dropRelay } from './server';
vi.mock('server-only', () => ({}));
it('rejects public/non-draft/action-enabled responses', () => {
  for (const value of [
    {},
    { preview: false },
    { preview: true, actionsEnabled: true },
  ])
    expect(() => previewData(value, '01K00000000000000000000001')).toThrow();
});
it('isolated SSR rejects lifecycle writes before network access', async () => {
  const fetcher = vi.fn<typeof fetch>();
  const response = await dropRelay(
    new Request('https://admin.test/api/admin/drops', { method: 'POST' }),
    ['01K00000000000000000000001', 'publish'],
    {
      NODE_ENV: 'production',
      ADMIN_CATALOG_MODE: 'isolated',
      ADMIN_ORIGIN: 'https://admin.test',
      ADMIN_API_BASE_URL: 'https://api.test',
      ADMIN_COGNITO_REGION: 'us-east-2',
      ADMIN_COGNITO_CLIENT_ID: 'synthetic',
      ADMIN_SESSION_KEY: '12'.repeat(32),
    },
    fetcher,
  );
  expect(response.status).toBe(405);
  expect(fetcher).not.toHaveBeenCalled();
});

it('renders saved draft presentation with no customer action components', async () => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { DraftPreview } =
    await import('../../components/storefront/draft-preview');
  const html = renderToStaticMarkup(
    React.createElement(DraftPreview, {
      data: {
        drop: {
          dropId: '01K00000000000000000000001',
          name: 'Synthetic draft',
          status: 'DRAFT',
          timezone: 'America/Denver',
          pickupLocation: 'Synthetic bakery',
          pickupInstructions: 'Local only',
        },
        description: 'Saved',
        products: [
          {
            id: '01K00000000000000000000002',
            name: 'Cookie',
            description: 'Saved description',
            priceCents: 425,
            quantity: 18,
            active: true,
          },
        ],
        inventory: [],
        pickupDates: [],
      },
    }),
  );
  expect(html).toContain('Saved DRAFT');
  expect(html).toContain('$4.25');
  expect(html).toContain('18');
  expect(html).not.toMatch(/<button|<form|Add to Cart|Join waitlist/);
  expect(html).toContain('primary-horizontal.png');
});
