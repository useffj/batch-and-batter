import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CartStore, pid, token, tokenHash } from './cart-store';
import { dropId, productId, otherProductId } from './fixtures';
import { catalogKeys } from '../src/keys';
import {
  CartError,
  etag,
  secretHash,
  sameCapability,
  desiredItemsSchema,
  checkedTotal,
  type CartRequest,
  type CartResult,
} from '../src/cart-domain';
import { cartApi } from '../src/cart-api';
const error = (code: string) => (e: unknown) =>
  e instanceof CartError && e.code === code;
const setup = (count = 2, total = 100) => {
  const store = new CartStore().seed(count, total);
  return { store, repo: store.repository() };
};
const metrics = () => ({ attempts: 0 });
const edit = (
  s: CartStore,
  c: CartResult,
  items = c.cart.items.map(({ productId, quantity }) => ({
    productId,
    quantity,
  })),
): CartRequest => ({
  operation: 'replace',
  cartId: c.cart.cartId,
  tokenHash,
  key: s.keyValue(),
  ifMatch: etag(c.cart.updatedAt),
  items,
});
const release = (s: CartStore, c: CartResult): CartRequest => ({
  operation: 'release',
  cartId: c.cart.cartId,
  tokenHash,
  key: s.keyValue(),
});
test('create atomically snapshots two lines with exact transaction ordering and immutable eight-minute timer', async () => {
  const { store: s, repo: r } = setup();
  const c = await r.mutate(
    s.request([
      { productId: otherProductId, quantity: 3 },
      { productId, quantity: 2 },
    ]),
    metrics(),
  );
  assert.equal(c.status, 201);
  assert.equal(Date.parse(c.cart.shoppingExpiresAt) - s.now, 480000);
  assert.deepEqual(c.cart.items, [
    { productId, quantity: 2, priceCents: 450, cookieUnits: 1 },
    { productId: otherProductId, quantity: 3, priceCents: 450, cookieUnits: 1 },
  ]);
  const a = s.transactions[0];
  assert.equal(a.length, 8);
  assert.deepEqual(
    a.slice(0, 4).map((x) => x.ConditionCheck!.Key),
    [
      catalogKeys.drop(dropId),
      catalogKeys.storefront,
      catalogKeys.product(productId),
      catalogKeys.product(otherProductId),
    ],
  );
  assert.deepEqual(
    a.slice(4).map((x) => x.Put!.TableName),
    ['catalog', 'catalog', 'commerce', 'operations'],
  );
  assert.equal(
    a[4].Put!.ConditionExpression,
    'attribute_exists(PK) AND #total = :total AND #reserved = :reserved AND #sold = :sold AND #updated = :expected',
  );
  assert.deepEqual(a[4].Put!.ExpressionAttributeValues, {
    ':total': 100,
    ':reserved': 0,
    ':sold': 0,
    ':expected': new Date(s.now).toISOString(),
  });
  assert.ok(a[4].Put!.Item!.updatedAt > new Date(s.now).toISOString());
  assert.ok(!JSON.stringify(c).includes(tokenHash));
  s.invariants();
});
for (const [label, change, code] of [
  [
    'shortage',
    (s: CartStore) => {
      s.row('catalog', catalogKeys.inventory(dropId, productId))!.total = 1;
    },
    'INSUFFICIENT_INVENTORY',
  ],
  [
    'inactive product',
    (s: CartStore) => {
      s.row('catalog', catalogKeys.product(productId))!.active = false;
    },
    'PRODUCT_NOT_AVAILABLE',
  ],
  [
    'inactive relation',
    (s: CartStore) => {
      s.row('catalog', catalogKeys.dropProduct(dropId, productId))!.active =
        false;
    },
    'PRODUCT_NOT_AVAILABLE',
  ],
  [
    'scheduled',
    (s: CartStore) => {
      s.row('catalog', catalogKeys.drop(dropId))!.status = 'SCHEDULED';
    },
    'DROP_NOT_OPEN',
  ],
  [
    'wrong pointer',
    (s: CartStore) => {
      s.row('catalog', catalogKeys.storefront)!.storefrontDropId = pid(99);
    },
    'STOREFRONT_CONFLICT',
  ],
  [
    'cookie limit',
    (s: CartStore) => {
      s.row(
        'catalog',
        catalogKeys.dropProduct(dropId, productId),
      )!.cookieUnits = 2;
      s.row('catalog', catalogKeys.drop(dropId))!.quantityLimit = 19;
    },
    'QUANTITY_LIMIT_EXCEEDED',
  ],
] as const)
  test(`create rejects ${label} without partial ownership`, async () => {
    const { store: s, repo: r } = setup();
    change(s);
    const before = structuredClone(s.rows);
    await assert.rejects(r.mutate(s.request(), metrics()), error(code));
    assert.deepEqual(s.rows, before);
  });
