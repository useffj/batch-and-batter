import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { CartStore, pid, tokenHash } = require('../dist/test/cart-store');
const { dropId, pickup } = require('../dist/test/fixtures');
const { catalogKeys } = require('../dist/src/keys');
const { PaymentRepository } = require('../dist/src/payment-repository');
const { etag } = require('../dist/src/cart-domain');
const { PutCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
import { fixtures } from './orders-local-fixtures.mjs';
const f = await fixtures();
try {
  const q = { dropId: f.drops[0].dropId };
  const first = await f.repository.list(q);
  assert.equal(first.orders.length, 20);
  assert(first.nextCursor);
  assert.equal(first.orders[0].orderId, f.orders[23].orderId);
  const second = await f.repository.list({ ...q, cursor: first.nextCursor });
  assert.equal(second.orders.length, 4);
  assert.equal(second.nextCursor, null);
  const other = await f.repository.list({ dropId: f.drops[1].dropId });
  assert.equal(other.orders.length, 1);
  const pickupPage = await f.repository.list({
    ...q,
    pickupDate: '2026-10-22',
    status: 'PAID',
  });
  assert.equal(pickupPage.orders.length, 12);
  const empty = await f.repository.list({ ...q, status: 'FAILED' });
  assert.equal(empty.orders.length, 0);
  assert(empty.nextCursor);
  await assert.rejects(
    f.repository.list({ ...q, status: 'PAID', cursor: first.nextCursor }),
  );
  const found = await f.repository.list({
    reference: f.orders[3].displayOrderNumber,
  });
  assert.equal(found.orders[0].orderId, f.orders[3].orderId);
  const detail = await f.repository.get(f.orders[3].orderId);
  assert.equal(detail.items[0].unitPriceCents, 425);
  assert.equal(detail.totalCents, 945);
  assert.equal(detail.customer.email, 'synthetic3@example.test');
  assert.equal(new Set(f.orders.map((o) => o.displayOrderNumber)).size, 25);
  assert.equal(await f.repository.get('01K00000000000000000000999'), null);
  const store = new CartStore().seed(1);
  store.put('catalog', {
    ...pickup,
    ...catalogKeys.pickup(dropId, pickup.date),
  });
  const created = await store
    .repository()
    .mutate(store.request([{ productId: pid(2), quantity: 2 }]), {
      attempts: 0,
    });
  for (const row of store.rows.values())
    await f.client.send(new PutCommand({ TableName: f.table, Item: row }));
  const writer = new PaymentRepository(
    f.client,
    f.table,
    f.table,
    f.table,
    { fixture: 'DEVELOPMENT_ONLY_ZERO_TAX_ZERO_FEE', currency: 'usd' },
    { now: () => store.now, id: () => pid(++store.sequence) },
    {
      retrieveConfirmationToken: async (id) => ({
        id,
        livemode: false,
        expiresAt: store.now + 3600000,
        paymentIntent: null,
        setupIntent: null,
        type: 'card',
      }),
    },
    'dev:local',
    true,
  );
  const input = {
    cartId: created.cart.cartId,
    tokenHash,
    key: store.keyValue(),
    ifMatch: etag(created.cart.updatedAt),
    pickupDate: pickup.date,
    customer: {
      name: 'Synthetic',
      email: 'synthetic@example.test',
      phone: '+15555550123',
      smsTransactionalConsent: false,
    },
    confirmationTokenId: 'ctoken_LocalFixture',
  };
  const result = await writer.start(input);
  const repeated = await writer.start(input);
  assert.deepEqual(repeated, result);
  const saved = await f.repository.get(result.cart.orderId);
  assert(saved.displayOrderNumber);
  const lookup = await f.repository.list({
    reference: saved.displayOrderNumber,
  });
  assert.equal(lookup.orders[0].orderId, saved.orderId);
  const originalStock = [...store.rows.values()].find((x) =>
    x.SK?.startsWith('INVENTORY#'),
  );
  const stock = (
    await f.client.send(
      new GetCommand({
        TableName: f.table,
        Key: { PK: originalStock.PK, SK: originalStock.SK },
        ConsistentRead: true,
      }),
    )
  ).Item;
  assert.deepEqual(stock, originalStock);
  console.log(
    'PASS: real local payment-start transaction, durable reference, replay and unchanged inventory.',
  );
  console.log(
    'PASS: two Drops, newest-first, exact reference, pickup/status, bounded/empty pagination, cursor scope, historical totals, missing order. Loopback only.',
  );
} finally {
  await f.close();
}
