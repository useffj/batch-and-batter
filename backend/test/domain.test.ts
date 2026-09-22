import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  availableInventory,
  dropSchema,
  dropStatusSchema,
  dropProductSchema,
  inventorySchema,
  isCustomerVisible,
  pickupSchema,
  productSchema,
  storefrontSchema,
} from '../src/domain';
import {
  drop,
  dropId,
  inventory,
  pickup,
  product,
  relation,
  timestamp,
} from './fixtures';

test('Product uses internal IDs and slug; no price or inventory on reusable record', () => {
  assert.equal(productSchema.parse(product).slug, 'cookie');
  for (const invalid of [
    { ...product, productId: 'cookie' },
    { ...product, slug: 'Bad Slug' },
    { ...product, priceCents: 450 },
    { ...product, total: 100 },
  ])
    assert.equal(productSchema.safeParse(invalid).success, false);
});
test('money and cookie units are safe integers, never fractional dollars', () => {
  assert.equal(dropProductSchema.parse(relation).priceCents, 450);
  for (const priceCents of [
    4.5,
    -1,
    Infinity,
    NaN,
    Number.MAX_SAFE_INTEGER + 1,
    '450',
  ])
    assert.equal(
      dropProductSchema.safeParse({ ...relation, priceCents }).success,
      false,
    );
  for (const cookieUnits of [0, -1, 1.5])
    assert.equal(
      dropProductSchema.safeParse({ ...relation, cookieUnits }).success,
      false,
    );
});
test('inventory invariant and initial zero balances', () => {
  assert.equal(availableInventory(inventory), 30);
  const initial = inventorySchema.parse({
    dropId,
    productId: product.productId,
    total: 0,
    updatedAt: timestamp,
  });
  assert.equal(initial.reserved, 0);
  assert.equal(initial.sold, 0);
  assert.equal(availableInventory(initial), 0);
  assert.equal(
    inventorySchema.safeParse({ ...inventory, reserved: 38 }).success,
    true,
  );
  for (const patch of [
    { total: -1 },
    { reserved: -1 },
    { sold: -1 },
    { total: 69 },
    { reserved: 39 },
    { total: 1.5 },
    { sold: Number.MAX_SAFE_INTEGER },
  ])
    assert.equal(
      inventorySchema.safeParse({ ...inventory, ...patch }).success,
      false,
    );
});
test('all seven statuses validate, and only the five documented states are public', () => {
  for (const status of [
    'DRAFT',
    'SCHEDULED',
    'OPEN',
    'PAUSED',
    'SOLD_OUT',
    'CLOSED',
    'COMPLETED',
  ] as const) {
    assert.equal(dropStatusSchema.parse(status), status);
    assert.equal(
      isCustomerVisible(status),
      !['DRAFT', 'COMPLETED'].includes(status),
    );
  }
  for (const status of ['open', 'CANCELLED', '', null])
    assert.equal(dropStatusSchema.safeParse(status).success, false);
});
test('Drop defaults are configurable and opening is not tied to Sunday', () => {
  const { quantityLimit: _quantity, timezone: _timezone, ...input } = drop;
  const parsed = dropSchema.parse(input);
  assert.equal(parsed.quantityLimit, 12);
  assert.equal(parsed.timezone, 'America/Denver');
  assert.equal(
    dropSchema.parse({
      ...input,
      quantityLimit: 24,
      timezone: 'America/New_York',
    }).quantityLimit,
    24,
  );
  for (const patch of [
    { quantityLimit: 0 },
    { timezone: 'Invalid/Zone' },
    { opensAt: '2026-02-30T12:00:00Z' },
    { closesAt: drop.opensAt },
  ])
    assert.equal(dropSchema.safeParse({ ...drop, ...patch }).success, false);
});
test('pickup dates and same-day time windows must be valid', () => {
  assert.equal(pickupSchema.parse(pickup).timezone, 'America/Denver');
  for (const patch of [
    { date: '2026-02-30' },
    { date: '2026-2-03' },
    { startTime: '24:00' },
    { startTime: '4:00' },
    { endTime: '16:00' },
    { endTime: '15:59' },
    { endTime: '01:00' },
  ])
    assert.equal(
      pickupSchema.safeParse({ ...pickup, ...patch }).success,
      false,
    );
});
test('storefront can explicitly have no pointer', () => {
  assert.equal(
    storefrontSchema.parse({ updatedAt: timestamp }).storefrontDropId,
    undefined,
  );
  assert.equal(
    storefrontSchema.parse({ storefrontDropId: dropId, updatedAt: timestamp })
      .storefrontDropId,
    dropId,
  );
});