test('12 products use 28 actions; 13, empty, duplicate and unsafe quantities rejected', async () => {
  const { store: s, repo: r } = setup(12);
  const items = Array.from({ length: 12 }, (_, i) => ({
    productId: pid(i + 2),
    quantity: 1,
  }));
  await r.mutate(s.request(items), metrics());
  assert.equal(s.transactions[0].length, 28);
  for (const invalid of [
    [...items, { productId: pid(40), quantity: 1 }],
    [],
    [items[0], items[0]],
    [{ productId, quantity: Number.MAX_SAFE_INTEGER + 1 }],
  ])
    assert.equal(desiredItemsSchema.safeParse(invalid).success, false);
  assert.throws(
    () =>
      checkedTotal(
        [
          {
            productId,
            quantity: Number.MAX_SAFE_INTEGER,
            priceCents: 2,
            cookieUnits: 2,
          },
        ],
        'cookieUnits',
      ),
    error('VALIDATION_ERROR'),
  );
});
test('canonical capability, fixed-size comparison and indistinguishable absent/wrong authorization', async () => {
  const { store: s, repo: r } = setup();
  const c = await r.mutate(s.request(), metrics());
  assert.equal(
    (await r.get(c.cart.cartId, tokenHash)).cart.cartId,
    c.cart.cartId,
  );
  for (const raw of [
    undefined,
    '',
    token + '=',
    token.slice(1),
    'a'.repeat(43),
  ])
    assert.throws(() => secretHash(raw), error('UNAUTHORIZED'));
  assert.ok(sameCapability(tokenHash, secretHash(token)));
  assert.ok(!sameCapability(tokenHash, '0'.repeat(64)));
  for (const id of [c.cart.cartId, pid(999)])
    await assert.rejects(r.get(id, '0'.repeat(64)), error('UNAUTHORIZED'));
});
test('concurrent duplicate and subsequent replay own stock once; changed request and capability fail safely', async () => {
  const { store: s, repo: r } = setup();
  const req = s.request();
  const [a, b] = await Promise.all([
    r.mutate(req, metrics()),
    r.mutate(req, metrics()),
  ]);
  assert.deepEqual(a, b);
  assert.equal(s.commits, 1);
  s.now += 1000;
  assert.deepEqual(await r.mutate(req, metrics()), a);
  await assert.rejects(
    r.mutate({ ...req, items: [{ productId, quantity: 9 }] }, metrics()),
    error('IDEMPOTENCY_CONFLICT'),
  );
  await assert.rejects(
    r.mutate({ ...req, tokenHash: '0'.repeat(64) }, metrics()),
    error('UNAUTHORIZED'),
  );
  s.invariants();
});
test('lost commit response resolves receipt; retained ancient replay succeeds, deleted ancient key cannot become new', async () => {
  const { store: s, repo: r } = setup();
  s.after = () => {
    throw new Error('lost response');
  };
  const req = s.request();
  const a = await r.mutate(req, metrics());
  s.after = undefined;
  s.now += 8 * 86400000;
  assert.deepEqual(await r.mutate(req, metrics()), a);
  for (const k of s.rows.keys())
    if (k.startsWith('operations|')) s.rows.delete(k);
  await assert.rejects(
    r.mutate(req, metrics()),
    error('IDEMPOTENCY_KEY_EXPIRED'),
  );
  assert.equal(s.commits, 1);
});
for (const offset of [-86400000, 300001])
  test(`new key outside window ${offset} fails`, async () => {
    const { store: s, repo: r } = setup();
    await assert.rejects(
      r.mutate({ ...s.request(), key: s.keyValue(s.now + offset) }, metrics()),
      error('IDEMPOTENCY_KEY_EXPIRED'),
    );
    assert.equal(s.commits, 0);
  });
