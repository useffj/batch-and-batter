import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHandler, type ApiEvent } from '../src/api';
import { composeDrop } from '../src/storefront';
import {
  drop,
  dropId,
  fakeRepository,
  inventory,
  otherProductId,
  pickup,
  product,
  relation,
} from './fixtures';
const event = (routeKey: string, id = dropId): ApiEvent => ({
  routeKey,
  pathParameters: { dropId: id },
  requestContext: { requestId: 'test-request', http: { method: 'GET' } },
});

test('health retains exact contract and never initializes the repository', async () => {
  const response = await createHandler(() => {
    throw new Error('Should not initialize');
  })(event('GET /health'));
  assert.deepEqual(response, {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: '{"status":"ok","service":"batch-and-batter-api"}',
  });
});
test('response mapping is an explicit public DTO including aggregate inventory', async () => {
  const response = await createHandler(() => fakeRepository())(
    event('GET /drops/{dropId}'),
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(response.body), {
    drop: {
      id: dropId,
      name: drop.name,
      description: drop.description,
      status: 'OPEN',
      opensAt: drop.opensAt,
      quantityLimit: 12,
      timezone: 'America/Denver',
      pickupLocation: drop.pickupLocation,
      pickupInstructions: drop.pickupInstructions,
      products: [
        {
          id: product.productId,
          name: product.name,
          slug: product.slug,
          description: product.description,
          ingredients: ['Flour'],
          allergens: ['Wheat'],
          priceCents: 450,
          cookieUnits: 1,
          displayOrder: 0,
          availability: { total: 100, reserved: 8, sold: 62, available: 30 },
        },
      ],
      pickupDates: [
        {
          date: pickup.date,
          startTime: '16:00',
          endTime: '19:00',
          timezone: 'America/Denver',
        },
      ],
    },
  });
});
test('inactive records are hidden and products/pickups are ordered deterministically', async () => {
  const repository = fakeRepository({
    getDropProducts: async () => [
      { ...relation, displayOrder: 2 },
      { ...relation, productId: otherProductId, displayOrder: 1 },
      { ...relation, active: false },
    ],
    getProduct: async (id) => ({ ...product, productId: id }),
    getDropInventory: async () => [
      inventory,
      { ...inventory, productId: otherProductId },
    ],
    getPickupDates: async () => [
      { ...pickup, date: '2026-10-03' },
      { ...pickup, active: false },
      { ...pickup, date: '2026-10-02' },
    ],
  });
  const response = await composeDrop(repository, drop);
  assert.deepEqual(
    response?.products.map((p) => p.id),
    [otherProductId, product.productId],
  );
  assert.deepEqual(
    response?.pickupDates.map((p) => p.date),
    ['2026-10-02', '2026-10-03'],
  );
  assert.deepEqual(
    (
      await composeDrop(
        fakeRepository({
          getProduct: async () => ({ ...product, active: false }),
        }),
        drop,
      )
    )?.products,
    [],
  );
});
test('no configured or dangling current Drop returns 200 with null', async () => {
  const response = await createHandler(() =>
    fakeRepository({ getStorefrontDrop: async () => undefined }),
  )(event('GET /drops/current'));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { drop: null });
});
for (const status of [
  'DRAFT',
  'COMPLETED',
  'SCHEDULED',
  'OPEN',
  'PAUSED',
  'SOLD_OUT',
  'CLOSED',
] as const) {
  test(`public routes handle ${status} explicitly`, async () => {
    let childReads = 0;
    const repository = fakeRepository({
      getDrop: async () => ({ ...drop, status }),
      getStorefrontDrop: async () => ({ ...drop, status }),
      getDropProducts: async () => {
        childReads++;
        return [relation];
      },
    });
    const handler = createHandler(() => repository);
    const direct = await handler(event('GET /drops/{dropId}'));
    const current = await handler(event('GET /drops/current'));
    if (['DRAFT', 'COMPLETED'].includes(status)) {
      assert.equal(direct.statusCode, 404);
      assert.deepEqual(JSON.parse(direct.body), {
        code: 'DROP_NOT_FOUND',
        message: 'Drop not found.',
        requestId: 'test-request',
      });
      assert.deepEqual(JSON.parse(current.body), { drop: null });
      assert.equal(childReads, 0);
    } else {
      assert.equal(direct.statusCode, 200);
      assert.equal(JSON.parse(current.body).drop.status, status);
    }
  });
}
test('missing Drop, invalid ID, unknown and write routes have safe consistent errors', async () => {
  const handler = createHandler(() =>
    fakeRepository({ getDrop: async () => undefined }),
  );
  assert.equal((await handler(event('GET /drops/{dropId}'))).statusCode, 404);
  assert.equal(
    (await handler(event('GET /drops/{dropId}', 'bad#id'))).statusCode,
    400,
  );
  assert.equal((await handler(event('POST /admin/drops'))).statusCode, 404);
  const write = event('GET /drops/current');
  write.requestContext.http.method = 'POST';
  assert.equal((await handler(write)).statusCode, 404);
});
test('repository failures and incomplete catalog do not leak internals or invent availability', async () => {
  for (const repository of [
    fakeRepository({
      getDrop: async () => {
        throw new Error('SECRET PK SK');
      },
    }),
    fakeRepository({ getProduct: async () => undefined }),
    fakeRepository({ getDropInventory: async () => [] }),
  ]) {
    const response = await createHandler(() => repository)(
      event('GET /drops/{dropId}'),
    );
    assert.equal(response.statusCode, 500);
    assert.deepEqual(JSON.parse(response.body), {
      code: 'INTERNAL_ERROR',
      message: 'Unable to load the Drop.',
      requestId: 'test-request',
    });
  }
});
