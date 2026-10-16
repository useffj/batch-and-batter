import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolatedCatalog, isolatedRoutes } from '../src/isolated-catalog';
import type { ApiEvent } from '../src/api';
import type { CatalogRepository } from '../src/repository';
const event = (
  routeKey: string,
  claims?: Record<string, unknown>,
): ApiEvent => ({
  routeKey,
  requestContext: {
    requestId: 'synthetic',
    http: { method: routeKey.split(' ')[0] },
    authorizer: { jwt: { claims } },
  },
});
const claims = {
  sub: 'synthetic',
  username: 'synthetic',
  token_use: 'access',
  'cognito:groups': ['batch-and-batter-admins'],
};
test('isolated router denies every unapproved business route before repository access', async () => {
  const handler = isolatedCatalog(() => {
    throw Error('must not access');
  });
  for (const route of [
    'GET /drops/current',
    'GET /drops/{dropId}',
    'POST /carts',
    'POST /webhooks/stripe',
    'POST /admin/drops/{dropId}/publish',
    'POST /admin/products/{productId}/media',
    'POST /waitlists',
    'POST /admin/orders/{orderId}/refunds/authorize',
  ])
    assert.equal((await handler(event(route, claims))).statusCode, 404);
});
test('all isolated routes require admin access-token claims and private uncached responses', async () => {
  const handler = isolatedCatalog(() => {
    throw Error('must not access');
  });
  for (const route of isolatedRoutes) {
    for (const [identity, status] of [
      [undefined, 401],
      [{ ...claims, token_use: 'id' }, 403],
      [{ ...claims, 'cognito:groups': [] }, 403],
    ] as const) {
      const r = await handler(event(route, identity));
      assert.equal(r.statusCode, status);
      assert.equal(r.headers['cache-control'], 'no-store, private');
    }
  }
});
test('assignment never links isolated drafts to public storefront', async () => {
  const handler = isolatedCatalog(() => {
    throw Error('must not access');
  });
  assert.deepEqual(
    JSON.parse(
      (await handler(event('GET /admin/storefront/assignment', claims))).body,
    ),
    { dropId: null },
  );
});
test('preview refuses non-drafts without modifying the repository', async () => {
  const repo = {
    getDrop: async () => ({
      dropId: '01K00000000000000000000001',
      status: 'OPEN',
    }),
    getDropProducts: async () => [],
    getDropInventory: async () => [],
    getPickupDates: async () => [],
  } as unknown as CatalogRepository;
  const handler = isolatedCatalog(() => repo);
  assert.equal(
    (
      await handler({
        ...event('GET /admin/drops/{dropId}/preview', claims),
        pathParameters: { dropId: '01K00000000000000000000001' },
      })
    ).statusCode,
    409,
  );
});

test('missing or shared-table runtime configuration fails closed even for identity reads', async () => {
  const { handler } = await import('../src/isolated-catalog-handler');
  const previous = process.env.CATALOG_TABLE_NAME;
  try {
    process.env.CATALOG_TABLE_NAME = 'batch-and-batter-dev-catalog';
    assert.equal(
      (await handler(event('GET /admin/me', claims))).statusCode,
      503,
    );
  } finally {
    if (previous === undefined) delete process.env.CATALOG_TABLE_NAME;
    else process.env.CATALOG_TABLE_NAME = previous;
  }
});