test('replacement adds/increases/removes/decreases with preserved prices, expiry, replay and stale revision conflict', async () => {
  const { store: s, repo: r } = setup();
  const c = await r.mutate(s.request(), metrics());
  s.now += 5000;
  s.row('catalog', catalogKeys.dropProduct(dropId, productId))!.priceCents =
    900;
  const req = edit(s, c, [
    { productId, quantity: 15 },
    { productId: otherProductId, quantity: 3 },
  ]);
  const next = await r.mutate(req, metrics());
  assert.equal(next.cart.items[0].priceCents, 450);
  assert.equal(next.cart.shoppingExpiresAt, c.cart.shoppingExpiresAt);
  assert.deepEqual(await r.mutate(req, metrics()), next);
  await assert.rejects(
    r.mutate({ ...req, key: s.keyValue() }, metrics()),
    error('CART_CONFLICT'),
  );
  await r.mutate(
    edit(s, next, [{ productId: otherProductId, quantity: 1 }]),
    metrics(),
  );
  assert.equal(
    s.row('catalog', catalogKeys.inventory(dropId, productId))!.reserved,
    0,
  );
  s.invariants();
});
for (const status of ['PAUSED', 'CLOSED'])
  test(`${status} permits only reductions and release despite inactive Product and missing storefront`, async () => {
    const { store: s, repo: r } = setup();
    const c = await r.mutate(s.request(), metrics());
    s.row('catalog', catalogKeys.drop(dropId))!.status = status;
    s.row('catalog', catalogKeys.product(productId))!.active = false;
    s.rows.delete(s.key('catalog', catalogKeys.storefront));
    for (const items of [
      [{ productId, quantity: 11 }],
      [{ productId: otherProductId, quantity: 1 }],
    ])
      await assert.rejects(
        r.mutate(edit(s, c, items), metrics()),
        error('DROP_NOT_OPEN'),
      );
    const reduced = await r.mutate(
      edit(s, c, [{ productId, quantity: 5 }]),
      metrics(),
    );
    const req = release(s, reduced);
    const done = await r.mutate(req, metrics());
    assert.equal(done.cart.status, 'CANCELLED');
    assert.deepEqual(await r.mutate(req, metrics()), done);
    await r.mutate(release(s, done), metrics());
    await assert.rejects(
      r.mutate(edit(s, done), metrics()),
      error('CART_CONFLICT'),
    );
    assert.equal(
      s.row('catalog', catalogKeys.inventory(dropId, productId))!.reserved,
      0,
    );
    s.invariants();
  });
test('deadline equality expires edits and GET; DELETE settles once and never adds ACTIVE TTL', async () => {
  const { store: s, repo: r } = setup();
  const c = await r.mutate(s.request(), metrics());
  s.now = Date.parse(c.cart.shoppingExpiresAt);
  await assert.rejects(
    r.mutate(edit(s, c), metrics()),
    error('RESERVATION_EXPIRED'),
  );
  assert.equal((await r.get(c.cart.cartId, tokenHash)).expired, true);
  const done = await r.mutate(release(s, c), metrics());
  assert.equal(done.cart.status, 'EXPIRED');
  assert.equal(done.cart.shoppingExpiresAt, c.cart.shoppingExpiresAt);
  await r.mutate(release(s, done), metrics());
  assert.equal(
    s.row('commerce', { PK: `CART#${c.cart.cartId}`, SK: 'META' })!.ttl,
    undefined,
  );
  s.invariants();
});
for (const [label, change, code] of [
  [
    'pause',
    (s: CartStore) => {
      s.row('catalog', catalogKeys.drop(dropId))!.status = 'PAUSED';
    },
    'DROP_NOT_OPEN',
  ],
  [
    'close',
    (s: CartStore) => {
      s.row('catalog', catalogKeys.drop(dropId))!.status = 'CLOSED';
    },
    'DROP_NOT_OPEN',
  ],
  [
    'drop revision',
    (s: CartStore) => {
      s.row('catalog', catalogKeys.drop(dropId))!.updatedAt = new Date(
        s.now + 1,
      ).toISOString();
    },
    'DROP_NOT_OPEN',
  ],
  [
    'pointer',
    (s: CartStore) => {
      s.rows.delete(s.key('catalog', catalogKeys.storefront));
    },
    'STOREFRONT_CONFLICT',
  ],
  [
    'product inactive',
    (s: CartStore) => {
      s.row('catalog', catalogKeys.product(productId))!.active = false;
    },
    'PRODUCT_NOT_AVAILABLE',
  ],
  [
    'product revision',
    (s: CartStore) => {
      s.row('catalog', catalogKeys.product(productId))!.updatedAt = new Date(
        s.now + 1,
      ).toISOString();
    },
    'PRODUCT_NOT_AVAILABLE',
  ],
] as const)
  test(`race against ${label} cancels at correct action index`, async () => {
    const { store: s, repo: r } = setup();
    s.before = () => change(s);
    const m = metrics();
    await assert.rejects(r.mutate(s.request(), m), error(code));
    assert.equal(m.attempts, 1);
    assert.equal(s.commits, 0);
    s.invariants();
  });
