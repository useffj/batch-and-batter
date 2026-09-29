import assert from 'node:assert/strict';
import { test } from 'node:test';
import { financialWorkMessage } from '../src/payment-routing';
import { paymentFixture } from './payment-execution-fixture';
import { ExpiryReconciler } from '../src/expiry-reconciler';
import { expiryKey, expiryWorkSchema } from '../src/cart-expiry';
import { pid } from './cart-store';
import {
  command,
  executionSchema,
  RETRY_HORIZON_MS,
} from '../src/payment-execution-domain';

test('routing recognizes PAYMENT, initial/revisioned workflow and STRIPE_EVENT; rejects wrong key', async () => {
  const f = await paymentFixture();
  await f.inbox.accept({
    eventId: 'evt_RouteFixture',
    intentId: 'pi_Fixture',
    eventType: 'payment_intent.created',
  });
  const rows = [...f.s.rows.values()].filter((r) => r.deadlineType);
  assert.deepEqual(
    rows
      .map(financialWorkMessage)
      .filter(Boolean)
      .map((m) => m!.kind)
      .sort(),
    ['PAYMENT', 'STRIPE_EVENT', 'WORKFLOW'],
  );
  await f.run();
  const row = f.s.row('operations', f.attempt().execution.workflow)!;
  assert.equal(financialWorkMessage(row)!.kind, 'WORKFLOW');
  assert.equal(
    financialWorkMessage({ ...row, PK: 'CART_EXPIRY#V1#bad' }),
    undefined,
  );
});
test('mixed local reconciler routing retains work, recovers failed sends and permits duplicate dispatch', async () => {
  const f = await paymentFixture();
  f.s.now += 300000;
  const at = new Date(f.s.now - 1000).toISOString();
  // Mix both classes in one shard/page without changing persisted business ownership.
  const shard = f.attempt().execution.workflow.PK;
  const ids = Array.from({ length: 1000 }, (_, i) => pid(i + 1000))
    .filter((id) => expiryKey(id, at).PK === shard)
    .slice(0, 4);
  for (const id of ids)
    f.s.put('operations', {
      ...expiryKey(id, at),
      ...expiryWorkSchema.parse({
        schemaVersion: 1,
        deadlineType: 'SHOPPING',
        cartId: id,
        deadline: at,
        createdAt: at,
      }),
    });
  const order: string[] = [];
  let fail = true;
  const runtime = {
    now: () => f.s.now,
    monotonic: () => 0,
    random: () => 0,
    sleep: async () => {},
  };
  const r = new ExpiryReconciler(
    f.client,
    'operations',
    {
      send: async () => {
        order.push('SHOPPING');
      },
    },
    runtime,
    {
      message: financialWorkMessage,
      send: async (m) => {
        order.push(m.kind);
        if (fail) throw new Error('queue unavailable');
      },
    },
  );
  await assert.rejects(r.run());
  const count = [...f.s.rows.values()].filter((r) => r.deadlineType).length;
  fail = false;
  await r.run();
  await r.run();
  assert.ok(order.includes('SHOPPING'));
  assert.ok(order.includes('PAYMENT'));
  assert.ok(order.includes('WORKFLOW'));
  assert.equal(
    [...f.s.rows.values()].filter((r) => r.deadlineType).length,
    count,
  );
  const firstShopping = order.indexOf('SHOPPING'),
    firstFinancial = order.indexOf('WORKFLOW');
  assert.ok(Math.abs(firstShopping - firstFinancial) <= 1);
});
test('maximum eight confirmation generations is valid and ninth is rejected; bounded serialized history', async () => {
  const f = await paymentFixture();
  await f.bind();
  const e = structuredClone(f.attempt().execution);
  e.confirmations = Array.from({ length: 8 }, (_, i) =>
    command('CONFIRM', f.cart().paymentAttemptId, i, f.s.now, e.intentId),
  );
  assert.equal(executionSchema.safeParse(e).success, true);
  assert.ok(Buffer.byteLength(JSON.stringify(e)) < 16000);
  e.confirmations.push(
    command('CONFIRM', f.cart().paymentAttemptId, 8, f.s.now, e.intentId),
  );
  assert.equal(executionSchema.safeParse(e).success, false);
  assert.equal(
    Date.parse(e.create.retryUntil) - Date.parse(e.create.createdAt),
    RETRY_HORIZON_MS,
  );
});

test('hung modeled financial dispatch cannot consume the reconciler runtime budget indefinitely', async () => {
  const f = await paymentFixture();
  f.s.now += 300000;
  const timeouts: number[] = [];
  const r = new ExpiryReconciler(
    f.client,
    'operations',
    { send: async () => {} },
    {
      now: () => f.s.now,
      monotonic: () => 0,
      random: () => 0,
      sleep: async () => {},
    },
    {
      message: financialWorkMessage,
      send: (_m, timeout) => {
        timeouts.push(timeout);
        return new Promise(() => {});
      },
    },
  );
  await assert.rejects(r.run(), /reconciliation incomplete/);
  assert.equal(timeouts.length, 2);
  assert.ok(timeouts.every((t) => t > 0 && t <= 400));
  assert.equal([...f.s.rows.values()].filter((r) => r.deadlineType).length, 2);
});
