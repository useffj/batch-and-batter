// Explicit opt-in local integration test. No profile, ambient credentials or
// configurable remote endpoint. Requires a separately started loopback engine.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
const {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
} = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  ScanCommand,
  TransactWriteCommand,
} = require('@aws-sdk/lib-dynamodb');
const {
  ProductIntegrity,
  integrityReadyKey,
  slugKey,
  receiptKey,
  INTEGRITY_ITEM_LIMIT,
} = require('../dist/src/product-integrity');
const { DynamoCatalogRepository } = require('../dist/src/repository');
const { generateUlid } = require('../dist/src/ulid');
const { catalogKeys } = require('../dist/src/keys');
const {
  seedTransaction,
  buildSeedPlan,
  DEV_TABLE,
  DEV_REGION,
  DEV_PROFILE,
} = require('../dist/tools/seed-plan');
const endpoint = 'http://127.0.0.1:18765';
const raw = new DynamoDBClient({
  endpoint,
  region: 'us-east-2',
  credentials: { accessKeyId: 'LOCALONLY', secretAccessKey: 'LOCALONLY' },
  maxAttempts: 1,
});
raw.middlewareStack.add(
  (next) => async (args) => {
    const r = args.request;
    assert.equal(r.hostname, '127.0.0.1');
    assert.equal(r.port, 18765);
    assert.equal(r.protocol, 'http:');
    return next(args);
  },
  { step: 'finalizeRequest', name: 'loopbackOnly', priority: 'high' },
);
const client = DynamoDBDocumentClient.from(raw);
let passed = 0;
const tables = [];
async function table() {
  const TableName = 'bb-local-integrity-' + randomUUID();
  await raw.send(
    new CreateTableCommand({
      TableName,
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  );
  tables.push(TableName);
  return TableName;
}
async function setup(ready = true) {
  const name = await table();
  if (ready)
    await client.send(
      new PutCommand({
        TableName: name,
        Item: { ...integrityReadyKey, version: 1, state: 'READY' },
      }),
    );
  return {
    name,
    integrity: new ProductIntegrity(client, name),
    repo: new DynamoCatalogRepository(client, name),
  };
}
const product = (slug = 'synthetic-cookie') => ({
  productId: generateUlid(),
  name: 'Synthetic cookie',
  slug,
  description: 'Local engine only',
  ingredients: ['Flour'],
  allergens: ['Wheat'],
  active: false,
  createdAt: '2026-10-14T00:00:00.000Z',
  updatedAt: '2026-10-14T00:00:00.000Z',
});
const identity = () => ({ subject: 'synthetic-admin', key: randomUUID() });
const get = async (s, key) =>
  (
    await client.send(
      new GetCommand({ TableName: s.name, Key: key, ConsistentRead: true }),
    )
  ).Item;
async function all(s) {
  const items = [];
  let key;
  for (let n = 0; n < 100; n++) {
    const r = await client.send(
      new ScanCommand({
        TableName: s.name,
        ConsistentRead: true,
        ExclusiveStartKey: key,
      }),
    );
    items.push(...(r.Items ?? []));
    key = r.LastEvaluatedKey;
    if (!key) return items;
  }
  throw Error('Bounded local scan exceeded');
}
const reject = (p, code) => assert.rejects(p, (e) => e.code === code);
async function check(name, fn) {
  await fn();
  passed++;
  console.log('PASS ' + name);
}
try {
  await check(
    'atomic creation, original replay, different-payload conflict and administrator scope',
    async () => {
      const s = await setup(),
        p = product(),
        i = identity();
      assert.deepEqual(await s.integrity.create(p, i), p);
      assert.equal((await all(s)).length, 4);
      assert.ok(await get(s, slugKey(p.slug)));
      assert.ok(await get(s, receiptKey(i)));
      assert.deepEqual(
        await s.integrity.create({ ...p, productId: generateUlid() }, i),
        p,
      );
      await reject(
        s.integrity.create({ ...p, name: 'Other' }, i),
        'IDEMPOTENCY_CONFLICT',
      );
      assert.equal(
        await s.integrity.result({ ...i, subject: 'other-admin' }),
        undefined,
      );
    },
  );
  await check(
    'concurrent identical operations converge and competing inactive slug claims lose',
    async () => {
      const s = await setup(),
        p = product(),
        i = identity();
      const r = await Promise.all(
        Array.from({ length: 8 }, () =>
          s.integrity.create({ ...p, productId: generateUlid() }, i),
        ),
      );
      for (const result of r) assert.deepEqual(result, r[0]);
      assert.equal((await all(s)).length, 4);
      await reject(s.integrity.create(product(), identity()), 'SLUG_CONFLICT');
      const other = await setup();
      const competing = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          other.integrity.create(product(), identity()),
        ),
      );
      assert.equal(competing.filter((x) => x.status === 'fulfilled').length, 1);
      assert.equal((await all(other)).length, 4);
      for (const result of competing)
        if (result.status === 'rejected')
          assert.equal(result.reason.code, 'SLUG_CONFLICT');
    },
  );
  await check(
    'rename, former-slug reuse, stale revisions and replay after edits',
    async () => {
      const s = await setup(),
        p = product(),
        i = identity();
      await s.integrity.create(p, i);
      const updated = {
        ...p,
        slug: 'renamed',
        updatedAt: '2026-10-14T00:00:00.001Z',
      };
      await s.repo.replaceProduct(updated, p);
      assert.equal(await get(s, slugKey(p.slug)), undefined);
      assert.equal(
        (await get(s, slugKey(updated.slug))).productId,
        p.productId,
      );
      await reject(
        s.repo.replaceProduct(
          { ...p, name: 'Stale', updatedAt: '2026-10-14T00:00:00.002Z' },
          p,
        ),
        'PRODUCT_CONFLICT',
      );
      await s.integrity.create(product(), identity());
      assert.deepEqual(
        await s.integrity.create({ ...p, productId: generateUlid() }, i),
        p,
      );
      assert.deepEqual(await s.repo.getProduct(p.productId), updated);
    },
  );
  await check('failed rename rolls back Product and reservations', async () => {
    const s = await setup(),
      p = product(),
      q = product('occupied');
    await s.integrity.create(p, identity());
    await s.integrity.create(q, identity());
    await reject(
      s.repo.replaceProduct(
        { ...p, slug: q.slug, updatedAt: '2026-10-14T00:00:00.001Z' },
        p,
      ),
      'SLUG_CONFLICT',
    );
    assert.deepEqual(await s.repo.getProduct(p.productId), p);
    assert.equal((await get(s, slugKey(p.slug))).productId, p.productId);
    assert.equal((await all(s)).length, 7);
  });
  await check(
    'missing readiness and inconsistent ownership fail closed',
    async () => {
      const s = await setup(false),
        p = product();
      await reject(
        s.integrity.create(p, identity()),
        'PRODUCT_WRITES_NOT_READY',
      );
      assert.equal((await all(s)).length, 0);
      const prepared = await setup();
      await prepared.integrity.create(p, identity());
      await client.send(
        new PutCommand({
          TableName: prepared.name,
          Item: {
            ...slugKey(p.slug),
            canonicalSlug: 'wrong',
            productId: p.productId,
          },
        }),
      );
      await reject(
        prepared.repo.replaceProduct(
          { ...p, updatedAt: '2026-10-14T00:00:00.001Z' },
          p,
        ),
        'PRODUCT_INTEGRITY_CONFLICT',
      );
      assert.deepEqual(await prepared.repo.getProduct(p.productId), p);
    },
  );
  await check(
    'oversized Product/receipt rejected; near receipt limit accepted by engine',
    async () => {
      const s = await setup(),
        p = product(),
        i = identity();
      await reject(
        s.integrity.create(
          { ...p, description: 'x'.repeat(INTEGRITY_ITEM_LIMIT) },
          i,
        ),
        'PRODUCT_TOO_LARGE',
      );
      assert.equal((await all(s)).length, 1);
      const base = {
        ...receiptKey(i),
        subject: i.subject,
        requestKey: i.key,
        version: 1,
        hash: 'a'.repeat(64),
        product: { ...p, description: '' },
        completedAt: p.createdAt,
      };
      const room =
        INTEGRITY_ITEM_LIMIT - Buffer.byteLength(JSON.stringify(base));
      const exact = { ...p, description: 'x'.repeat(room) };
      await s.integrity.create(exact, i);
      assert.equal(
        Buffer.byteLength(JSON.stringify(await get(s, receiptKey(i)))),
        INTEGRITY_ITEM_LIMIT,
      );
      const next = await setup();
      await reject(
        next.integrity.create(
          { ...exact, description: exact.description + 'x' },
          i,
        ),
        'PRODUCT_TOO_LARGE',
      );
      assert.equal((await all(next)).length, 1);
    },
  );
  await check(
    'internal records excluded and continuation enumerates catalog exactly once without writes',
    async () => {
      const s = await setup();
      const ids = new Set();
      for (let n = 0; n < 38; n++) {
        const p = product('cookie-' + n);
        ids.add(p.productId);
        await s.integrity.create(p, identity());
      }
      let cursor,
        pages = 0;
      const seen = [];
      do {
        const page = await s.repo.listProducts(cursor);
        pages++;
        assert.ok(pages <= 10);
        seen.push(...page.products.map((p) => p.productId));
        cursor = page.cursor;
      } while (cursor);
      assert.ok(pages > 1);
      assert.equal(seen.length, 38);
      assert.deepEqual(new Set(seen), ids);
    },
  );
  await check(
    'transaction boundary readiness check rolls back all writes',
    async () => {
      const s = await setup(),
        p = product(),
        i = identity();
      let invalidated = false;
      const wrapped = {
        send: async (command) => {
          if (command instanceof TransactWriteCommand && !invalidated) {
            invalidated = true;
            await client.send(
              new PutCommand({
                TableName: s.name,
                Item: { ...integrityReadyKey, version: 1, state: 'PREPARING' },
              }),
            );
          }
          return client.send(command);
        },
      };
      await reject(
        new ProductIntegrity(wrapped, s.name).create(p, i),
        'PRODUCT_WRITES_NOT_READY',
      );
      assert.equal((await all(s)).length, 1);
    },
  );
  await check(
    'lost response after real engine commit reconciles original receipt',
    async () => {
      const s = await setup(),
        p = product(),
        i = identity();
      let lost = false;
      const wrapped = {
        send: async (command) => {
          const result = await client.send(command);
          if (command instanceof TransactWriteCommand && !lost) {
            lost = true;
            throw Object.assign(new Error('synthetic lost response'), {
              name: 'TimeoutError',
            });
          }
          return result;
        },
      };
      assert.deepEqual(
        await new ProductIntegrity(wrapped, s.name).create(p, i),
        p,
      );
      assert.equal((await all(s)).length, 4);
    },
  );

  await check(
    'development seed writer honors readiness and claims slugs without partial seed records',
    async () => {
      const plan = buildSeedPlan(
        {
          table: DEV_TABLE,
          region: DEV_REGION,
          profile: DEV_PROFILE,
          opensAt: '2099-10-01T18:00:00.000Z',
          pickupDates: ['2099-10-02', '2099-10-03', '2099-10-04'],
          confirmDev: false,
        },
        new Date('2026-10-14T00:00:00.000Z'),
      );
      const s = await setup(false);
      const localCommand = () => {
        const c = seedTransaction(plan);
        for (const a of c.input.TransactItems) {
          const op = a.Put ?? a.ConditionCheck;
          assert.equal(op.TableName, DEV_TABLE);
          op.TableName = s.name;
        }
        return c;
      };
      await assert.rejects(
        client.send(localCommand()),
        (e) => e.name === 'TransactionCanceledException',
      );
      assert.equal((await all(s)).length, 0);
      await client.send(
        new PutCommand({
          TableName: s.name,
          Item: { ...integrityReadyKey, version: 1, state: 'READY' },
        }),
      );
      await client.send(localCommand());
      assert.equal((await all(s)).length, 14);
      await assert.rejects(
        client.send(localCommand()),
        (e) => e.name === 'TransactionCanceledException',
      );
      assert.equal((await all(s)).length, 14);
      const catalog = await s.repo.listProducts();
      assert.equal(catalog.products.length, 2);
    },
  );
  await check(
    'empty filtered page retains continuation in internal-record-only table',
    async () => {
      const s = await setup();
      for (let n = 0; n < 105; n++)
        await client.send(
          new PutCommand({
            TableName: s.name,
            Item: {
              PK: 'PRODUCT_SLUG#synthetic' + n,
              SK: 'OWNER',
              canonicalSlug: 'synthetic-' + n,
              productId: generateUlid(),
            },
          }),
        );
      const page = await s.repo.listProducts();
      assert.deepEqual(page.products, []);
      assert.ok(page.cursor);
      const next = await s.repo.listProducts(page.cursor);
      assert.deepEqual(next.products, []);
      assert.equal(next.cursor, undefined);
    },
  );
  await check(
    'concurrent same identity with differing payloads yields one immutable receipt',
    async () => {
      const s = await setup(),
        p = product(),
        i = identity();
      const results = await Promise.allSettled([
        s.integrity.create(p, i),
        s.integrity.create({ ...p, slug: 'alternative' }, i),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(
        results.find((r) => r.status === 'rejected').reason.code,
        'IDEMPOTENCY_CONFLICT',
      );
      assert.equal((await all(s)).length, 4);
    },
  );
  console.log(`RESULT ${passed} local integration groups passed`);
} finally {
  for (const TableName of tables)
    await raw.send(new DeleteTableCommand({ TableName }));
  raw.destroy();
}
