import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fixtures } from './orders-local-fixtures.mjs';
const require = createRequire(import.meta.url);
const { FulfillmentRepository } = require('../dist/src/admin-fulfillment');
const { readFulfillment } = require('../dist/src/fulfillment-state');
const { orderKey } = require('../dist/src/payment-domain');
const { GetCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');
const f = await fixtures();
const now = Date.parse('2026-10-25T20:00:00Z'),
  repo = new FulfillmentRepository(f.client, f.table, () => now);
const input = (revision, status, reason = '') => ({
  requestId: randomUUID(),
  revision,
  status,
  reason,
});
const move = (n, v) =>
  repo.transition(f.orders[n].orderId, v, 'synthetic-admin');
try {
  const before = await Promise.all(
    f.orders.map((o) => f.repository.get(o.orderId)),
  );
  const page = await repo.list('2026-10-22');
  assert(page.orders.length > 1);
  assert(
    page.orders.every(
      (o) =>
        o.status === 'PAID' &&
        o.paymentStatus === 'CAPTURED' &&
        o.items[0].quantity === 2,
    ),
  );
  const ready = input(0, 'READY_FOR_PICKUP');
  const saved = await move(1, ready);
  assert.equal(saved.revision, 1);
  assert.equal(saved.history[0].at, new Date(now).toISOString());
  assert.deepEqual(await move(1, ready), saved);
  await assert.rejects(move(1, { ...ready, status: 'MISSED_PICKUP' }));
  await assert.rejects(
    repo.transition(f.orders[1].orderId, ready, 'other-admin'),
  );
  assert.equal(
    (await readFulfillment(f.client, f.table, f.orders[1].orderId)).status,
    'READY_FOR_PICKUP',
  );
  const collected = await move(1, input(1, 'PICKED_UP'));
  assert.equal(collected.history.length, 2);
  assert.equal(collected.status, 'PICKED_UP');
  await assert.rejects(move(1, input(2, 'MISSED_PICKUP')));
  await move(3, input(0, 'MISSED_PICKUP'));
  await assert.rejects(move(3, input(1, 'PICKED_UP')));
  const late = await move(
    3,
    input(1, 'PICKED_UP', 'Customer arrived after window'),
  );
  assert.deepEqual(
    late.history.map((e) => e.status),
    ['MISSED_PICKUP', 'PICKED_UP'],
  );
  assert(late.history.every((e) => e.administrator === 'synthetic-admin'));
  await assert.rejects(move(0, input(0, 'READY_FOR_PICKUP')));
  await assert.rejects(move(5, input(0, 'PICKED_UP')));
  const early = new FulfillmentRepository(f.client, f.table, () =>
    Date.parse('2026-10-22T18:00:00Z'),
  );
  await assert.rejects(
    early.transition(
      f.orders[5].orderId,
      input(0, 'MISSED_PICKUP'),
      'synthetic-admin',
    ),
  );
  const races = await Promise.allSettled([
    move(5, input(0, 'READY_FOR_PICKUP')),
    move(5, input(0, 'MISSED_PICKUP')),
  ]);
  assert.equal(races.filter((x) => x.status === 'fulfilled').length, 1);
  await assert.rejects(move(5, input(0, 'READY_FOR_PICKUP')));
  const same = input(0, 'READY_FOR_PICKUP');
  const repeats = await Promise.allSettled([move(7, same), move(7, same)]);
  assert(repeats.some((x) => x.status === 'fulfilled'));
  assert.equal((await move(7, same)).history.length, 1);
  // Fulfillment touched no existing Order, totals, payment state or inventory record.
  assert.deepEqual(
    await Promise.all(f.orders.map((o) => f.repository.get(o.orderId))),
    before,
  );
  let injected = false;
  const raceClient = {
    send: async (command) => {
      if (command.constructor.name === 'TransactWriteCommand' && !injected) {
        injected = true;
        const key = orderKey(f.orders[9].orderId);
        const { Item } = await f.client.send(
          new GetCommand({ TableName: f.table, Key: key }),
        );
        await f.client.send(
          new PutCommand({
            TableName: f.table,
            Item: {
              ...Item,
              status: 'CANCELLED',
              paymentStatus: 'CANCELLED',
              updatedAt: new Date(now).toISOString(),
            },
          }),
        );
      }
      return f.client.send(command);
    },
  };
  await assert.rejects(
    new FulfillmentRepository(raceClient, f.table, () => now).transition(
      f.orders[9].orderId,
      input(0, 'READY_FOR_PICKUP'),
      'synthetic-admin',
    ),
  );
  assert.equal(
    await readFulfillment(f.client, f.table, f.orders[9].orderId),
    null,
  );
  await assert.rejects(move(9, input(0, 'READY_FOR_PICKUP')));
  console.log(
    'Fulfillment DynamoDB Local: 14 acceptance groups passed; payment/inventory isolation and concurrent cancellation verified.',
  );
} finally {
  await f.close();
}
