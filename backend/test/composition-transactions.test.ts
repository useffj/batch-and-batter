import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { CatalogWriteError } from '../src/repository';
import { catalogKeys } from '../src/keys';
import { relation, pickup, dropId, productId } from './fixtures';
import { compositionStore, cancellation } from './composition-store';
const associationKey = catalogKeys.dropProduct(dropId, productId);
const inventoryKey = catalogKeys.inventory(dropId, productId);
const dropKey = catalogKeys.drop(dropId);
const productKey = catalogKeys.product(productId);
const pickupKey = catalogKeys.pickup(dropId, pickup.date);
const fails = (code: string) => (error: unknown) =>
  error instanceof CatalogWriteError && error.code === code;
const operations = [
  (s: ReturnType<typeof compositionStore>) =>
    s.repository.attachDropProduct(relation, 100),
  (s: ReturnType<typeof compositionStore>) =>
    s.repository.replaceDropProduct(relation, 120),
  (s: ReturnType<typeof compositionStore>) =>
    s.repository.removeDropProduct(dropId, productId),
  (s: ReturnType<typeof compositionStore>) => s.repository.putPickup(pickup),
  (s: ReturnType<typeof compositionStore>) =>
    s.repository.removePickup(dropId, pickup.date),
];
async function seeded() {
  const s = compositionStore();
  await s.repository.attachDropProduct(relation, 100);
  await s.repository.putPickup(pickup);
  s.commands.length = 0;
  return s;
}
test('all five mutations use one bounded Catalog transaction with unique keys and atomic DRAFT condition', async () => {
  for (const [index, operation] of operations.entries()) {
    const s = await seeded();
    if (index === 0) {
      s.remove(associationKey);
      s.remove(inventoryKey);
    }
    await operation(s);
    const transactions = s.commands.filter(
      (command) => command instanceof TransactWriteCommand,
    );
    assert.equal(transactions.length, 1);
    const actions = transactions[0].input.TransactItems!;
    assert.equal(actions.length, [4, 4, 3, 2, 2][index]);
    assert.deepEqual(actions[0], {
      ConditionCheck: {
        TableName: 'test-catalog',
        Key: dropKey,
        ConditionExpression: 'attribute_exists(PK) AND #status = :draft',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':draft': 'DRAFT' },
      },
    });
    if (index < 2)
      assert.deepEqual(actions[1], {
        ConditionCheck: {
          TableName: 'test-catalog',
          Key: productKey,
          ConditionExpression: 'attribute_exists(PK)',
        },
      });
    if (index === 0)
      assert.ok(
        actions
          .slice(2)
          .every(
            (action) =>
              action.Put?.ConditionExpression === 'attribute_not_exists(PK)',
          ),
      );
    if (index === 1)
      assert.equal(actions[2].Put?.ConditionExpression, 'attribute_exists(PK)');
    if (index === 2) assert.deepEqual(actions[1].Delete?.Key, associationKey);
    if (index === 4)
      assert.deepEqual(actions[1].Delete, {
        TableName: 'test-catalog',
        Key: pickupKey,
        ConditionExpression: 'attribute_exists(PK)',
      });
  }
});
test('attach initializes both records and server inventory timestamp; duplicate or orphan conflicts do not partially create', async () => {
  for (const existing of ['neither', 'both', 'association', 'inventory']) {
    const s = await seeded();
    if (existing === 'neither' || existing === 'inventory')
      s.remove(associationKey);
    if (existing === 'neither' || existing === 'association')
      s.remove(inventoryKey);
    const before = structuredClone(s.items);
    if (existing === 'neither') {
      const start = Date.now();
      const result = await s.repository.attachDropProduct(relation, 50);
      assert.equal(result.total, 50);
      assert.equal(result.reserved, 0);
      assert.equal(result.sold, 0);
      assert.ok(
        Date.parse(result.updatedAt) >= start &&
          Date.parse(result.updatedAt) <= Date.now(),
      );
      assert.deepEqual(s.get(associationKey), {
        ...relation,
        ...associationKey,
      });
      assert.deepEqual(s.get(inventoryKey), { ...result, ...inventoryKey });
    } else {
      await assert.rejects(
        s.repository.attachDropProduct(relation, 50),
        fails('DROP_PRODUCT_CONFLICT'),
      );
      assert.deepEqual(s.items, before);
    }
  }
});
test('Product absence blocks attach and replace atomically, including deletion after application reads', async () => {
  for (const operation of operations.slice(0, 2)) {
    const s = await seeded();
    s.remove(associationKey);
    s.remove(inventoryKey);
    s.hooks.beforeTransaction = () => s.remove(productKey);
    await assert.rejects(operation(s), fails('PRODUCT_NOT_FOUND'));
    assert.equal(s.get(associationKey), undefined);
    assert.equal(s.get(inventoryKey), undefined);
  }
});
test('all mutations reject each non-DRAFT state, both initially and during the read/write race', async () => {
  for (const operation of operations)
    for (const status of [
      'SCHEDULED',
      'OPEN',
      'PAUSED',
      'SOLD_OUT',
      'CLOSED',
      'COMPLETED',
    ])
      for (const race of [false, true]) {
        const s = await seeded();
        const change = () => s.put({ ...s.get(dropKey)!, status });
        if (race) s.hooks.beforeTransaction = change;
        else change();
        const before = structuredClone(s.items);
        await assert.rejects(operation(s), fails('DROP_NOT_EDITABLE'));
        before.set(`${dropKey.PK}/${dropKey.SK}`, s.get(dropKey)!);
        assert.deepEqual(s.items, before);
        assert.equal(
          s.commands.filter((c) => c instanceof TransactWriteCommand).length,
          race ? 1 : 0,
        );
      }
});
test('initially missing Drop is 404; Drop deleted at write time maps to DROP_NOT_EDITABLE', async () => {
  for (const operation of operations)
    for (const race of [false, true]) {
      const s = await seeded();
      if (race) s.hooks.beforeTransaction = () => s.remove(dropKey);
      else s.remove(dropKey);
      await assert.rejects(
        operation(s),
        fails(race ? 'DROP_NOT_EDITABLE' : 'DROP_NOT_FOUND'),
      );
    }
});
test('replace changes all configuration and allocation while preserving zero reserved/sold', async () => {
  const s = await seeded();
  const updated = {
    ...relation,
    priceCents: 475,
    displayOrder: 1,
    cookieUnits: 2,
    active: false,
  };
  const inventory = await s.repository.replaceDropProduct(updated, 120);
  assert.deepEqual(s.get(associationKey), { ...updated, ...associationKey });
  assert.equal(inventory.total, 120);
  assert.equal(inventory.reserved, 0);
  assert.equal(inventory.sold, 0);
});
test('inventory activity blocks both update and removal, including activity introduced at transaction time', async () => {
  for (const operation of operations.slice(1, 3))
    for (const counts of [
      { reserved: 1, sold: 0 },
      { reserved: 0, sold: 1 },
    ]) {
      const s = await seeded();
      const before = structuredClone(s.get(associationKey));
      s.hooks.beforeTransaction = () =>
        s.put({ ...s.get(inventoryKey)!, ...counts });
      await assert.rejects(operation(s), fails('INVENTORY_NOT_EDITABLE'));
      assert.deepEqual(s.get(associationKey), before);
      assert.equal(s.get(inventoryKey)!.total, 100);
      assert.equal(s.get(inventoryKey)!.reserved, counts.reserved);
      assert.equal(s.get(inventoryKey)!.sold, counts.sold);
    }
});
test('missing association and missing inventory never upsert or partially delete', async () => {
  for (const operation of operations.slice(1, 3))
    for (const missing of [associationKey, inventoryKey]) {
      const s = await seeded();
      s.remove(missing);
      const before = structuredClone(s.items);
      await assert.rejects(
        operation(s),
        fails(
          missing === associationKey
            ? 'DROP_PRODUCT_NOT_FOUND'
            : 'COMPOSITION_CONFLICT',
        ),
      );
      assert.deepEqual(s.items, before);
    }
});
test('removal deletes exactly the association/inventory pair and preserves reusable Product', async () => {
  const s = await seeded();
  const before = structuredClone(s.get(productKey));
  await s.repository.removeDropProduct(dropId, productId);
  assert.equal(s.get(associationKey), undefined);
  assert.equal(s.get(inventoryKey), undefined);
  assert.deepEqual(s.get(productKey), before);
  assert.ok(s.get(dropKey));
  assert.ok(s.get(pickupKey));
});
test('pickup Put creates and replaces idempotently without changing META; deletion requires existence', async () => {
  const s = compositionStore();
  const meta = structuredClone(s.get(dropKey));
  await s.repository.putPickup(pickup);
  const replacement = { ...pickup, startTime: '17:00', active: false };
  await s.repository.putPickup(replacement);
  await s.repository.putPickup(replacement);
  assert.deepEqual(s.get(pickupKey), { ...replacement, ...pickupKey });
  assert.deepEqual(s.get(dropKey), meta);
  await s.repository.removePickup(dropId, pickup.date);
  assert.equal(s.get(pickupKey), undefined);
  await assert.rejects(
    s.repository.removePickup(dropId, pickup.date),
    fails('PICKUP_NOT_FOUND'),
  );
});
test('repository independently validates records and inventory invariants before database access', async () => {
  const s = compositionStore();
  for (const total of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
    await assert.rejects(s.repository.attachDropProduct(relation, total));
    await assert.rejects(s.repository.replaceDropProduct(relation, total));
  }
  await assert.rejects(
    s.repository.putPickup({ ...pickup, date: '2026-02-30' }),
  );
  await assert.rejects(s.repository.putPickup({ ...pickup, endTime: '15:00' }));
  assert.equal(s.commands.length, 0);
});
test('cancellation precedence is deterministic; transaction conflicts map safely, unknown service failures propagate', async () => {
  for (const [codes, expected] of [
    [
      [
        'ConditionalCheckFailed',
        'ConditionalCheckFailed',
        'ConditionalCheckFailed',
        'ConditionalCheckFailed',
      ],
      'DROP_NOT_EDITABLE',
    ],
    [
      ['None', 'ConditionalCheckFailed', 'ConditionalCheckFailed', 'None'],
      'PRODUCT_NOT_FOUND',
    ],
    [
      ['None', 'None', 'ConditionalCheckFailed', 'None'],
      'DROP_PRODUCT_CONFLICT',
    ],
    [
      ['None', 'None', 'None', 'ConditionalCheckFailed'],
      'DROP_PRODUCT_CONFLICT',
    ],
    [['TransactionConflict', 'None', 'None', 'None'], 'COMPOSITION_CONFLICT'],
  ] as const) {
    const s = compositionStore();
    s.hooks.failure = cancellation([...codes]);
    await assert.rejects(
      s.repository.attachDropProduct(relation, 100),
      fails(expected),
    );
    assert.equal(s.get(associationKey), undefined);
  }
  for (const failure of [
    new Error('private AWS failure'),
    cancellation(),
    cancellation(['None']),
    cancellation(['None', 'None', 'ValidationError', 'None']),
    cancellation(['None', 'None', 'None', 'None']),
  ]) {
    const s = compositionStore();
    s.hooks.failure = failure;
    await assert.rejects(
      s.repository.attachDropProduct(relation, 100),
      (error) => error === failure,
    );
  }
});
