import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHandler, type ApiEvent } from '../src/api';
import { adminWriteRoutes } from '../src/admin-writes';
import { ADMIN_GROUP } from '../src/admin-auth';
import { CatalogWriteError, type CatalogRepository } from '../src/repository';
import { idSchema, type Product, type Drop } from '../src/domain';
import { product, drop, fakeRepository } from './fixtures';
const productInput = {
  name: 'Updated cookie',
  slug: 'updated-cookie',
  description: 'New description',
  ingredients: ['Butter'],
  allergens: ['Milk'],
  active: false,
};
const dropInput = {
  name: 'New Drop',
  description: 'Draft',
  opensAt: '2099-10-01T18:00:00.000Z',
  quantityLimit: 6,
  timezone: 'America/Denver',
  pickupLocation: 'Example location',
  pickupInstructions: 'Collect here',
};
const draft: Drop = { ...drop, status: 'DRAFT' };
const claims = {
  token_use: 'access',
  sub: 'test-subject',
  username: 'test-admin',
  'cognito:groups': [ADMIN_GROUP],
};
function event(routeKey: string, input: unknown): ApiEvent {
  return {
    routeKey,
    body: JSON.stringify(input),
    pathParameters: { productId: product.productId, dropId: drop.dropId },
    requestContext: {
      requestId: 'write-test',
      http: { method: routeKey.split(' ')[0] },
      authorizer: { jwt: { claims } },
    },
  };
}
async function request(
  route: string,
  input: unknown,
  overrides: Partial<CatalogRepository> = {},
) {
  return createHandler(() => fakeRepository(overrides))(event(route, input));
}
for (const route of adminWriteRoutes) {
  test(`${route} authorizes before parsing or initializing repository`, async () => {
    for (const [patch, status] of [
      [undefined, 401],
      [{ ...claims, token_use: 'id' }, 403],
      [{ ...claims, 'cognito:groups': undefined }, 403],
      [{ ...claims, 'cognito:groups': ['wrong'] }, 403],
      [{ ...claims, sub: '' }, 401],
      [{ ...claims, username: '' }, 401],
    ] as const) {
      const input = event(route, { group: ADMIN_GROUP });
      input.requestContext.authorizer = patch
        ? { jwt: { claims: patch } }
        : undefined;
      const response = await createHandler(() => {
        throw new Error('Must not access repository');
      })(input);
      assert.equal(response.statusCode, status);
    }
  });
  test(`${route} rejects forbidden fields and malformed input before repository access`, async () => {
    const base = route.includes('products') ? productInput : dropInput;
    for (const input of [
      null,
      [],
      {},
      'text',
      { ...base, name: '' },
      ...[
        'PK',
        'SK',
        'productId',
        'dropId',
        'createdAt',
        'updatedAt',
        'status',
        'inventory',
        'pickupDates',
        'groups',
        'role',
        'unexpected',
      ].map((key) => ({ ...base, [key]: 'untrusted' })),
    ]) {
      const response = await createHandler(() => {
        throw new Error('Must not initialize');
      })(event(route, input));
      assert.equal(response.statusCode, 400, JSON.stringify(input));
      assert.equal(JSON.parse(response.body).code, 'VALIDATION_ERROR');
    }
    for (const body of [undefined, '{', '']) {
      const input = event(route, base);
      input.body = body;
      assert.equal(
        (
          await createHandler(() => {
            throw new Error('Must not initialize');
          })(input)
        ).statusCode,
        400,
      );
    }
  });
}
test('create Product generates identity and timestamps, returns explicit DTO with 201', async () => {
  let saved: Product | undefined;
  const before = Date.now();
  const response = await request('POST /admin/products', productInput, {
    createProduct: async (item) => {
      saved = item;
    },
  });
  assert.equal(response.statusCode, 201);
  assert.ok(saved);
  assert.equal(idSchema.parse(saved.productId), saved.productId);
  assert.ok(
    Date.parse(saved.createdAt) >= before &&
      Date.parse(saved.createdAt) <= Date.now(),
  );
  assert.equal(saved.createdAt, saved.updatedAt);
  assert.deepEqual(JSON.parse(response.body), { product: saved });
  assert.equal('PK' in JSON.parse(response.body).product, false);
  assert.equal('SK' in JSON.parse(response.body).product, false);
});
test('replace Product preserves identity and creation, advances timestamp and passes previous record', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse(product.updatedAt));
  const response = await request(
    'PUT /admin/products/{productId}',
    productInput,
    {
      replaceProduct: async (item, previous) => {
        assert.deepEqual(previous, product);
        assert.equal(item.productId, product.productId);
        assert.equal(item.createdAt, product.createdAt);
        assert.ok(Date.parse(item.updatedAt) > Date.parse(previous.updatedAt));
        assert.equal(item.name, productInput.name);
      },
    },
  );
  assert.equal(response.statusCode, 200);
});
test('missing Product is 404 and never upserts', async () => {
  const response = await request(
    'PUT /admin/products/{productId}',
    productInput,
    { getProduct: async () => undefined },
  );
  assert.equal(response.statusCode, 404);
  assert.equal(JSON.parse(response.body).code, 'PRODUCT_NOT_FOUND');
});
test('create Drop generates identity/timestamps and forces DRAFT without public storage fields', async () => {
  let saved: Drop | undefined;
  const before = Date.now();
  const response = await request('POST /admin/drops', dropInput, {
    createDraftDrop: async (item) => {
      saved = item;
    },
  });
  assert.equal(response.statusCode, 201);
  assert.ok(saved);
  assert.equal(saved.status, 'DRAFT');
  assert.equal(idSchema.parse(saved.dropId), saved.dropId);
  assert.equal(saved.createdAt, saved.updatedAt);
  assert.ok(
    Date.parse(saved.createdAt) >= before &&
      Date.parse(saved.createdAt) <= Date.now(),
  );
  assert.deepEqual(JSON.parse(response.body), { drop: saved });
  assert.equal('PK' in JSON.parse(response.body).drop, false);
  assert.equal('SK' in JSON.parse(response.body).drop, false);
});
test('DRAFT replacement preserves creation and status, removes omitted closesAt', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse(draft.updatedAt));
  const previous = { ...draft, closesAt: '2099-10-10T18:00:00.000Z' };
  const response = await request('PUT /admin/drops/{dropId}', dropInput, {
    getDrop: async () => previous,
    replaceDraftDrop: async (item, prior) => {
      assert.deepEqual(prior, previous);
      assert.equal(item.dropId, previous.dropId);
      assert.equal(item.createdAt, previous.createdAt);
      assert.ok(Date.parse(item.updatedAt) > Date.parse(previous.updatedAt));
      assert.equal(item.status, 'DRAFT');
      assert.equal(item.closesAt, undefined);
    },
  });
  assert.equal(response.statusCode, 200);
});
for (const status of [
  'SCHEDULED',
  'OPEN',
  'PAUSED',
  'SOLD_OUT',
  'CLOSED',
  'COMPLETED',
] as const) {
  test(`${status} Drop cannot be edited`, async () => {
    const response = await request('PUT /admin/drops/{dropId}', dropInput, {
      getDrop: async () => ({ ...drop, status }),
    });
    assert.equal(response.statusCode, 409);
    assert.equal(JSON.parse(response.body).code, 'DROP_NOT_EDITABLE');
  });
}
test('missing Drop is 404 and never upserts', async () => {
  const response = await request('PUT /admin/drops/{dropId}', dropInput, {
    getDrop: async () => undefined,
  });
  assert.equal(response.statusCode, 404);
  assert.equal(JSON.parse(response.body).code, 'DROP_NOT_FOUND');
});
test('complete domain validation rejects invalid Drop timing, timezone and quantity before writes', async () => {
  for (const route of ['POST /admin/drops', 'PUT /admin/drops/{dropId}']) {
    for (const patch of [
      { closesAt: dropInput.opensAt },
      { quantityLimit: 0 },
      { quantityLimit: '12' },
      { timezone: 'invalid-zone' },
      { opensAt: 'tomorrow' },
    ]) {
      assert.equal(
        (await request(route, { ...dropInput, ...patch })).statusCode,
        400,
      );
    }
  }
});
test('invalid Product field types and slug fail validation', async () => {
  for (const patch of [
    { active: 'true' },
    { ingredients: 'Butter' },
    { allergens: [1] },
    { slug: 'Bad Slug' },
  ]) {
    assert.equal(
      (await request('POST /admin/products', { ...productInput, ...patch }))
        .statusCode,
      400,
    );
  }
});
test('invalid update path IDs do not reach repository', async () => {
  for (const route of adminWriteRoutes.filter((route) =>
    route.startsWith('PUT'),
  )) {
    const input = event(
      route,
      route.includes('products') ? productInput : dropInput,
    );
    input.pathParameters = { productId: 'bad', dropId: 'bad' };
    assert.equal(
      (
        await createHandler(() => {
          throw new Error('Must not initialize');
        })(input)
      ).statusCode,
      400,
    );
  }
});
test('base64 JSON requests are supported', async () => {
  const input = event('POST /admin/products', productInput);
  input.body = Buffer.from(input.body!).toString('base64');
  input.isBase64Encoded = true;
  assert.equal(
    (
      await createHandler(() =>
        fakeRepository({ createProduct: async () => {} }),
      )(input)
    ).statusCode,
    201,
  );
});
for (const [route, operation, code, status] of [
  ['POST /admin/products', 'createProduct', 'PRODUCT_CONFLICT', 409],
  ['POST /admin/drops', 'createDraftDrop', 'DROP_CONFLICT', 409],
  [
    'PUT /admin/products/{productId}',
    'replaceProduct',
    'PRODUCT_CONFLICT',
    409,
  ],
  [
    'PUT /admin/products/{productId}',
    'replaceProduct',
    'PRODUCT_NOT_FOUND',
    404,
  ],
  ['PUT /admin/drops/{dropId}', 'replaceDraftDrop', 'DROP_CONFLICT', 409],
  ['PUT /admin/drops/{dropId}', 'replaceDraftDrop', 'DROP_NOT_FOUND', 404],
  ['PUT /admin/drops/{dropId}', 'replaceDraftDrop', 'DROP_NOT_EDITABLE', 409],
] as const) {
  test(`${route} maps ${code} safely`, async () => {
    const response = await request(
      route,
      route.includes('products') ? productInput : dropInput,
      {
        getDrop: async () => draft,
        [operation]: async () => {
          throw new CatalogWriteError(code);
        },
      },
    );
    assert.equal(response.statusCode, status);
    assert.equal(JSON.parse(response.body).code, code);
    assert.equal(JSON.parse(response.body).requestId, 'write-test');
  });
}
test('unexpected failures return generic 500 and log only event/request ID', async (t) => {
  const logs = t.mock.method(console, 'error', () => {});
  for (const route of adminWriteRoutes) {
    const response = await createHandler(() => {
      throw new Error('private-sdk-detail');
    })(event(route, route.includes('products') ? productInput : dropInput));
    assert.equal(response.statusCode, 500);
    assert.equal(response.body.includes('private-sdk-detail'), false);
  }
  assert.equal(logs.mock.callCount(), 4);
  for (const call of logs.mock.calls)
    assert.deepEqual(JSON.parse(call.arguments[0]), {
      event: 'admin_request_failed',
      requestId: 'write-test',
    });
});
test('no public writes, deletes, or out-of-scope admin operations exist', async () => {
  for (const route of [
    'POST /products',
    'PUT /drops/{dropId}',
    'DELETE /admin/products/{productId}',
    'DELETE /admin/drops/{dropId}',
    'PUT /admin/inventory',
    'PUT /admin/pickups',
    'PUT /admin/storefront',
  ]) {
    assert.equal((await request(route, {})).statusCode, 404);
  }
});
