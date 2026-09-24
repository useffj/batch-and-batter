import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { CatalogWriteError } from '../src/repository';
import { createHandler as createHttpHandler, type ApiEvent } from '../src/api';
import { publishRoute } from '../src/admin-publish';
import { ADMIN_GROUP } from '../src/admin-auth';
import { updatedAt } from '../src/timestamps';
import { catalogKeys } from '../src/keys';
import {
  drop,
  product,
  relation,
  pickup,
  dropId,
  productId,
  otherProductId,
  fakeRepository,
} from './fixtures';
import { compositionStore, cancellation } from './composition-store';

// Publication contract tests stub only the external scheduling side effect.
const createHandler = (repository: Parameters<typeof createHttpHandler>[0]) =>
  createHttpHandler(repository, () => ({ ensure: async () => {} }));

const dropKey = catalogKeys.drop(dropId);
const relationKey = catalogKeys.dropProduct(dropId, productId);
const inventoryKey = catalogKeys.inventory(dropId, productId);
const productKey = catalogKeys.product(productId);
const pickupDate = '2099-10-08';
const pickupKey = catalogKeys.pickup(dropId, pickupDate);
const draft = {
  ...drop,
  status: 'DRAFT' as const,
  opensAt: '2099-10-05T18:00:00.000Z',
};
const claims = {
  token_use: 'access',
  sub: 'synthetic-subject',
  username: 'synthetic-admin',
  'cognito:groups': [ADMIN_GROUP],
};
const failure = (code: string) => (error: unknown) =>
  error instanceof CatalogWriteError && error.code === code;
