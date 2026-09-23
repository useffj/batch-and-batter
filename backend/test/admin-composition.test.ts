import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHandler, type ApiEvent } from '../src/api';
import { compositionRoutes } from '../src/admin-composition';
import { ADMIN_GROUP } from '../src/admin-auth';
import { CatalogWriteError } from '../src/repository';
import {
  drop,
  relation,
  product,
  pickup,
  inventory,
  dropId,
  productId,
  fakeRepository,
} from './fixtures';
import { compositionStore, cancellation } from './composition-store';
import { catalogKeys } from '../src/keys';
const input = {
  priceCents: 450,
  cookieUnits: 1,
  displayOrder: 0,
  active: true,
  inventoryTotal: 100,
};
const pickupInput = {
  startTime: '16:00',
  endTime: '19:00',
  timezone: 'America/Denver',
  active: true,
};
const claims = {
  token_use: 'access',
  sub: 'synthetic-subject',
  username: 'synthetic-admin',
  'cognito:groups': [ADMIN_GROUP],
};
function event(route: string, body?: unknown): ApiEvent {
  return {
    routeKey: route,
    body: JSON.stringify(body),
    pathParameters: { dropId, productId, date: pickup.date },
    requestContext: {
      requestId: 'composition-test',
      http: { method: route.split(' ')[0] },
      authorizer: { jwt: { claims } },
    },
  };
}
function routeBody(route: string) {
  return route.includes('pickups')
    ? pickupInput
    : route.startsWith('POST')
      ? { ...input, productId }
      : input;
}
const [
  readRoute,
  attachRoute,
  replaceRoute,
  removeRoute,
  putPickupRoute,
  removePickupRoute,
] = compositionRoutes;
for (const route of compositionRoutes) {
  test(`${route} requires exact admin boundary before accessing data`, async () => {
    for (const [patch, status] of [
      [undefined, 401],
      [{ ...claims, token_use: 'id' }, 403],
      [{ ...claims, sub: '' }, 401],
      [{ ...claims, username: ' ' }, 401],
      [{ ...claims, 'cognito:groups': [] }, 403],
      [{ ...claims, 'cognito:groups': [`prefix-${ADMIN_GROUP}`] }, 403],
    ] as const) {
      const request = event(route, routeBody(route));
      request.requestContext.authorizer = patch
        ? { jwt: { claims: patch } }
        : undefined;
      const response = await createHandler(() => {
        throw new Error('Must not access data');
      })(request);
      assert.equal(response.statusCode, status);
    }
  });
  test(`${route} rejects invalid path and missing Drop`, async () => {
    const request = event(route, routeBody(route));
    request.pathParameters!.dropId = 'bad';
    assert.equal(
      (await createHandler(() => fakeRepository())(request)).statusCode,
      400,
    );
    const s = compositionStore();
    s.remove(catalogKeys.drop(dropId));
    const response = await createHandler(() => s.repository)(
      event(route, routeBody(route)),
    );
    assert.equal(response.statusCode, 404);
    assert.equal(JSON.parse(response.body).code, 'DROP_NOT_FOUND');
  });
}
test('admin reads complete DRAFT including inactive entries with explicit DTOs and no storage keys', async () => {
  const extra = { PK: 'private-key', SK: 'private-sort-key' };
  const draft = { ...drop, status: 'DRAFT' as const };
  const response = await createHandler(() =>
    fakeRepository({
      getDrop: async () => ({ ...draft, ...extra }),
      getProduct: async () => ({ ...product, active: false, ...extra }),
      getDropProducts: async () => [{ ...relation, active: false, ...extra }],
      getDropInventory: async () => [{ ...inventory, ...extra }],
      getPickupDates: async () => [{ ...pickup, active: false, ...extra }],
    }),
  )(event(readRoute));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    drop: draft,
    products: [
      {
        product: { ...product, active: false },
        dropProduct: { ...relation, active: false },
      },
    ],
    inventory: [{ ...inventory, available: 30 }],
    pickupDates: [{ ...pickup, active: false }],
  });
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.body.includes('PK'), false);
  assert.equal(response.body.includes('SK'), false);
});
test('admin composition explicitly reports missing Product and retains inventory', async () => {
  const response = await createHandler(() =>
    fakeRepository({ getProduct: async () => undefined }),
  )(event(readRoute));
  const result = JSON.parse(response.body);
  assert.equal(result.products[0].product, null);
  assert.deepEqual(result.inventory[0], { ...inventory, available: 30 });
});
for (const route of [attachRoute, replaceRoute, putPickupRoute]) {
  test(`${route} rejects unknown/server fields and malformed input before data access`, async () => {
    const base = routeBody(route);
    const forbidden = [
      'dropId',
      'PK',
      'SK',
      'reserved',
      'sold',
      'updatedAt',
      'total',
      'status',
      'date',
      'unexpected',
      ...(route === attachRoute ? [] : ['productId']),
    ];
    for (const body of [
      undefined,
      null,
      [],
      {},
      'text',
      ...forbidden.map((field) => ({ ...base, [field]: 'untrusted' })),
    ]) {
      const response = await createHandler(() => {
        throw new Error('Must not access data');
      })(event(route, body));
      assert.equal(response.statusCode, 400, JSON.stringify(body));
      assert.equal(JSON.parse(response.body).code, 'VALIDATION_ERROR');
    }
    for (const body of ['{', '', 'null']) {
      const request = event(route);
      request.body = body;
      assert.equal(
        (await createHandler(() => fakeRepository())(request)).statusCode,
        400,
      );
    }
  });
}
test('attach/replace validate numbers and types; PUT requires complete configuration', async () => {
  for (const route of [attachRoute, replaceRoute])
    for (const patch of [
      { inventoryTotal: -1 },
      { inventoryTotal: 0.5 },
      { inventoryTotal: Number.MAX_SAFE_INTEGER + 1 },
      { priceCents: -1 },
      { priceCents: '450' },
      { cookieUnits: 0 },
      { cookieUnits: 1.5 },
      { displayOrder: -1 },
      { active: 'true' },
      { priceCents: undefined },
    ])
      assert.equal(
        (
          await createHandler(() => {
            throw new Error('Must not access data');
          })(event(route, { ...routeBody(route), ...patch }))
        ).statusCode,
        400,
      );
});
test('API attach/update/remove returns matching inventory and preserves reusable Product', async () => {
  const s = compositionStore();
  const handler = createHandler(() => s.repository);
  const before = Date.now();
  let response = await handler(event(attachRoute, { ...input, productId }));
  assert.equal(response.statusCode, 201);
  let result = JSON.parse(response.body);
  assert.deepEqual(result.dropProduct, relation);
  assert.equal(result.inventory.reserved, 0);
  assert.equal(result.inventory.sold, 0);
  assert.equal(result.inventory.dropId, dropId);
  assert.equal(result.inventory.productId, productId);
  assert.ok(Date.parse(result.inventory.updatedAt) >= before);
  response = await handler(
    event(replaceRoute, {
      ...input,
      priceCents: 475,
      displayOrder: 1,
      inventoryTotal: 120,
    }),
  );
  assert.equal(response.statusCode, 200);
  result = JSON.parse(response.body);
  assert.equal(result.dropProduct.priceCents, 475);
  assert.equal(result.dropProduct.displayOrder, 1);
  assert.equal(result.inventory.total, 120);
  response = await handler(event(removeRoute));
  assert.equal(response.statusCode, 200);
  assert.equal(s.get(catalogKeys.dropProduct(dropId, productId)), undefined);
  assert.equal(s.get(catalogKeys.inventory(dropId, productId)), undefined);
  assert.ok(s.get(catalogKeys.product(productId)));
});
test('pickup API creates/replaces/removes its resource, supports base64 and advances META revision', async () => {
  const s = compositionStore();
  const handler = createHandler(() => s.repository);
  const meta = structuredClone(s.get(catalogKeys.drop(dropId)));
  const request = event(putPickupRoute, pickupInput);
  request.body = Buffer.from(request.body!).toString('base64');
  request.isBase64Encoded = true;
  let response = await handler(request);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { pickup });
  response = await handler(
    event(putPickupRoute, {
      ...pickupInput,
      startTime: '17:00',
      active: false,
    }),
  );
  assert.equal(JSON.parse(response.body).pickup.startTime, '17:00');
  const next = s.get(catalogKeys.drop(dropId))!;
  assert.ok(
    Date.parse(String(next.updatedAt)) > Date.parse(String(meta!.updatedAt)),
  );
  assert.deepEqual(next, { ...meta, updatedAt: next.updatedAt });
  assert.equal((await handler(event(removePickupRoute))).statusCode, 200);
  response = await handler(event(removePickupRoute));
  assert.equal(response.statusCode, 404);
  assert.equal(JSON.parse(response.body).code, 'PICKUP_NOT_FOUND');
});
test('pickup rejects impossible dates, malformed times, reversed windows and unknown timezone', async () => {
  for (const route of [putPickupRoute, removePickupRoute])
    for (const date of [
      '2026-02-30',
      '2026-13-01',
      '2026-2-01',
      'not-a-date',
    ]) {
      const request = event(route, pickupInput);
      request.pathParameters!.date = date;
      assert.equal(
        (await createHandler(() => fakeRepository())(request)).statusCode,
        400,
      );
    }
  for (const patch of [
    { startTime: '24:00' },
    { endTime: '19:60' },
    { startTime: '4:00' },
    { endTime: '16:00' },
    { endTime: '15:00' },
    { timezone: 'Invalid/Zone' },
  ])
    assert.equal(
      (
        await createHandler(() => fakeRepository())(
          event(putPickupRoute, { ...pickupInput, ...patch }),
        )
      ).statusCode,
      400,
    );
});
test('composition errors retain safe status/code/message/requestId contract', async () => {
  for (const code of [
    'DROP_NOT_FOUND',
    'PRODUCT_NOT_FOUND',
    'DROP_PRODUCT_NOT_FOUND',
    'PICKUP_NOT_FOUND',
    'DROP_NOT_EDITABLE',
    'DROP_PRODUCT_CONFLICT',
    'INVENTORY_NOT_EDITABLE',
    'COMPOSITION_CONFLICT',
  ] as const) {
    const response = await createHandler(() =>
      fakeRepository({
        attachDropProduct: async () => {
          throw new CatalogWriteError(code);
        },
      }),
    )(event(attachRoute, { ...input, productId }));
    assert.equal(response.statusCode, code.endsWith('NOT_FOUND') ? 404 : 409);
    assert.deepEqual(Object.keys(JSON.parse(response.body)).sort(), [
      'code',
      'message',
      'requestId',
    ]);
    assert.equal(JSON.parse(response.body).code, code);
    assert.equal(JSON.parse(response.body).requestId, 'composition-test');
  }
});
test('unexpected AWS errors return generic 500 and logs omit body/token/cancellation details', async (t) => {
  const logs = t.mock.method(console, 'error', () => {});
  const s = compositionStore();
  s.hooks.failure = cancellation(['None', 'None', 'ValidationError', 'None']);
  const response = await createHandler(() => s.repository)(
    event(attachRoute, { ...input, productId }),
  );
  assert.equal(response.statusCode, 500);
  assert.equal(response.body.includes('private'), false);
  assert.equal(JSON.parse(response.body).code, 'INTERNAL_ERROR');
  assert.equal(logs.mock.callCount(), 1);
  assert.deepEqual(JSON.parse(logs.mock.calls[0].arguments[0]), {
    event: 'admin_request_failed',
    requestId: 'composition-test',
  });
});
test('public routes remain anonymous and composed DRAFT stays invisible', async () => {
  const s = compositionStore();
  await s.repository.attachDropProduct(relation, 100);
  s.put({
    ...catalogKeys.storefront,
    storefrontDropId: dropId,
    updatedAt: drop.updatedAt,
  });
  for (const [route, status] of [
    ['GET /health', 200],
    ['GET /drops/current', 200],
    ['GET /drops/{dropId}', 404],
  ] as const) {
    const request = event(route);
    request.requestContext.authorizer = undefined;
    const response = await createHandler(() => s.repository)(request);
    assert.equal(response.statusCode, status);
    if (route === 'GET /drops/current')
      assert.deepEqual(JSON.parse(response.body), { drop: null });
  }
});
