import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { createHandler, type ApiEvent } from '../src/api';
import { openRoute } from '../src/admin-open';
import { ADMIN_GROUP } from '../src/admin-auth';
import { CatalogWriteError } from '../src/repository';
import { dropStatusSchema } from '../src/domain';
import { isOpenReady } from '../src/open-readiness';
import { catalogKeys } from '../src/keys';
import { compositionStore, cancellation } from './composition-store';
import {
  drop,
  dropId,
  product,
  productId,
  otherProductId,
  relation,
  inventory,
  pickup,
  fakeRepository,
} from './fixtures';

const dropKey = catalogKeys.drop(dropId);
const relationKey = catalogKeys.dropProduct(dropId, productId);
const inventoryKey = catalogKeys.inventory(dropId, productId);
const productKey = catalogKeys.product(productId);
const pickupKey = catalogKeys.pickup(dropId, pickup.date);
const scheduled = { ...drop, status: 'SCHEDULED' as const };
const openingTime = Date.parse(scheduled.opensAt);
const claims = {
  token_use: 'access',
  sub: 'synthetic-admin',
  username: 'synthetic-name',
  'cognito:groups': [ADMIN_GROUP],
};
const fails = (code: string) => (error: unknown) =>
  error instanceof CatalogWriteError && error.code === code;
function readyStore() {
  const s = compositionStore();
  for (const item of [
    { ...scheduled, ...dropKey },
    { ...relation, ...relationKey },
    { ...inventory, ...inventoryKey },
    { ...pickup, ...pickupKey },
    {
      storefrontDropId: dropId,
      updatedAt: drop.updatedAt,
      ...catalogKeys.storefront,
    },
  ])
    s.put(item);
  return s;
}
type Store = ReturnType<typeof readyStore>;
function patch(
  s: Store,
  key: { PK: string; SK: string },
  fields: Record<string, unknown>,
) {
  s.put({ ...s.get(key)!, ...fields });
}
function event(body?: unknown): ApiEvent {
  return {
    routeKey: openRoute,
    pathParameters: { dropId },
    body: body === undefined ? undefined : JSON.stringify(body),
    requestContext: {
      requestId: 'open-request',
      http: { method: 'POST' },
      authorizer: { jwt: { claims } },
    },
  };
}
const transactions = (s: Store) =>
  s.commands.filter((c) => c instanceof TransactWriteCommand);