function readyStore() {
  const s = compositionStore();
  s.put({ ...draft, ...dropKey });
  s.put({ ...relation, ...relationKey });
  s.put({
    dropId,
    productId,
    total: 100,
    reserved: 0,
    sold: 0,
    updatedAt: drop.updatedAt,
    ...inventoryKey,
  });
  s.put({ ...pickup, date: pickupDate, ...pickupKey });
  return s;
}
type Store = ReturnType<typeof readyStore>;
function event(body?: unknown): ApiEvent {
  return {
    routeKey: publishRoute,
    pathParameters: { dropId },
    body: body === undefined ? undefined : JSON.stringify(body),
    requestContext: {
      requestId: 'publish-test',
      http: { method: 'POST' },
      authorizer: { jwt: { claims } },
    },
  };
}
function patch(
  s: Store,
  key: { PK: string; SK: string },
  fields: Record<string, unknown>,
) {
  s.put({ ...s.get(key)!, ...fields });
}
const mutations = [
  (s: Store) =>
    s.repository.attachDropProduct(
      { ...relation, productId: otherProductId },
      10,
    ),
  (s: Store) =>
    s.repository.replaceDropProduct({ ...relation, priceCents: 475 }, 120),
  (s: Store) => s.repository.removeDropProduct(dropId, productId),
  (s: Store) => s.repository.putPickup({ ...pickup, date: pickupDate }),
  (s: Store) => s.repository.removePickup(dropId, pickupDate),
];
test('every composition operation rejects a concurrent DRAFT metadata/composition revision and preserves other records', async () => {
  for (const mutate of mutations) {
    const s = readyStore();
    s.put({
      ...product,
      productId: otherProductId,
      ...catalogKeys.product(otherProductId),
    });
    const concurrent = {
      ...s.get(dropKey)!,
      name: 'Concurrent metadata edit',
      updatedAt: updatedAt(draft.updatedAt),
    };
    s.hooks.beforeTransaction = () => s.put(concurrent);
    const before = structuredClone(s.items);
    before.set(`${dropKey.PK}/${dropKey.SK}`, concurrent);
    await assert.rejects(mutate(s), failure('COMPOSITION_CONFLICT'));
    assert.deepEqual(s.items, before);
  }
});
test('revision advances for each mutation even with fixed or regressing clock; metadata is preserved', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse(drop.updatedAt) - 1000);
  const s = readyStore();
  s.put({
    ...product,
    productId: otherProductId,
    ...catalogKeys.product(otherProductId),
  });
  for (const mutate of mutations) {
    const previous = structuredClone(s.get(dropKey))!;
    await mutate(s);
    const current = s.get(dropKey)!;
    assert.equal(
      Date.parse(String(current.updatedAt)),
      Date.parse(String(previous.updatedAt)) + 1,
    );
    assert.deepEqual(current, { ...previous, updatedAt: current.updatedAt });
  }
});
test('two overlapping composition edits cannot both overwrite the same Drop revision', async () => {
  const s = readyStore();
  const results = await Promise.allSettled([
    s.repository.replaceDropProduct({ ...relation, priceCents: 475 }, 120),
    s.repository.putPickup({ ...pickup, date: pickupDate, startTime: '17:00' }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const rejected = results.find((r) => r.status === 'rejected');
  assert.ok(
    rejected?.status === 'rejected' &&
      rejected.reason.code === 'COMPOSITION_CONFLICT',
  );
});
const notReadyCases: Array<[string, (s: Store) => void]> = [
  [
    'past opening',
    (s) => patch(s, dropKey, { opensAt: '2020-01-01T00:00:00.000Z' }),
  ],
  ['invalid closing', (s) => patch(s, dropKey, { closesAt: draft.opensAt })],
  [
    'no products',
    (s) => {
      s.remove(relationKey);
      s.remove(inventoryKey);
    },
  ],
  [
    'only inactive associations',
    (s) => patch(s, relationKey, { active: false }),
  ],
  ['inactive reusable Product', (s) => patch(s, productKey, { active: false })],
  ['zero price', (s) => patch(s, relationKey, { priceCents: 0 })],
  ['negative price', (s) => patch(s, relationKey, { priceCents: -1 })],
  ['zero cookie units', (s) => patch(s, relationKey, { cookieUnits: 0 })],
  ['zero inventory', (s) => patch(s, inventoryKey, { total: 0 })],
  ['reserved inventory', (s) => patch(s, inventoryKey, { reserved: 1 })],
  ['sold inventory', (s) => patch(s, inventoryKey, { sold: 1 })],
  [
    'missing reusable Product',
    (s) => {
      s.remove(productKey);
    },
  ],
  [
    'missing inventory',
    (s) => {
      s.remove(inventoryKey);
    },
  ],
  [
    'orphan inventory',
    (s) => {
      s.put({
        ...s.get(inventoryKey)!,
        productId: otherProductId,
        ...catalogKeys.inventory(dropId, otherProductId),
      });
    },
  ],
  [
    'no pickups',
    (s) => {
      s.remove(pickupKey);
    },
  ],
  ['no active pickups', (s) => patch(s, pickupKey, { active: false })],
  [
    'pickup before opening calendar date',
    (s) => {
      s.remove(pickupKey);
      s.put({
        ...pickup,
        date: '2099-10-04',
        ...catalogKeys.pickup(dropId, '2099-10-04'),
      });
    },
  ],
  [
    'invalid pickup calendar date',
    (s) => patch(s, pickupKey, { date: '2099-02-30' }),
  ],
  ['invalid pickup time', (s) => patch(s, pickupKey, { startTime: '25:00' })],
  ['pickup end before start', (s) => patch(s, pickupKey, { endTime: '15:00' })],
  [
    'invalid pickup timezone',
    (s) => patch(s, pickupKey, { timezone: 'Invalid/Zone' }),
  ],
];
for (const [name, corrupt] of notReadyCases)
  test(`readiness rejects ${name} without writing`, async () => {
    const s = readyStore();
    corrupt(s);
    const before = structuredClone(s.items);
    await assert.rejects(
      s.repository.publishDraft(dropId),
      failure('DROP_NOT_READY'),
    );
    assert.deepEqual(s.items, before);
    assert.equal(
      s.commands.some((command) => command instanceof TransactWriteCommand),
      false,
    );
  });
test('missing and all non-DRAFT Drops reject before transaction', async () => {
  for (const status of [
    undefined,
    'SCHEDULED',
    'OPEN',
    'PAUSED',
    'SOLD_OUT',
    'CLOSED',
    'COMPLETED',
  ]) {
    const s = readyStore();
    if (status) patch(s, dropKey, { status });
    else s.remove(dropKey);
    await assert.rejects(
      s.repository.publishDraft(dropId),
      failure(status ? 'DROP_NOT_EDITABLE' : 'DROP_NOT_FOUND'),
    );
    assert.equal(
      s.commands.some((command) => command instanceof TransactWriteCommand),
      false,
    );
  }
});
test('opening equal to validation time is not future', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse(draft.opensAt));
  const s = readyStore();
  await assert.rejects(
    s.repository.publishDraft(dropId),
    failure('DROP_NOT_READY'),
  );
});
test('pickup comparison uses Drop timezone calendar date rather than UTC or pickup timezone', async () => {
  const s = readyStore();
  patch(s, dropKey, {
    opensAt: '2099-10-05T01:00:00.000Z',
    timezone: 'America/Denver',
  });
  s.remove(pickupKey);
  s.put({
    ...pickup,
    date: '2099-10-04',
    timezone: 'Asia/Tokyo',
    ...catalogKeys.pickup(dropId, '2099-10-04'),
  });
  assert.equal(
    (await s.repository.publishDraft(dropId)).drop.status,
    'SCHEDULED',
  );
});
function addInactive(s: Store) {
  s.put({
    ...product,
    productId: otherProductId,
    active: false,
    ...catalogKeys.product(otherProductId),
  });
  s.put({
    ...relation,
    productId: otherProductId,
    active: false,
    priceCents: 0,
    ...catalogKeys.dropProduct(dropId, otherProductId),
  });
  s.put({
    ...s.get(inventoryKey)!,
    productId: otherProductId,
    total: 0,
    ...catalogKeys.inventory(dropId, otherProductId),
  });
  s.put({
    ...pickup,
    active: false,
    date: '2020-01-01',
    ...catalogKeys.pickup(dropId, '2020-01-01'),
  });
}
test('inactive associations/pickups need not be customer ready, but inactive Product references and inventory must exist', async () => {
  const valid = readyStore();
  addInactive(valid);
  await valid.repository.publishDraft(dropId);
  for (const key of [
    catalogKeys.product(otherProductId),
    catalogKeys.inventory(dropId, otherProductId),
  ]) {
    const s = readyStore();
    addInactive(s);
    s.remove(key);
    await assert.rejects(
      s.repository.publishDraft(dropId),
      failure('DROP_NOT_READY'),
    );
  }
});
test('successful publication uses exact revision/occupancy/Product conditions with unique Catalog keys and no redundant actions', async () => {
  const s = readyStore();
  const before = Date.now();
  const result = await s.repository.publishDraft(dropId);
  assert.equal(result.drop.status, 'SCHEDULED');
  assert.equal(result.drop.createdAt, draft.createdAt);
  assert.ok(Date.parse(result.drop.updatedAt) >= before);
  assert.ok(Date.parse(result.drop.updatedAt) > Date.parse(draft.updatedAt));
  assert.deepEqual(result.drop, {
    ...draft,
    status: 'SCHEDULED',
    updatedAt: result.drop.updatedAt,
  });
  assert.deepEqual(result.storefront, {
    storefrontDropId: dropId,
    updatedAt: result.drop.updatedAt,
  });
  assert.deepEqual(s.get(catalogKeys.storefront), {
    ...result.storefront,
    ...catalogKeys.storefront,
  });
  const commands = s.commands.filter(
    (command) => command instanceof TransactWriteCommand,
  );
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0].input.TransactItems, [
    {
      Put: {
        TableName: 'test-catalog',
        Item: { ...result.drop, ...dropKey },
        ConditionExpression:
          'attribute_exists(PK) AND #status = :draft AND #updated = :expected',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#updated': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':draft': 'DRAFT',
          ':expected': draft.updatedAt,
        },
      },
    },
    {
      Put: {
        TableName: 'test-catalog',
        Item: { ...result.storefront, ...catalogKeys.storefront },
        ConditionExpression:
          'attribute_not_exists(PK) OR #storefrontDropId = :dropId',
        ExpressionAttributeNames: { '#storefrontDropId': 'storefrontDropId' },
        ExpressionAttributeValues: { ':dropId': dropId },
      },
    },
    {
      ConditionCheck: {
        TableName: 'test-catalog',
        Key: productKey,
        ConditionExpression:
          'attribute_exists(PK) AND #active = :active AND #updated = :expected',
        ExpressionAttributeNames: {
          '#active': 'active',
          '#updated': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':active': true,
          ':expected': product.updatedAt,
        },
      },
    },
  ]);
  const count = s.commands.length;
  await assert.rejects(
    s.repository.publishDraft(dropId),
    failure('DROP_NOT_EDITABLE'),
  );
  assert.equal(s.commands.length, count + 1);
});
test('storefront permits absent or same assignment; another Drop or an empty existing config blocks both publication writes', async () => {
  for (const pointer of [dropId, otherProductId, undefined]) {
    const s = readyStore();
    s.put({
      ...catalogKeys.storefront,
      updatedAt: drop.updatedAt,
      ...(pointer ? { storefrontDropId: pointer } : {}),
    });
    const before = structuredClone(s.items);
    if (pointer === dropId) await s.repository.publishDraft(dropId);
    else {
      await assert.rejects(
        s.repository.publishDraft(dropId),
        failure('STOREFRONT_OCCUPIED'),
      );
      assert.deepEqual(s.items, before);
    }
  }
});
const publishRaces: Array<[string, string, (s: Store) => void]> = [
  [
    'Drop revision',
    'COMPOSITION_CONFLICT',
    (s) => patch(s, dropKey, { updatedAt: updatedAt(draft.updatedAt) }),
  ],
  [
    'Drop status',
    'DROP_NOT_EDITABLE',
    (s) => patch(s, dropKey, { status: 'SCHEDULED' }),
  ],
  [
    'Drop deletion',
    'DROP_NOT_FOUND',
    (s) => {
      s.remove(dropKey);
    },
  ],
  [
    'Product revision',
    'COMPOSITION_CONFLICT',
    (s) => patch(s, productKey, { updatedAt: updatedAt(product.updatedAt) }),
  ],
  [
    'Product active flag',
    'COMPOSITION_CONFLICT',
    (s) => patch(s, productKey, { active: false }),
  ],
  [
    'Product deletion',
    'COMPOSITION_CONFLICT',
    (s) => {
      s.remove(productKey);
    },
  ],
  [
    'storefront occupancy',
    'STOREFRONT_OCCUPIED',
    (s) => {
      s.put({
        ...catalogKeys.storefront,
        storefrontDropId: otherProductId,
        updatedAt: drop.updatedAt,
      });
    },
  ],
];
for (const [name, code, change] of publishRaces)
  test(`publication race: ${name} rejects atomically`, async () => {
    const s = readyStore();
    let expected = structuredClone(s.items);
    s.hooks.beforeTransaction = () => {
      change(s);
      expected = structuredClone(s.items);
    };
    await assert.rejects(s.repository.publishDraft(dropId), failure(code));
    assert.deepEqual(s.items, expected);
  });
