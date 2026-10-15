import assert from 'node:assert/strict';
import { test } from 'node:test';
import { weeklyDraftSchema } from '../src/weekly-draft';
import { drop, productId, dropId, fakeRepository } from './fixtures';
import { createHandler, type ApiEvent } from '../src/api';
import { ADMIN_GROUP } from '../src/admin-auth';
const input = {
  revision: drop.updatedAt,
  drop: { ...drop, status: 'DRAFT', opensAt: '2026-10-18T18:00:00.000Z' },
  products: [{ productId, priceCents: 429, inventoryTotal: 20 }],
  pickups: ['22', '23', '24'].map((day) => ({
    dropId,
    date: '2026-10-' + day,
    startTime: '16:00',
    endTime: '19:00',
    timezone: 'America/Denver',
    active: true,
  })),
};
test('weekly configuration preserves cents and accepts three pickup days', () => {
  assert.equal(weeklyDraftSchema.parse(input).products[0].priceCents, 429);
});
for (const [label, value] of Object.entries({
  duplicate: { ...input, products: [...input.products, ...input.products] },
  negative: {
    ...input,
    products: [{ productId, priceCents: -1, inventoryTotal: 20 }],
  },
  fractional: {
    ...input,
    products: [{ productId, priceCents: 429, inventoryTotal: 1.5 }],
  },
  long: { ...input, pickups: [{ ...input.pickups[0], endTime: '20:00' }] },
  wrongDate: {
    ...input,
    pickups: [{ ...input.pickups[0], date: '2026-10-21' }],
  },
  published: { ...input, drop: { ...input.drop, status: 'OPEN' } },
}))
  test('rejects ' + label, () =>
    assert.equal(weeklyDraftSchema.safeParse(value).success, false),
  );
for (const route of ['GET /admin/drops', 'PUT /admin/drops/{dropId}/draft'])
  test(route + ' requires administrator before repository access', async () => {
    const handler = createHandler(() => {
      throw Error('repository must not be reached');
    });
    const event: ApiEvent = {
      routeKey: route,
      body: JSON.stringify(input),
      pathParameters: { dropId },
      requestContext: {
        requestId: 'weekly',
        http: { method: route.split(' ')[0] },
      },
    };
    assert.equal((await handler(event)).statusCode, 401);
    event.requestContext.authorizer = {
      jwt: {
        claims: {
          token_use: 'access',
          sub: 'synthetic',
          username: 'synthetic',
          'cognito:groups': ['customer'],
        },
      },
    };
    assert.equal((await handler(event)).statusCode, 403);
  });
test('protected draft API forwards validated configuration', async () => {
  let saved = false;
  const handler = createHandler(() =>
    fakeRepository({
      saveWeeklyDraft: async (v) => {
        saved = true;
        return { ...v.drop, status: 'DRAFT' };
      },
    }),
  );
  const event: ApiEvent = {
    routeKey: 'PUT /admin/drops/{dropId}/draft',
    body: JSON.stringify(input),
    pathParameters: { dropId },
    requestContext: {
      requestId: 'weekly',
      http: { method: 'PUT' },
      authorizer: {
        jwt: {
          claims: {
            token_use: 'access',
            sub: 'synthetic',
            username: 'synthetic',
            'cognito:groups': [ADMIN_GROUP],
          },
        },
      },
    },
  };
  assert.equal((await handler(event)).statusCode, 200);
  assert(saved);
});
