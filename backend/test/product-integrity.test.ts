import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import {
  ProductIntegrity,
  integrityReadyKey,
  slugKey,
  receiptKey,
  payloadHash,
  checkIntegritySizes,
  INTEGRITY_ITEM_LIMIT,
} from '../src/product-integrity';
import { DynamoCatalogRepository } from '../src/repository';
import { catalogKeys } from '../src/keys';
import { product, otherProductId } from './fixtures';
const identity = {
  subject: 'synthetic-admin',
  key: '11111111-1111-4111-8111-111111111111',
};
const second = { ...identity, key: '22222222-2222-4222-8222-222222222222' };
const next = {
  ...product,
  name: 'Edited',
  updatedAt: '2026-09-22T12:00:00.001Z',
};
const key = (v: Record<string, unknown>) => JSON.stringify([v.PK, v.SK]);
// A synthetic serializable transaction model, NOT DynamoDB Local. Conditions are
// evaluated against one pre-commit state; staged writes are applied only if all pass.
function setup(ready = true) {
  const items = new Map<string, Record<string, unknown>>();
  if (ready)
    items.set(key(integrityReadyKey), {
      ...integrityReadyKey,
      version: 1,
      state: 'READY',
    });
  let loseResponse = false,
    rollback = false;
  let revokeReady = false;
  const client = {
    send: async (command: GetCommand | TransactWriteCommand) => {
      if (command instanceof GetCommand)
        return { Item: structuredClone(items.get(key(command.input.Key!))) };
      assert.ok(command instanceof TransactWriteCommand);
      const actions = command.input.TransactItems!;
      if (revokeReady) items.delete(key(integrityReadyKey));
      const targets = new Set<string>();
      const writes: Array<() => void> = [];
      for (const a of actions) {
        const op = a.Put ?? a.Delete ?? a.ConditionCheck!;
        const item = 'Item' in op ? op.Item! : undefined;
        const k = key(item ?? ('Key' in op ? op.Key! : {}));
        assert.ok(!targets.has(k), 'one action per key');
        targets.add(k);
        const existing = items.get(k);
        for (const expr of op.ConditionExpression!.split(' AND ')) {
          let ok: boolean;
          if (expr === 'attribute_not_exists(PK)') ok = !existing;
          else if (expr === 'attribute_exists(PK)') ok = !!existing;
          else {
            const [field, , value] = expr.split(' ');
            const name = op.ExpressionAttributeNames?.[field] ?? field;
            ok =
              !!existing &&
              existing[name] === op.ExpressionAttributeValues?.[value];
          }
          if (!ok)
            throw Object.assign(new Error('conditional'), {
              name: 'TransactionCanceledException',
              CancellationReasons: actions.map((action) => ({
                Code: action === a ? 'ConditionalCheckFailed' : 'None',
              })),
            });
        }
        if (a.Put) writes.push(() => items.set(k, structuredClone(item!)));
        if (a.Delete) writes.push(() => items.delete(k));
      }
      if (rollback) throw new Error('synthetic rollback');
      writes.forEach((write) => write());
      if (loseResponse) {
        loseResponse = false;
        throw new Error('lost response after commit');
      }
      return {};
    },
  } as unknown as Pick<DynamoDBDocumentClient, 'send'>;
  return {
    items,
    integrity: new ProductIntegrity(client, 'synthetic'),
    repo: new DynamoCatalogRepository(client, 'synthetic'),
    lose: () => {
      loseResponse = true;
    },
    revoke: () => {
      revokeReady = true;
    },
    rollback: () => {
      rollback = true;
    },
  };
}
const rejects = (promise: Promise<unknown>, code: string) =>
  assert.rejects(
    promise,
    (e: unknown) => (e as { code?: string }).code === code,
  );