test('insufficient second line leaves every table unchanged', async () => {
  const { store: s, repo: r } = setup();
  s.row('catalog', catalogKeys.inventory(dropId, otherProductId))!.total = 1;
  const before = structuredClone(s.rows);
  await assert.rejects(
    r.mutate(
      s.request([
        { productId, quantity: 10 },
        { productId: otherProductId, quantity: 2 },
      ]),
      metrics(),
    ),
    error('INSUFFICIENT_INVENTORY'),
  );
  assert.deepEqual(s.rows, before);
});
test('update/update and update/release races serialize ownership on Cart revision', async () => {
  for (const deleting of [false, true]) {
    const { store: s, repo: r } = setup();
    const c = await r.mutate(s.request(), metrics());
    const outcomes = await Promise.allSettled([
      r.mutate(edit(s, c, [{ productId, quantity: 11 }]), metrics()),
      r.mutate(
        deleting ? release(s, c) : edit(s, c, [{ productId, quantity: 12 }]),
        metrics(),
      ),
    ]);
    assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1);
    assert.equal(
      (outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult)
        .reason.code,
      'CART_CONFLICT',
    );
    s.invariants();
  }
});
test('bounded contention has six attempts and full-jitter caps; exhaustion and safety margin return busy', async () => {
  const { store: s, repo: r } = setup();
  s.forcedCode = 'TransactionConflict';
  const m = metrics();
  await assert.rejects(r.mutate(s.request(), m), error('CART_BUSY'));
  assert.equal(m.attempts, 6);
  assert.deepEqual(s.sleeps, [12.5, 25, 50, 100, 125]);
  await assert.rejects(
    r.mutate(s.request(), metrics(), () => 600),
    error('CART_BUSY'),
  );
});
test('20 x 10 clients against 100 allocate all 100 without intermediate oversell or duplicate owners', async () => {
  const { store: s, repo: r } = setup(1, 100);
  const start = Date.now();
  const results = await Promise.all(
    Array.from({ length: 20 }, async () => {
      const req = s.request();
      while (Date.now() - start < 5000) {
        try {
          return await r.mutate(req, metrics());
        } catch (e) {
          if (e instanceof CartError && e.code === 'CART_BUSY') {
            await new Promise((resolve) => setImmediate(resolve));
            continue;
          }
          if (e instanceof CartError && e.code === 'INSUFFICIENT_INVENTORY')
            return e.code;
          throw e;
        }
      }
      throw new Error('healthy contention timeout');
    }),
  );
  assert.equal(results.filter((x) => typeof x !== 'string').length, 10);
  assert.equal(s.commits, 10);
  assert.equal(
    s.row('catalog', catalogKeys.inventory(dropId, productId))!.reserved,
    100,
  );
  s.invariants();
});
test('HTTP validates strict bodies/headers and logs only safe metadata', async () => {
  const { store: s, repo: r } = setup();
  const logs: string[] = [];
  const original = console.info;
  console.info = (value) => {
    logs.push(String(value));
  };
  try {
    const event = {
      routeKey: 'POST /carts',
      headers: { 'X-Cart-Token': token, 'Idempotency-Key': s.keyValue() },
      body: JSON.stringify({ dropId, items: [{ productId, quantity: 1 }] }),
      requestContext: { requestId: 'request-123', http: { method: 'POST' } },
    };
    const response = await cartApi(event, () => r, {
      awsRequestId: 'lambda-123',
    });
    assert.equal(response.statusCode, 201);
    assert.ok(response.headers.etag);
    assert.equal(response.headers['cache-control'], 'no-store');
    for (const body of [
      { dropId, items: [] },
      { dropId, items: [{ productId, quantity: 1, priceCents: 1 }] },
      { dropId, items: [{ productId, quantity: 1 }], expiresAt: 'tomorrow' },
    ])
      assert.equal(
        (await cartApi({ ...event, body: JSON.stringify(body) }, () => r))
          .statusCode,
        400,
      );
    assert.equal(
      (await cartApi({ ...event, headers: {} }, () => r)).statusCode,
      401,
    );
    assert.equal(
      (await cartApi({ ...event, headers: { 'X-Cart-Token': token } }, () => r))
        .statusCode,
      400,
    );
    const text = logs.join('\n') + response.body;
    for (const secret of [
      token,
      tokenHash,
      event.headers['Idempotency-Key'],
      'managementTokenHash',
    ])
      assert.ok(!text.includes(secret));
    assert.ok(
      logs.some((l) => l.includes('createCart') && l.includes('attempts')),
    );
  } finally {
    console.info = original;
  }
});