test('an actual composition mutation during readiness reads invalidates the publication snapshot', async (t) => {
  const s = readyStore();
  const getProducts = s.repository.getDropProducts.bind(s.repository);
  t.mock.method(s.repository, 'getDropProducts', async (id: string) => {
    const items = await getProducts(id);
    await s.repository.putPickup({
      ...pickup,
      date: pickupDate,
      active: false,
    });
    return items;
  });
  await assert.rejects(
    s.repository.publishDraft(dropId),
    (error) =>
      error instanceof CatalogWriteError &&
      ['DROP_NOT_READY', 'COMPOSITION_CONFLICT'].includes(error.code),
  );
  assert.equal(s.get(dropKey)!.status, 'DRAFT');
  assert.equal(s.get(catalogKeys.storefront), undefined);
});
test('inactive reusable Product is also guarded against changes', async () => {
  const s = readyStore();
  addInactive(s);
  s.hooks.beforeTransaction = () =>
    patch(s, catalogKeys.product(otherProductId), {
      updatedAt: updatedAt(product.updatedAt),
    });
  await assert.rejects(
    s.repository.publishDraft(dropId),
    failure('COMPOSITION_CONFLICT'),
  );
  assert.equal(s.get(dropKey)!.status, 'DRAFT');
});
test('100 actions are supported; 101 actions are rejected before sending', async () => {
  for (const count of [98, 99]) {
    const s = readyStore();
    for (let i = 1; i < count; i++) {
      const id = '01K5J2' + String(i).padStart(20, '0');
      s.put({ ...product, productId: id, ...catalogKeys.product(id) });
      s.put({
        ...relation,
        productId: id,
        ...catalogKeys.dropProduct(dropId, id),
      });
      s.put({
        ...s.get(inventoryKey)!,
        productId: id,
        ...catalogKeys.inventory(dropId, id),
      });
    }
    if (count === 98) {
      await s.repository.publishDraft(dropId);
      const transaction = s.commands.find(
        (command) => command instanceof TransactWriteCommand,
      ) as TransactWriteCommand;
      assert.equal(transaction.input.TransactItems!.length, 100);
    } else {
      await assert.rejects(
        s.repository.publishDraft(dropId),
        failure('DROP_NOT_READY'),
      );
      assert.equal(
        s.commands.some((command) => command instanceof TransactWriteCommand),
        false,
      );
    }
  }
});
test('publish uses existing admin boundary before parsing or accessing repository', async () => {
  for (const [auth, status] of [
    [undefined, 401],
    [{ ...claims, token_use: 'id' }, 403],
    [{ ...claims, sub: '' }, 401],
    [{ ...claims, username: ' ' }, 401],
    [{ ...claims, 'cognito:groups': [] }, 403],
    [{ ...claims, 'cognito:groups': ['prefix-' + ADMIN_GROUP] }, 403],
  ] as const) {
    const request = event({ status: 'SCHEDULED' });
    request.requestContext.authorizer = auth
      ? { jwt: { claims: auth } }
      : undefined;
    assert.equal(
      (
        await createHandler(() => {
          throw new Error('Must not access');
        })(request)
      ).statusCode,
      status,
    );
  }
});
test('publish accepts no body or empty object; rejects overrides, malformed bodies and invalid path', async () => {
  for (const body of [undefined, {}]) {
    const s = readyStore();
    const response = await createHandler(() => s.repository)(event(body));
    assert.equal(response.statusCode, 200);
    const data = JSON.parse(response.body);
    const publicationTimestamp = s.get(dropKey)!.updatedAt;
    assert.ok(typeof publicationTimestamp === 'string');
    assert.deepEqual(data, {
      drop: { ...draft, status: 'SCHEDULED', updatedAt: publicationTimestamp },
      storefront: { storefrontDropId: dropId, updatedAt: publicationTimestamp },
    });
    assert.ok(Date.parse(data.drop.updatedAt) > Date.parse(draft.updatedAt));
    assert.equal(
      data.storefront.updatedAt,
      s.get(catalogKeys.storefront)!.updatedAt,
    );
    assert.ok(
      s.commands.at(-1) instanceof TransactWriteCommand,
      'Response must not perform post-publication reads or writes',
    );
  }
  for (const body of [
    null,
    [],
    '',
    0,
    true,
    ...[
      'status',
      'storefrontDropId',
      'opensAt',
      'dropId',
      'productId',
      'updatedAt',
      'createdAt',
      'PK',
      'SK',
    ].map((field) => ({ [field]: 'untrusted' })),
  ]) {
    assert.equal(
      (
        await createHandler(() => {
          throw new Error('Must not access');
        })(event(body))
      ).statusCode,
      400,
    );
  }
  const request = event();
  request.body = '{';
  assert.equal(
    (await createHandler(() => fakeRepository())(request)).statusCode,
    400,
  );
  request.body = undefined;
  request.pathParameters!.dropId = 'bad';
  assert.equal(
    (await createHandler(() => fakeRepository())(request)).statusCode,
    400,
  );
  const encoded = event({});
  encoded.isBase64Encoded = true;
  encoded.body = Buffer.from(encoded.body!).toString('base64');
  assert.equal(
    (await createHandler(() => readyStore().repository)(encoded)).statusCode,
    200,
  );
});
test('expected errors retain the API contract; unexpected service cancellations remain safe 500', async (t) => {
  for (const code of [
    'DROP_NOT_FOUND',
    'DROP_NOT_EDITABLE',
    'DROP_NOT_READY',
    'COMPOSITION_CONFLICT',
    'STOREFRONT_OCCUPIED',
  ] as const) {
    const response = await createHandler(() =>
      fakeRepository({
        publishDraft: async () => {
          throw new CatalogWriteError(code);
        },
      }),
    )(event());
    assert.equal(response.statusCode, code === 'DROP_NOT_FOUND' ? 404 : 409);
    assert.equal(JSON.parse(response.body).code, code);
    assert.equal(JSON.parse(response.body).requestId, 'publish-test');
  }
  const logs = t.mock.method(console, 'error', () => {});
  const s = readyStore();
  s.hooks.failure = cancellation(['None', 'None', 'ValidationError']);
  const response = await createHandler(() => s.repository)(event());
  assert.equal(response.statusCode, 500);
  assert.equal(response.body.includes('private'), false);
  assert.deepEqual(JSON.parse(logs.mock.calls[0].arguments[0]), {
    event: 'request.completed',
    requestId: 'publish-test',
    routeKey: 'POST /admin/drops/{dropId}/publish',
    operation: 'publishDrop',
    statusCode: 500,
    code: 'INTERNAL_ERROR',
  });
});
test('public routes remain anonymous; DRAFT is hidden and published SCHEDULED is visible without opening', async () => {
  const s = readyStore();
  const handler = createHandler(() => s.repository);
  const publicEvent = (route: string): ApiEvent => ({
    routeKey: route,
    pathParameters: { dropId },
    requestContext: { requestId: 'public', http: { method: 'GET' } },
  });
  assert.equal((await handler(publicEvent('GET /health'))).statusCode, 200);
  assert.equal(
    (await handler(publicEvent('GET /drops/{dropId}'))).statusCode,
    404,
  );
  assert.deepEqual(
    JSON.parse((await handler(publicEvent('GET /drops/current'))).body),
    { drop: null },
  );
  await s.repository.publishDraft(dropId);
  for (const route of ['GET /drops/current', 'GET /drops/{dropId}']) {
    const response = await handler(publicEvent(route));
    assert.equal(response.statusCode, 200);
    const data = JSON.parse(response.body);
    assert.deepEqual(Object.keys(data), ['drop']);
    assert.equal(data.drop.status, 'SCHEDULED');
    assert.equal(data.drop.id, dropId);
    assert.equal('dropId' in data.drop, false);
    assert.ok(Array.isArray(data.drop.products));
    assert.ok(Array.isArray(data.drop.pickupDates));
  }
});