test('atomic create stores exactly product, owner and receipt; inactive ownership conflicts', async () => {
  const s = setup();
  await s.integrity.create({ ...product, active: false }, identity);
  assert.equal(s.items.size, 4);
  await rejects(
    s.integrity.create({ ...product, productId: otherProductId }, second),
    'SLUG_CONFLICT',
  );
  assert.equal(s.items.size, 4);
});
test('concurrent identical requests converge on one original result', async () => {
  const s = setup();
  const results = await Promise.all([
    s.integrity.create(product, identity),
    s.integrity.create({ ...product, productId: otherProductId }, identity),
  ]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(s.items.size, 4);
});
test('concurrent different operations competing for a slug have one winner', async () => {
  const s = setup();
  const r = await Promise.allSettled([
    s.integrity.create(product, identity),
    s.integrity.create({ ...product, productId: otherProductId }, second),
  ]);
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(s.items.size, 4);
});
test('different payload for same identity conflicts, including concurrent creation', async () => {
  const s = setup();
  const r = await Promise.allSettled([
    s.integrity.create(product, identity),
    s.integrity.create({ ...product, slug: 'other' }, identity),
  ]);
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(
    (r.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason
      .code,
    'IDEMPOTENCY_CONFLICT',
  );
});
test('lost response reconciles receipt; replay after edit and ten minutes returns original', async (t) => {
  const s = setup();
  s.lose();
  assert.deepEqual(await s.integrity.create(product, identity), product);
  await s.repo.replaceProduct(next, product);
  t.mock.method(Date, 'now', () => Date.parse(product.createdAt) + 86400000);
  assert.deepEqual(
    await s.integrity.create(
      { ...product, productId: otherProductId },
      identity,
    ),
    product,
  );
  assert.equal(
    s.items.get(key(catalogKeys.product(product.productId)))?.name,
    'Edited',
  );
});
test('rename transfers ownership atomically and permits former slug reuse', async () => {
  const s = setup();
  await s.integrity.create(product, identity);
  await s.repo.replaceProduct({ ...next, slug: 'renamed' }, product);
  assert.equal(s.items.has(key(slugKey(product.slug))), false);
  await s.integrity.create({ ...product, productId: otherProductId }, second);
  assert.equal(s.items.get(key(slugKey('cookie')))?.productId, otherProductId);
});
test('stale concurrent replacements have one winner and do not upsert', async () => {
  const s = setup();
  await s.integrity.create(product, identity);
  const r = await Promise.allSettled([
    s.repo.replaceProduct(next, product),
    s.repo.replaceProduct({ ...next, name: 'Competing' }, product),
  ]);
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(
    (r.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason
      .code,
    'PRODUCT_CONFLICT',
  );
  s.items.delete(key(catalogKeys.product(product.productId)));
  await rejects(s.repo.replaceProduct(next, product), 'PRODUCT_NOT_FOUND');
});
test('occupied rename rolls back product and old reservation', async () => {
  const s = setup();
  await s.integrity.create(product, identity);
  await s.integrity.create(
    { ...product, productId: otherProductId, slug: 'occupied' },
    second,
  );
  await rejects(
    s.repo.replaceProduct({ ...next, slug: 'occupied' }, product),
    'SLUG_CONFLICT',
  );
  assert.equal(
    s.items.get(key(catalogKeys.product(product.productId)))?.slug,
    'cookie',
  );
  assert.equal(
    s.items.get(key(slugKey('cookie')))?.productId,
    product.productId,
  );
});
test('missing/incomplete readiness and legacy missing ownership fail closed', async () => {
  const s = setup(false);
  await rejects(
    s.integrity.create(product, identity),
    'PRODUCT_WRITES_NOT_READY',
  );
  assert.equal(s.items.size, 0);
  s.items.set(key(integrityReadyKey), { version: 1, state: 'PREPARING' });
  await rejects(
    s.integrity.create(product, identity),
    'PRODUCT_WRITES_NOT_READY',
  );
  s.items.set(key(integrityReadyKey), { version: 1, state: 'READY' });
  s.items.set(key(catalogKeys.product(product.productId)), product);
  await rejects(
    s.repo.replaceProduct(next, product),
    'PRODUCT_INTEGRITY_CONFLICT',
  );
});
test('digest collision or mismatched owner fails closed', async () => {
  const s = setup();
  s.items.set(key(slugKey('cookie')), {
    canonicalSlug: 'different',
    productId: otherProductId,
  });
  await rejects(
    s.integrity.create(product, identity),
    'PRODUCT_INTEGRITY_CONFLICT',
  );
  s.items.set(key(catalogKeys.product(product.productId)), product);
  s.items.set(key(slugKey('cookie')), {
    canonicalSlug: 'cookie',
    productId: otherProductId,
  });
  await rejects(
    s.repo.replaceProduct(next, product),
    'PRODUCT_INTEGRITY_CONFLICT',
  );
});
test('rollback leaves no receipt or partial product; malformed/unkeyed writers fail', async () => {
  const s = setup();
  s.rollback();
  await assert.rejects(s.integrity.create(product, identity));
  assert.equal(s.items.size, 1);
  await rejects(s.repo.createProduct(product), 'IDEMPOTENCY_KEY_INVALID');
  await rejects(
    s.integrity.create(product, { ...identity, key: 'bad' }),
    'IDEMPOTENCY_KEY_INVALID',
  );
});
test('canonical hash ignores generated identity but preserves array order and text', () => {
  assert.equal(
    payloadHash(product),
    payloadHash({ ...product, productId: otherProductId }),
  );
  assert.notEqual(
    payloadHash({ ...product, ingredients: ['a', 'b'] }),
    payloadHash({ ...product, ingredients: ['b', 'a'] }),
  );
  assert.notEqual(
    payloadHash(product),
    payloadHash({ ...product, description: product.description + ' ' }),
  );
  assert.notDeepEqual(
    receiptKey(identity),
    receiptKey({ ...identity, subject: 'another-admin' }),
  );
});
test('exact serialized size boundary and oversize rejection before transaction', async () => {
  checkIntegritySizes(['x'.repeat(INTEGRITY_ITEM_LIMIT - 2)]);
  assert.throws(() =>
    checkIntegritySizes(['x'.repeat(INTEGRITY_ITEM_LIMIT - 1)]),
  );
  const s = setup();
  await rejects(
    s.integrity.create(
      { ...product, description: 'x'.repeat(INTEGRITY_ITEM_LIMIT) },
      identity,
    ),
    'PRODUCT_TOO_LARGE',
  );
  assert.equal(s.items.size, 1);
});
test('legacy immutable Product conditions remain enforced before database access', async () => {
  const s = setup();
  await assert.rejects(
    s.repo.replaceProduct({ ...next, productId: otherProductId }, product),
  );
  await assert.rejects(
    s.repo.replaceProduct({ ...next, createdAt: next.updatedAt }, product),
  );
  await assert.rejects(s.repo.replaceProduct(product, product));
  assert.equal(s.items.size, 1);
});

test('malformed product and backend failures do not mutate Drop/inventory records', async () => {
  const s = setup();
  s.items.set('untouched-drop', {
    PK: 'DROP#synthetic',
    SK: 'META',
    status: 'OPEN',
  });
  s.items.set('untouched-stock', {
    PK: 'DROP#synthetic',
    SK: 'INVENTORY#synthetic',
    reserved: 8,
    sold: 62,
  });
  const before = structuredClone([...s.items]);
  await assert.rejects(
    s.integrity.create({ ...product, slug: 'Bad Slug' }, identity),
  );
  assert.deepEqual([...s.items], before);
  await s.integrity.create(product, identity);
  assert.deepEqual(
    s.items.get('untouched-stock'),
    before.find(([k]) => k === 'untouched-stock')?.[1],
  );
  assert.deepEqual(
    s.items.get('untouched-drop'),
    before.find(([k]) => k === 'untouched-drop')?.[1],
  );
});
test('existing Product ID collision cannot overwrite or leave an orphan claim', async () => {
  const s = setup();
  s.items.set(key(catalogKeys.product(product.productId)), {
    ...product,
    slug: 'legacy',
  });
  await rejects(s.integrity.create(product, identity), 'PRODUCT_CONFLICT');
  assert.equal(s.items.size, 2);
  assert.equal(
    s.items.get(key(catalogKeys.product(product.productId)))?.slug,
    'legacy',
  );
});
test('identity subject is required and receipt cannot be read by another administrator', async () => {
  const s = setup();
  await rejects(
    s.integrity.create(product, { ...identity, subject: '' }),
    'IDEMPOTENCY_KEY_INVALID',
  );
  await s.integrity.create(product, identity);
  assert.equal(
    await s.integrity.result({ ...identity, subject: 'other' }),
    undefined,
  );
});

test('readiness revocation between preflight and transaction prevents every write', async () => {
  const s = setup();
  s.revoke();
  await rejects(
    s.integrity.create(product, identity),
    'PRODUCT_WRITES_NOT_READY',
  );
  assert.equal(s.items.size, 0);
});