test('retry rereads inventory and lifecycle; OPEN revision change is not silently rebased', async () => {
  const { store: s, repo: r } = setup();
  let attempt = 0;
  s.before = () => {
    if (attempt++ === 0) {
      s.row('catalog', catalogKeys.drop(dropId))!.updatedAt = new Date(
        s.now + 1,
      ).toISOString();
      s.forcedCode = 'TransactionConflict';
    } else s.forcedCode = undefined;
  };
  await assert.rejects(
    r.mutate(s.request(), metrics()),
    error('DROP_NOT_OPEN'),
  );
  assert.equal(s.commits, 0);
});
test('inventory-only revision contention rereads, retries and starts timer on successful attempt', async () => {
  const { store: s, repo: r } = setup();
  let attempt = 0;
  const start = s.now;
  s.before = () => {
    if (attempt++ === 0) {
      s.row('catalog', catalogKeys.inventory(dropId, productId))!.updatedAt =
        new Date(s.now + 1).toISOString();
      s.now += 1000;
    }
  };
  const m = metrics();
  const c = await r.mutate(s.request(), m);
  assert.equal(m.attempts, 2);
  assert.equal(Date.parse(c.cart.shoppingExpiresAt), start + 1000 + 480000);
  s.invariants();
});
test('post-read inventory shortage retries once then reports fresh shortage without partial reservation', async () => {
  const { store: s, repo: r } = setup();
  s.before = () => {
    s.row('catalog', catalogKeys.inventory(dropId, productId))!.sold = 95;
  };
  const m = metrics();
  await assert.rejects(
    r.mutate(s.request(), m),
    error('INSUFFICIENT_INVENTORY'),
  );
  assert.equal(m.attempts, 1);
  assert.equal(s.commits, 0);
  s.invariants();
});
test('full 12-to-12 substitution uses 40 unique actions; reduction and release omit all acquisition checks', async () => {
  const { store: s, repo: r } = setup(24);
  const c = await r.mutate(
    s.request(
      Array.from({ length: 12 }, (_, i) => ({
        productId: pid(i + 2),
        quantity: 2,
      })),
    ),
    metrics(),
  );
  const next = await r.mutate(
    edit(
      s,
      c,
      Array.from({ length: 12 }, (_, i) => ({
        productId: pid(i + 14),
        quantity: 2,
      })),
    ),
    metrics(),
  );
  assert.equal(s.transactions.at(-1)!.length, 40);
  const reduced = await r.mutate(
    edit(s, next, [{ productId: pid(14), quantity: 1 }]),
    metrics(),
  );
  assert.equal(s.transactions.at(-1)!.length, 14);
  assert.ok(s.transactions.at(-1)!.every((a) => a.Put));
  await r.mutate(release(s, reduced), metrics());
  assert.equal(s.transactions.at(-1)!.length, 3);
  assert.ok(s.transactions.at(-1)!.every((a) => a.Put));
  s.invariants();
});
test('release versus synchronous expiry settlement has a single winner and never releases twice', async () => {
  const { store: s, repo: r } = setup();
  const c = await r.mutate(s.request(), metrics());
  s.now = Date.parse(c.cart.shoppingExpiresAt);
  const outcomes = await Promise.allSettled([
    r.mutate(release(s, c), metrics()),
    r.mutate(release(s, c), metrics()),
  ]);
  assert.equal(outcomes.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(
    (outcomes.find((x) => x.status === 'rejected') as PromiseRejectedResult)
      .reason.code,
    'CART_CONFLICT',
  );
  s.invariants();
});
test('unexpected service failure and unrecognized cancellation are safe retryable errors, no partial writes', async () => {
  for (const failure of ['ThrottlingError', 'unknown']) {
    const { store: s, repo: r } = setup();
    if (failure === 'unknown')
      s.before = () => {
        throw new Error('private AWS payload');
      };
    else s.forcedCode = failure;
    await assert.rejects(r.mutate(s.request(), metrics()), error('CART_BUSY'));
    assert.equal(s.commits, 0);
  }
});
test('deadline expires while validating an edit: no transaction or extension', async () => {
  const { store: s, repo: r } = setup();
  const c = await r.mutate(s.request(), metrics());
  const request = edit(s, c, [{ productId, quantity: 11 }]);
  s.before = () => {
    s.now = Date.parse(c.cart.shoppingExpiresAt);
    s.row('catalog', catalogKeys.inventory(dropId, productId))!.updatedAt =
      new Date(s.now).toISOString();
  };
  await assert.rejects(
    r.mutate(request, metrics()),
    error('RESERVATION_EXPIRED'),
  );
  assert.equal(s.commits, 1);
  s.invariants();
});
test('all HTTP cart routes dispatch without Cognito; PUT requires strong If-Match, GET returns current state, DELETE settles', async () => {
  const { createHandler } = await import('../src/api');
  const { fakeRepository } = await import('./fixtures');
  const { store: s, repo: r } = setup();
  const handler = createHandler(
    () => fakeRepository(),
    undefined,
    () => r,
  );
  const original = console.info;
  console.info = () => {};
  try {
    const headers = { 'x-cart-token': token, 'idempotency-key': s.keyValue() };
    const base = {
      headers,
      requestContext: { requestId: 'safe-request', http: { method: 'POST' } },
      body: JSON.stringify({ dropId, items: [{ productId, quantity: 2 }] }),
    };
    const created = await handler({ ...base, routeKey: 'POST /carts' });
    assert.equal(created.statusCode, 201);
    const cart = JSON.parse(created.body).cart;
    const pathParameters = { cartId: cart.cartId };
    const fetched = await handler({
      ...base,
      routeKey: 'GET /carts/{cartId}',
      pathParameters,
      requestContext: { requestId: 'safe-request', http: { method: 'GET' } },
    });
    assert.equal(fetched.statusCode, 200);
    assert.equal(fetched.headers.etag, created.headers.etag);
    const put = {
      ...base,
      routeKey: 'PUT /carts/{cartId}/items',
      pathParameters,
      body: JSON.stringify({ items: [{ productId, quantity: 1 }] }),
      requestContext: { requestId: 'safe-request', http: { method: 'PUT' } },
    };
    for (const match of [undefined, '*', 'W/' + created.headers.etag])
      assert.equal(
        (await handler({ ...put, headers: { ...headers, 'if-match': match } }))
          .statusCode,
        400,
      );
    const updated = await handler({
      ...put,
      headers: { ...headers, 'if-match': created.headers.etag },
    });
    assert.equal(updated.statusCode, 200);
    assert.notEqual(updated.headers.etag, created.headers.etag);
    const deleted = await handler({
      ...base,
      routeKey: 'DELETE /carts/{cartId}',
      pathParameters,
      body: undefined,
      requestContext: { requestId: 'safe-request', http: { method: 'DELETE' } },
    });
    assert.equal(deleted.statusCode, 200);
    assert.equal(JSON.parse(deleted.body).cart.status, 'CANCELLED');
    s.invariants();
  } finally {
    console.info = original;
  }
});

test('slow SDK read aborts within Lambda safety margin and exposes only CART_BUSY', async () => {
  const { DynamoCartRepository } = await import('../src/cart-repository');
  const send = async (
    _command: unknown,
    options?: { abortSignal?: AbortSignal },
  ) =>
    new Promise((_resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('unbounded private AWS failure')),
        1000,
      );
      options?.abortSignal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new Error('private abort details'));
        },
        { once: true },
      );
    });
  const r = new DynamoCartRepository(
    { send } as unknown as ConstructorParameters<
      typeof DynamoCartRepository
    >[0],
    'catalog',
    'commerce',
    'operations',
  );
  const s = new CartStore().seed();
  const start = Date.now();
  await assert.rejects(
    r.mutate(s.request(), metrics(), () => 230),
    error('CART_BUSY'),
  );
  assert.ok(Date.now() - start < 500);
});