test('each real composition mutation after readiness validation prevents stale publication', async () => {
  for (const mutate of mutations) {
    const s = readyStore();
    s.put({
      ...product,
      productId: otherProductId,
      ...catalogKeys.product(otherProductId),
    });
    let committed = structuredClone(s.items);
    s.hooks.beforeTransaction = async () => {
      s.hooks.beforeTransaction = () => {};
      await mutate(s);
      committed = structuredClone(s.items);
    };
    await assert.rejects(
      s.repository.publishDraft(dropId),
      failure('COMPOSITION_CONFLICT'),
    );
    assert.deepEqual(s.items, committed);
    assert.equal(s.get(dropKey)!.status, 'DRAFT');
    assert.equal(s.get(catalogKeys.storefront), undefined);
  }
});
test('publication winning after a composition read prevents every stale composition commit', async () => {
  for (const mutate of mutations) {
    const s = readyStore();
    s.put({
      ...product,
      productId: otherProductId,
      ...catalogKeys.product(otherProductId),
    });
    let published = structuredClone(s.items);
    s.hooks.beforeTransaction = async () => {
      s.hooks.beforeTransaction = () => {};
      await s.repository.publishDraft(dropId);
      published = structuredClone(s.items);
    };
    await assert.rejects(mutate(s), failure('DROP_NOT_EDITABLE'));
    assert.deepEqual(s.items, published);
    assert.equal(s.get(dropKey)!.status, 'SCHEDULED');
  }
});
test('publication cancellation mappings use deterministic action precedence', async () => {
  for (const [codes, expected] of [
    [
      [
        'ConditionalCheckFailed',
        'ConditionalCheckFailed',
        'ConditionalCheckFailed',
      ],
      'COMPOSITION_CONFLICT',
    ],
    [
      ['None', 'ConditionalCheckFailed', 'ConditionalCheckFailed'],
      'STOREFRONT_OCCUPIED',
    ],
    [['None', 'None', 'ConditionalCheckFailed'], 'COMPOSITION_CONFLICT'],
    [['TransactionConflict', 'None', 'None'], 'COMPOSITION_CONFLICT'],
  ] as const) {
    const s = readyStore();
    s.hooks.failure = cancellation([...codes]);
    const before = structuredClone(s.items);
    await assert.rejects(s.repository.publishDraft(dropId), failure(expected));
    assert.deepEqual(s.items, before);
  }
});