test('opening performs one exact conditional transaction and changes only Drop status/revision', async (t) => {
  t.mock.method(Date, 'now', () => openingTime);
  const s = readyStore();
  const before = structuredClone(s.items);
  const opened = await s.repository.openScheduled(dropId);
  assert.deepEqual(opened, {
    ...scheduled,
    status: 'OPEN',
    updatedAt: new Date(openingTime + 1).toISOString(),
  });
  const txs = transactions(s);
  assert.equal(txs.length, 1);
  const actions = txs[0].input.TransactItems!;
  assert.deepEqual(actions, [
    {
      Put: {
        TableName: 'test-catalog',
        Item: { ...opened, ...dropKey },
        ConditionExpression:
          'attribute_exists(PK) AND #status = :scheduled AND #updated = :expected',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#updated': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':scheduled': 'SCHEDULED',
          ':expected': scheduled.updatedAt,
        },
      },
    },
    {
      ConditionCheck: {
        TableName: 'test-catalog',
        Key: catalogKeys.storefront,
        ConditionExpression: '#storefrontDropId = :dropId',
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
  assert.ok(s.commands[0] instanceof GetCommand);
  assert.deepEqual(s.commands[0].input.Key, dropKey);
  for (const command of s.commands)
    if (command instanceof GetCommand || command instanceof QueryCommand)
      assert.equal(command.input.ConsistentRead, true);
  before.set(`${dropKey.PK}/${dropKey.SK}`, { ...opened, ...dropKey });
  assert.deepEqual(s.items, before);
  assert.equal(
    s.commands.at(-1),
    txs[0],
    'No post-commit read or second write',
  );
  await assert.rejects(
    s.repository.openScheduled(dropId),
    fails('DROP_NOT_EDITABLE'),
  );
  assert.equal(transactions(s).length, 1);
});

for (const status of dropStatusSchema.options.filter(
  (s) => s !== 'SCHEDULED',
)) {
  test(`opening rejects ${status} without a transaction`, async () => {
    const s = readyStore();
    patch(s, dropKey, { status });
    await assert.rejects(
      s.repository.openScheduled(dropId),
      fails('DROP_NOT_EDITABLE'),
    );
    assert.equal(transactions(s).length, 0);
  });
}
test('missing Drop produces DROP_NOT_FOUND without a transaction', async () => {
  const s = readyStore();
  s.remove(dropKey);
  await assert.rejects(
    s.repository.openScheduled(dropId),
    fails('DROP_NOT_FOUND'),
  );
  assert.equal(transactions(s).length, 0);
});
for (const delta of [-1, 0, 1]) {
  test(`server time ${delta}ms relative to opensAt controls opening`, async (t) => {
    t.mock.method(Date, 'now', () => openingTime + delta);
    const s = readyStore();
    if (delta < 0) {
      await assert.rejects(
        s.repository.openScheduled(dropId),
        fails('DROP_NOT_READY'),
      );
      assert.equal(transactions(s).length, 0);
    } else
      assert.equal((await s.repository.openScheduled(dropId)).status, 'OPEN');
  });
}
test('opensAt may pass during readiness reads; a future revision cannot authorize early opening', async (t) => {
  let now = openingTime - 1;
  t.mock.method(Date, 'now', () => now);
  const s = readyStore();
  const readProduct = s.repository.getProduct.bind(s.repository);
  s.repository.getProduct = async (id) => {
    const value = await readProduct(id);
    now = openingTime;
    return value;
  };
  assert.equal((await s.repository.openScheduled(dropId)).status, 'OPEN');
  const early = readyStore();
  patch(early, dropKey, { updatedAt: '2099-01-01T00:00:00.000Z' });
  now = openingTime - 1;
  await assert.rejects(
    early.repository.openScheduled(dropId),
    fails('DROP_NOT_READY'),
  );
  now = openingTime;
  assert.equal(
    (await early.repository.openScheduled(dropId)).updatedAt,
    '2099-01-01T00:00:00.001Z',
  );
});

for (const [label, mutate] of [
  ['missing', (s: Store) => s.remove(catalogKeys.storefront)],
  [
    'unset',
    (s: Store) =>
      s.put({ updatedAt: drop.updatedAt, ...catalogKeys.storefront }),
  ],
  [
    'different',
    (s: Store) =>
      patch(s, catalogKeys.storefront, { storefrontDropId: otherProductId }),
  ],
] as const) {
  test(`storefront ${label} is rejected before writing and at the transactional race boundary`, async () => {
    for (const race of [false, true]) {
      const s = readyStore();
      if (race)
        s.hooks.beforeTransaction = () => {
          mutate(s);
        };
      else mutate(s);
      await assert.rejects(
        s.repository.openScheduled(dropId),
        fails('STOREFRONT_CONFLICT'),
      );
      assert.deepEqual(s.get(dropKey), { ...scheduled, ...dropKey });
      assert.equal(transactions(s).length, race ? 1 : 0);
    }
  });
}
for (const [label, mutate, code] of [
  [
    'revision',
    (s: Store) =>
      patch(s, dropKey, {
        name: 'Concurrent edit',
        updatedAt: '2026-09-23T00:00:00.000Z',
      }),
    'COMPOSITION_CONFLICT',
  ],
  [
    'status',
    (s: Store) => patch(s, dropKey, { status: 'OPEN' }),
    'DROP_NOT_EDITABLE',
  ],
  ['deletion', (s: Store) => s.remove(dropKey), 'DROP_NOT_FOUND'],
  [
    'Product revision',
    (s: Store) =>
      patch(s, productKey, {
        name: 'Changed cookie',
        updatedAt: '2026-09-23T00:00:00.000Z',
      }),
    'COMPOSITION_CONFLICT',
  ],
  [
    'Product active state',
    (s: Store) => patch(s, productKey, { active: false }),
    'COMPOSITION_CONFLICT',
  ],
  [
    'Product deletion',
    (s: Store) => s.remove(productKey),
    'COMPOSITION_CONFLICT',
  ],
] as const) {
  test(`concurrent ${label} blocks the entire opening transaction`, async () => {
    const s = readyStore();
    let afterRace: typeof s.items;
    s.hooks.beforeTransaction = () => {
      mutate(s);
      afterRace = structuredClone(s.items);
    };
    await assert.rejects(s.repository.openScheduled(dropId), fails(code));
    assert.deepEqual(s.items, afterRace!);
    assert.equal(transactions(s).length, 1);
    if (label === 'revision' || label === 'status' || label === 'deletion') {
      assert.ok(s.commands.at(-1) instanceof GetCommand);
      assert.deepEqual((s.commands.at(-1) as GetCommand).input.Key, dropKey);
    }
  });
}
test('two concurrent opening attempts commit exactly once', async () => {
  const s = readyStore();
  s.hooks.beforeTransaction = async () => {
    s.hooks.beforeTransaction = () => {};
    assert.equal((await s.repository.openScheduled(dropId)).status, 'OPEN');
  };
  await assert.rejects(
    s.repository.openScheduled(dropId),
    fails('DROP_NOT_EDITABLE'),
  );
  assert.equal(s.get(dropKey)!.status, 'OPEN');
  assert.equal(transactions(s).length, 2);
});

for (const [label, mutate] of [
  [
    'no active products',
    (s: Store) => patch(s, relationKey, { active: false }),
  ],
  ['no active pickups', (s: Store) => patch(s, pickupKey, { active: false })],
  ['missing active inventory', (s: Store) => s.remove(inventoryKey)],
  [
    'zero active total',
    (s: Store) => patch(s, inventoryKey, { total: 0, reserved: 0, sold: 0 }),
  ],
  [
    'invalid reserved/sold',
    (s: Store) => patch(s, inventoryKey, { reserved: 101 }),
  ],
  ['negative stock', (s: Store) => patch(s, inventoryKey, { sold: -1 })],
  ['invalid pickup', (s: Store) => patch(s, pickupKey, { endTime: '00:00' })],
  ['invalid Drop', (s: Store) => patch(s, dropKey, { opensAt: 'invalid' })],
  ['inactive Product', (s: Store) => patch(s, productKey, { active: false })],
  ['missing Product', (s: Store) => s.remove(productKey)],
  ['invalid Product', (s: Store) => patch(s, productKey, { name: '' })],
  ['zero price', (s: Store) => patch(s, relationKey, { priceCents: 0 })],
] as const) {
  test(`opening readiness rejects ${label} without writing`, async () => {
    const s = readyStore();
    mutate(s);
    const before = structuredClone(s.items);
    await assert.rejects(
      s.repository.openScheduled(dropId),
      fails('DROP_NOT_READY'),
    );
    assert.deepEqual(s.items, before);
    assert.equal(transactions(s).length, 0);
  });
}
test('opening validates current Product state rather than publication-time metadata', async () => {
  const s = readyStore();
  patch(s, productKey, {
    name: 'Currently valid name',
    updatedAt: '2026-09-23T00:00:00.000Z',
  });
  await s.repository.openScheduled(dropId);
  assert.equal(
    transactions(s)[0].input.TransactItems![2].ConditionCheck!
      .ExpressionAttributeValues![':expected'],
    '2026-09-23T00:00:00.000Z',
  );
});
test('inactive associations need no Product reads or checks; valid reserved/sold counts are preserved', async () => {
  const s = readyStore();
  s.put({
    ...relation,
    active: false,
    productId: otherProductId,
    ...catalogKeys.dropProduct(dropId, otherProductId),
  });
  s.put({
    ...inventory,
    productId: otherProductId,
    ...catalogKeys.inventory(dropId, otherProductId),
  });
  await s.repository.openScheduled(dropId);
  assert.equal(transactions(s)[0].input.TransactItems!.length, 3);
  assert.equal(
    s.commands.some(
      (c) =>
        c instanceof GetCommand &&
        c.input.Key!.PK === catalogKeys.product(otherProductId).PK,
    ),
    false,
  );
  assert.deepEqual(s.get(inventoryKey), { ...inventory, ...inventoryKey });
});
test('readiness rejects duplicate identities and misaligned relationships', () => {
  const snapshot = {
    drop: scheduled,
    relations: [relation],
    inventories: [inventory],
    pickups: [pickup],
    products: [product],
  };
  assert.equal(isOpenReady(snapshot, openingTime), true);
  for (const invalid of [
    { ...snapshot, relations: [relation, relation] },
    { ...snapshot, inventories: [inventory, inventory] },
    { ...snapshot, pickups: [pickup, pickup] },
    { ...snapshot, products: [product, product] },
    { ...snapshot, products: [{ ...product, productId: otherProductId }] },
    { ...snapshot, relations: [{ ...relation, dropId: otherProductId }] },
    { ...snapshot, inventories: [{ ...inventory, productId: otherProductId }] },
    { ...snapshot, pickups: [{ ...pickup, dropId: otherProductId }] },
  ])
    assert.equal(isOpenReady(invalid, openingTime), false);
});
for (const count of [98, 99]) {
  test(`${count} active Products enforce the 100-action transaction limit`, async () => {
    const s = readyStore();
    for (let i = 1; i < count; i++) {
      const id = `01K5J1${String(i + 10).padStart(20, '0')}`;
      s.put({ ...product, productId: id, ...catalogKeys.product(id) });
      s.put({
        ...relation,
        productId: id,
        ...catalogKeys.dropProduct(dropId, id),
      });
      s.put({
        ...inventory,
        productId: id,
        ...catalogKeys.inventory(dropId, id),
      });
    }
    if (count === 99) {
      await assert.rejects(
        s.repository.openScheduled(dropId),
        fails('DROP_NOT_READY'),
      );
      assert.equal(transactions(s).length, 0);
    } else {
      await s.repository.openScheduled(dropId);
      const actions = transactions(s)[0].input.TransactItems!;
      assert.equal(actions.length, 100);
      const keys = actions.map((a) => a.Put?.Item ?? a.ConditionCheck!.Key!);
      assert.equal(
        new Set(keys.map((k) => `${k.PK}/${k.SK}`)).size,
        actions.length,
      );
    }
  });
}

test('supported composition and metadata writers cannot change SCHEDULED or OPEN Drops', async () => {
  for (const opened of [false, true]) {
    const s = readyStore();
    if (opened) await s.repository.openScheduled(dropId);
    const before = structuredClone(s.items);
    const operations = [
      () =>
        s.repository.attachDropProduct(
          { ...relation, productId: otherProductId },
          10,
        ),
      () => s.repository.replaceDropProduct(relation, 10),
      () => s.repository.removeDropProduct(dropId, productId),
      () => s.repository.putPickup(pickup),
      () => s.repository.removePickup(dropId, pickup.date),
      () =>
        s.repository.replaceDraftDrop(
          { ...scheduled, updatedAt: '2026-09-25T00:00:00.000Z' },
          scheduled,
        ),
    ];
    for (const operation of operations)
      await assert.rejects(operation(), fails('DROP_NOT_EDITABLE'));
    assert.deepEqual(s.items, before);
  }
});

test('opening authorizes before parsing input or accessing the repository', async () => {
  for (const [identity, status] of [
    [undefined, 401],
    [{ ...claims, 'cognito:groups': ['not-admin'] }, 403],
    [{ ...claims, token_use: 'id' }, 403],
    [{ ...claims, 'cognito:groups': [`prefix-${ADMIN_GROUP}`] }, 403],
  ] as const) {
    const request = event({ force: true });
    request.requestContext.authorizer = identity
      ? { jwt: { claims: identity } }
      : undefined;
    const response = await createHandler(() => {
      throw new Error('must not initialize');
    })(request);
    assert.equal(response.statusCode, status);
  }
});
test('open input validation rejects IDs, overrides, malformed/base64 bodies before any repository access', async () => {
  const handler = createHandler(() => {
    throw new Error('must not initialize');
  });
  for (const body of [
    null,
    [],
    0,
    'text',
    { status: 'OPEN' },
    { opensAt: '2000-01-01T00:00:00Z' },
    { now: 9999999999999 },
    { updatedAt: drop.updatedAt },
    { createdAt: drop.createdAt },
    { dropId },
    { productId },
    { force: true },
    { storefrontDropId: dropId },
    { PK: 'private' },
    { SK: 'META' },
  ]) {
    const response = await handler(event(body));
    assert.equal(response.statusCode, 400);
    assert.equal(JSON.parse(response.body).code, 'VALIDATION_ERROR');
  }
  for (const raw of ['{', ' ', 'not-json']) {
    const request = event();
    request.body = raw;
    assert.equal((await handler(request)).statusCode, 400);
    request.isBase64Encoded = true;
    assert.equal((await handler(request)).statusCode, 400);
  }
  for (const id of [undefined, 'invalid#id']) {
    const request = event();
    request.pathParameters = { dropId: id };
    assert.equal((await handler(request)).statusCode, 400);
  }
});
test('admin open accepts absent/empty/strict empty bodies and returns the exact admin DTO', async (t) => {
  t.mock.method(Date, 'now', () => openingTime + 1000);
  for (const raw of [undefined, '', '{}', 'e30=']) {
    const s = readyStore();
    const request = event();
    request.body = raw;
    request.isBase64Encoded = raw === 'e30=';
    const response = await createHandler(() => s.repository)(request);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(JSON.parse(response.body), {
      drop: {
        ...scheduled,
        status: 'OPEN',
        updatedAt: new Date(openingTime + 1000).toISOString(),
      },
    });
    assert.equal(transactions(s).length, 1);
    const repeated = await createHandler(() => s.repository)(request);
    assert.equal(repeated.statusCode, 409);
    assert.equal(JSON.parse(repeated.body).code, 'DROP_NOT_EDITABLE');
    assert.equal(transactions(s).length, 1);
  }
});
test('admin DTO explicitly excludes raw/public fields and preserves optional closesAt', async () => {
  const opened = {
    ...scheduled,
    status: 'OPEN' as const,
    closesAt: '2026-10-03T00:00:00.000Z',
    updatedAt: '2026-09-24T00:00:00.000Z',
  };
  let calls = 0;
  const repository = fakeRepository({
    openScheduled: async () => {
      calls++;
      return {
        ...opened,
        PK: 'private',
        SK: 'META',
        id: 'public-id',
        products: [],
        pickupDates: [],
        $metadata: {},
      };
    },
  });
  const response = await createHandler(
    () =>
      new Proxy(repository, {
        get(target, property) {
          assert.equal(property, 'openScheduled');
          return Reflect.get(target, property);
        },
      }),
  )(event());
  assert.deepEqual(JSON.parse(response.body), { drop: opened });
  assert.equal(calls, 1);
});
for (const [code, status, message] of [
  ['DROP_NOT_FOUND', 404, 'Drop not found.'],
  ['DROP_NOT_READY', 409, 'Drop is not ready to open.'],
  ['STOREFRONT_CONFLICT', 409, 'Drop is not assigned to the storefront.'],
  ['DROP_NOT_EDITABLE', 409, 'Only SCHEDULED Drops can be opened.'],
  [
    'COMPOSITION_CONFLICT',
    409,
    'Composition changed or is inconsistent. Reload before retrying.',
  ],
] as const) {
  test(`open HTTP maps ${code} without changing existing error taxonomy`, async () => {
    const response = await createHandler(() =>
      fakeRepository({
        openScheduled: async () => {
          throw new CatalogWriteError(code);
        },
      }),
    )(event());
    assert.equal(response.statusCode, status);
    assert.deepEqual(JSON.parse(response.body), {
      code,
      message,
      requestId: 'open-request',
    });
  });
}
test('public SCHEDULED and OPEN remain anonymous with the existing composed response', async () => {
  const s = readyStore();
  const handler = createHandler(() => s.repository);
  const request = {
    routeKey: 'GET /drops/current',
    requestContext: { requestId: 'public-request', http: { method: 'GET' } },
  };
  const before = await handler(request);
  assert.equal(before.statusCode, 200);
  assert.equal(JSON.parse(before.body).drop.status, 'SCHEDULED');
  await handler(event());
  const after = await handler(request);
  assert.equal(after.statusCode, 200);
  assert.deepEqual(JSON.parse(after.body), {
    drop: { ...JSON.parse(before.body).drop, status: 'OPEN' },
  });
});
test('open completion logs only correlated safe fields for success, recognized conflict, and unexpected failure', async (t) => {
  const info = t.mock.method(console, 'info', () => {});
  const errors = t.mock.method(console, 'error', () => {});
  for (const status of [200, 409, 500]) {
    const s = readyStore();
    if (status === 409) s.remove(catalogKeys.storefront);
    if (status === 500)
      s.hooks.failure = cancellation(['None', 'ValidationError', 'None']);
    const request = {
      ...event(),
      headers: {
        Authorization: 'Bearer private-token',
        cookie: 'private-cookie',
      },
      requestContext: {
        ...event().requestContext,
        authorizer: {
          jwt: {
            claims: {
              ...claims,
              password: 'private-password',
              email: 'private-email',
            },
          },
        },
      },
    };
    const response = await createHandler(() => s.repository)(request, {
      awsRequestId: 'open-invocation',
    });
    assert.equal(response.statusCode, status);
    const record = JSON.parse(
      (status === 500 ? errors : info).mock.calls.at(-1)!.arguments[0],
    );
    assert.deepEqual(record, {
      event: 'request.completed',
      requestId: 'open-request',
      lambdaRequestId: 'open-invocation',
      routeKey: openRoute,
      operation: 'openDrop',
      statusCode: status,
      ...(status === 409
        ? { code: 'STOREFRONT_CONFLICT' }
        : status === 500
          ? { code: 'INTERNAL_ERROR' }
          : {}),
    });
    assert.equal(response.body.includes('private'), false);
  }
  const invalid = event({
    password: 'private-password',
    token: 'private-token',
  });
  assert.equal(
    (await createHandler(() => fakeRepository())(invalid)).statusCode,
    400,
  );
  for (const call of [...info.mock.calls, ...errors.mock.calls])
    assert.doesNotMatch(
      call.arguments[0],
      /private|Authorization|body|CancellationReasons/,
    );
});
test('transaction cancellation follows index precedence and unknown reasons remain generic failures', async () => {
  for (const [reasons, expected] of [
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
      'STOREFRONT_CONFLICT',
    ],
    [['None', 'None', 'ConditionalCheckFailed'], 'COMPOSITION_CONFLICT'],
    [['TransactionConflict', 'None', 'None'], 'COMPOSITION_CONFLICT'],
  ] as const) {
    const s = readyStore();
    const before = structuredClone(s.items);
    s.hooks.failure = cancellation([...reasons]);
    await assert.rejects(s.repository.openScheduled(dropId), fails(expected));
    assert.deepEqual(s.items, before);
    assert.equal(transactions(s).length, 1);
  }
  for (const reasons of [
    undefined,
    [],
    ['None'],
    ['None', 'ValidationError', 'None'],
    ['None', 'None', 'None'],
  ]) {
    const s = readyStore();
    s.hooks.failure = cancellation(reasons);
    const response = await createHandler(() => s.repository)(event());
    assert.equal(response.statusCode, 500);
    assert.equal(JSON.parse(response.body).code, 'INTERNAL_ERROR');
    assert.equal(transactions(s).length, 1);
  }
});
