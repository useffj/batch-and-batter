import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { customerFixtures } from './customer-local-fixtures.mjs';
const require = createRequire(import.meta.url);
const { contactKey, lookupPartition } = require('../dist/src/customer-lookup');
const { PutCommand } = require('@aws-sdk/lib-dynamodb');
const f = await customerFixtures();
try {
  const before = await Promise.all(
    f.orders.map((o) => f.repository.get(o.orderId)),
  );
  for (const query of [
    'Michael Johnson',
    ' michael   JOHNSON ',
    'Michael',
    'Johnson',
    'MICHAEL@EXAMPLE.TEST',
  ]) {
    const r = await f.customers.search({ query });
    assert(r.contacts.some((c) => c.customer.email === 'michael@example.test'));
  }
  for (const query of ['Élodie O’Neil-Smith', 'ÉLODIE', 'O’Neil-Smith']) {
    const r = await f.customers.search({ query });
    assert.equal(r.contacts.length, 1);
    assert.equal(r.contacts[0].customer.email, 'elodie@example.test');
  }
  const first = await f.customers.search({ query: 'Michael' });
  assert(first.nextCursor);
  const next = await f.customers.search({
    query: 'Michael',
    cursor: first.nextCursor,
  });
  const all = [...first.contacts, ...next.contacts];
  assert.equal(new Set(all.map((c) => c.customer.email)).size, 2);
  const key = contactKey(f.orders[0].customer),
    h = await f.customers.history({ contactKey: key });
  assert.equal(h.orders.length, 20);
  assert(h.nextCursor);
  const second = await f.customers.history({
    contactKey: key,
    cursor: h.nextCursor,
  });
  const orders = [...h.orders, ...second.orders];
  assert.equal(orders.length, 23);
  assert(orders.every((o) => o.customer.email === 'michael@example.test'));
  assert.equal(new Set(orders.map((o) => o.dropName)).size, 2);
  assert(
    orders.every(
      (o) => o.totalCents === 945 && o.items[0].unitPriceCents === 425,
    ),
  );
  assert.equal(orders[0].orderId, f.orders[24].orderId);
  assert.equal(orders.at(-1).orderId, f.orders[0].orderId);
  assert(orders.every((o) => o.fulfillmentStatus === null));
  const { FulfillmentRepository } = require('../dist/src/admin-fulfillment');
  await new FulfillmentRepository(f.client, f.table).transition(
    f.orders[23].orderId,
    { requestId: randomUUID(), revision: 0, status: 'READY_FOR_PICKUP' },
    'synthetic-admin',
  );
  const recorded = (await f.customers.history({ contactKey: key })).orders.find(
    (o) => o.orderId === f.orders[23].orderId,
  );
  assert.equal(recorded.fulfillmentStatus, 'READY_FOR_PICKUP');
  assert.equal(
    recorded.fulfillment.history[0].administrator,
    'synthetic-admin',
  );
  await assert.rejects(
    f.customers.history({
      contactKey: contactKey(f.orders[3].customer),
      cursor: h.nextCursor,
    }),
  );
  assert.equal(
    (await f.customers.search({ query: 'Mich' })).contacts.length,
    0,
  );
  // Corrupt companion association must never disclose another contact's Order.
  await f.client.send(
    new PutCommand({
      TableName: f.table,
      Item: {
        PK: lookupPartition('contact', key),
        SK: 'ORDER#2099-01-01T00:00:00.000Z#' + f.orders[3].orderId,
        orderId: f.orders[3].orderId,
        contactKey: key,
      },
    }),
  );
  assert(
    (await f.customers.history({ contactKey: key })).orders.every(
      (o) => o.customer.email === 'michael@example.test',
    ),
  );
  assert.deepEqual(
    await Promise.all(f.orders.map((o) => f.repository.get(o.orderId))),
    before,
  );
  console.log(
    'Customer DynamoDB Local: full/token/email normalization, distinct contacts, two-Drop history, bounded pagination, malformed scope, poisoned lookup rejection and unchanged Orders passed.',
  );
} finally {
  await f.close();
}