test('publish HTTP response explicitly selects admin fields and authoritative result timestamps, preserving optional closesAt', async () => {
  const publicationTimestamp = '2026-09-24T12:34:56.789Z';
  for (const closesAt of [undefined, '2099-10-06T18:00:00.000Z']) {
    const expectedDrop = {
      ...draft,
      status: 'SCHEDULED' as const,
      updatedAt: publicationTimestamp,
      ...(closesAt ? { closesAt } : {}),
    };
    const expectedStorefront = {
      storefrontDropId: dropId,
      updatedAt: publicationTimestamp,
    };
    let publishCalls = 0;
    const repository = fakeRepository({
      publishDraft: async (id) => {
        assert.equal(id, dropId);
        publishCalls++;
        // Deliberately contaminated result detects accidental raw-item serialization.
        return {
          drop: {
            ...expectedDrop,
            PK: 'private',
            SK: 'META',
            id: 'public-id',
            products: [],
            pickupDates: [],
            availability: {},
            $metadata: {},
          },
          storefront: {
            ...expectedStorefront,
            PK: 'STORE#CONFIG',
            SK: 'STOREFRONT',
            $metadata: {},
          },
        };
      },
    });
    const onlyPublish = new Proxy(repository, {
      get(target, property, receiver) {
        assert.equal(
          property,
          'publishDraft',
          'Response construction must not read or write again',
        );
        return Reflect.get(target, property, receiver);
      },
    });
    const response = await createHandler(() => onlyPublish)(event());
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), {
      drop: expectedDrop,
      storefront: expectedStorefront,
    });
    assert.equal(publishCalls, 1);
  }
});
