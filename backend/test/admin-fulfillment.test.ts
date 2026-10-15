import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickupEnded, fulfillmentRoutes } from '../src/admin-fulfillment';
import { createHandler, type ApiEvent } from '../src/api';
import { fakeRepository } from './fixtures';
for (const route of fulfillmentRoutes)
  test(route + ' fails closed before accessing fulfillment', async () => {
    const handler = createHandler(() => fakeRepository());
    const e: ApiEvent = {
      routeKey: route,
      requestContext: {
        requestId: 'synthetic',
        http: { method: route.split(' ')[0] },
      },
    };
    assert.equal((await handler(e)).statusCode, 401);
    e.requestContext.authorizer = {
      jwt: {
        claims: {
          token_use: 'access',
          sub: 'synthetic',
          username: 'synthetic',
          'cognito:groups': ['customer'],
        },
      },
    };
    assert.equal((await handler(e)).statusCode, 403);
  });
test('missed cutoff follows Denver winter/summer offsets and exact window end', () => {
  for (const [date, utc] of [
    ['2026-10-22', '2026-10-23T01:00:00Z'],
    ['2026-12-10', '2026-12-11T02:00:00Z'],
  ]) {
    const p = { date, endTime: '19:00', timezone: 'America/Denver' };
    assert.equal(pickupEnded(p, Date.parse(utc) - 1), false);
    assert.equal(pickupEnded(p, Date.parse(utc)), true);
  }
  assert.throws(() =>
    pickupEnded(
      { date: '2026-10-22', endTime: '19:00', timezone: 'UTC' },
      Date.now(),
    ),
  );
});

import { FulfillmentRepository } from '../src/admin-fulfillment';
import { randomUUID } from 'node:crypto';
function memory() {
  const rows = new Map<string, any>(),
    calls: any[] = [];
  let reject = false;
  const client = {
    send: async (c: any) => {
      calls.push(c);
      const i = c.input;
      if (c.constructor.name === 'GetCommand')
        return { Item: rows.get(i.Key.SK) };
      assert.equal(c.constructor.name, 'TransactWriteCommand');
      if (reject) throw Error('Conditional failure');
      for (const t of i.TransactItems)
        if (t.Put) rows.set(t.Put.Item.SK, structuredClone(t.Put.Item));
      return {};
    },
  };
  const repository = new FulfillmentRepository(client as any, 'local', () =>
    Date.parse('2026-10-25T20:00:00Z'),
  );
  const order = {
    orderId: '01K00000000000000000000001',
    status: 'PAID',
    paymentStatus: 'CAPTURED',
    updatedAt: '2026-10-22T18:00:00Z',
    pickup: {
      date: '2026-10-22',
      endTime: '19:00',
      timezone: 'America/Denver',
    },
  };
  (repository as any).orders = { get: async () => order };
  return {
    repository,
    order,
    rows,
    calls,
    fail: () => {
      reject = true;
    },
  };
}
const command = (revision: number, status: string, reason = '') => ({
  revision,
  status,
  reason,
  requestId: randomUUID(),
});
test('transaction guards payment and revision; only companion records are written', async () => {
  const f = memory();
  const r = await f.repository.transition(
    f.order.orderId,
    command(0, 'READY_FOR_PICKUP'),
    'admin',
  );
  const tx = f.calls.find((c) => c.constructor.name === 'TransactWriteCommand')
    .input.TransactItems;
  assert.equal(tx.length, 3);
  assert.deepEqual(tx[0].ConditionCheck.ExpressionAttributeValues, {
    ':paid': 'PAID',
    ':captured': 'CAPTURED',
    ':revision': f.order.updatedAt,
  });
  assert.equal(tx[0].ConditionCheck.Key.SK, 'META');
  assert(
    tx
      .slice(1)
      .every(
        (x: any) =>
          x.Put.TableName === 'local' &&
          x.Put.Item.SK.startsWith('FULFILLMENT') &&
          x.Put.ConditionExpression === 'attribute_not_exists(PK)',
      ),
  );
  assert.equal(r.history[0].administrator, 'admin');
});
test('receipt replay preserves original result after later state and rejects changed request/actor', async () => {
  const f = memory(),
    input = command(0, 'READY_FOR_PICKUP');
  const first = await f.repository.transition(f.order.orderId, input, 'admin');
  await f.repository.transition(
    f.order.orderId,
    command(1, 'PICKED_UP'),
    'admin',
  );
  assert.deepEqual(
    await f.repository.transition(f.order.orderId, input, 'admin'),
    first,
  );
  await assert.rejects(
    f.repository.transition(
      f.order.orderId,
      { ...input, status: 'MISSED_PICKUP' },
      'admin',
    ),
  );
  await assert.rejects(
    f.repository.transition(f.order.orderId, input, 'another'),
  );
  assert.equal(f.rows.get('FULFILLMENT').history.length, 2);
});
test('missed collection requires reason and retains history; collected is terminal', async () => {
  const f = memory();
  await f.repository.transition(
    f.order.orderId,
    command(0, 'MISSED_PICKUP'),
    'admin',
  );
  await assert.rejects(
    f.repository.transition(f.order.orderId, command(1, 'PICKED_UP'), 'admin'),
  );
  const r = await f.repository.transition(
    f.order.orderId,
    command(1, 'PICKED_UP', 'Late arrival'),
    'admin',
  );
  assert.deepEqual(
    r.history.map((e) => e.status),
    ['MISSED_PICKUP', 'PICKED_UP'],
  );
  await assert.rejects(
    f.repository.transition(
      f.order.orderId,
      command(2, 'READY_FOR_PICKUP'),
      'admin',
    ),
  );
});
test('ineligible payment, stale revision and failed atomic check never overwrite state', async () => {
  const f = memory();
  f.order.status = 'CANCELLED';
  await assert.rejects(
    f.repository.transition(
      f.order.orderId,
      command(0, 'READY_FOR_PICKUP'),
      'admin',
    ),
  );
  f.order.status = 'PAID';
  await assert.rejects(
    f.repository.transition(
      f.order.orderId,
      command(1, 'READY_FOR_PICKUP'),
      'admin',
    ),
  );
  f.fail();
  await assert.rejects(
    f.repository.transition(
      f.order.orderId,
      command(0, 'READY_FOR_PICKUP'),
      'admin',
    ),
  );
  assert.equal(f.rows.size, 0);
});
