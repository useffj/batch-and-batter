import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { CartStore, pid, token, tokenHash } from './cart-store';
import { dropId, productId, otherProductId } from './fixtures';
import { cartKey, etag, type CartResult } from '../src/cart-domain';
import { catalogKeys } from '../src/keys';
import {
  expiryMessage,
  expiryMessageSchema,
  expiryKey,
  expiryShard,
  expiryWork,
  expiryDelay,
  type ExpiryMessage,
  type ExpiryDispatch,
} from '../src/cart-expiry';
import { ExpiryRepository } from '../src/expiry-repository';
import { createExpiryWorker } from '../src/expiry-worker';
import { ExpiryReconciler } from '../src/expiry-reconciler';
const metrics = () => ({ attempts: 0 });
class Dispatch implements ExpiryDispatch {
  sent: { message: ExpiryMessage; delay: number }[] = [];
  fail = false;
  async send(message: ExpiryMessage, delay: number) {
    if (this.fail) throw new Error(`private ${token}`);
    this.sent.push({ message, delay });
  }
}
const runtime = (s: CartStore) => ({
  now: () => s.now,
  monotonic: () => s.elapsed,
  random: () => 0.5,
  sleep: async (ms: number) => {
    s.sleeps.push(ms);
    await new Promise((resolve) => setImmediate(resolve));
  },
});
const client = (s: CartStore) =>
  ({ send: s.send.bind(s) }) as unknown as ConstructorParameters<
    typeof ExpiryRepository
  >[0];
const workerRepo = (s: CartStore) =>
  new ExpiryRepository(
    client(s),
    'catalog',
    'commerce',
    'operations',
    runtime(s),
  );
const reconcile = (s: CartStore, d: Dispatch) =>
  new ExpiryReconciler(client(s), 'operations', d, runtime(s));
const wake = (c: CartResult) =>
  expiryMessage(c.cart.cartId, c.cart.shoppingExpiresAt);
const release = (s: CartStore, c: CartResult) => ({
  operation: 'release' as const,
  cartId: c.cart.cartId,
  tokenHash,
  key: s.keyValue(),
});
const queue = 'arn:aws:sqs:us-east-2:123456789012:reservation';
const event = (message: unknown, arn = queue) => ({
  Records: [
    {
      messageId: 'message-1',
      eventSource: 'aws:sqs',
      eventSourceARN: arn,
      body: JSON.stringify(message),
      attributes: { ApproximateReceiveCount: '1' },
    },
  ],
});
const setup = async (count = 1) => {
  const s = new CartStore().seed(count);
  const c = await s.repository().mutate(
    s.request(
      Array.from({ length: count }, (_, i) => ({
        productId: pid(i + 2),
        quantity: 2,
      })),
    ),
    metrics(),
  );
  return { s, c, w: workerRepo(s), d: new Dispatch() };
};
test('canonical schema/shard and delay preserve instant; unknown fields and payment messages rejected', () => {
  const deadline = '2026-09-27T12:00:00.001Z';
  const id = pid(1);
  assert.equal(
    expiryShard(id),
    (createHash('sha256').update(id).digest()[0] & 15)
      .toString(16)
      .toUpperCase()
      .padStart(2, '0'),
  );
  assert.deepEqual(expiryKey(id, deadline), {
    PK: `CART_EXPIRY#V1#${expiryShard(id)}`,
    SK: `${deadline}#SHOPPING#${id}`,
  });
  assert.equal(expiryDelay(deadline, Date.parse(deadline) - 1), 1);
  assert.equal(expiryDelay(deadline, 0), 900);
  assert.equal(expiryDelay(deadline, Date.parse(deadline) + 1), 0);
  for (const m of [
    { ...expiryMessage(id, deadline), token },
    { ...expiryMessage(id, deadline), deadlineType: 'PAYMENT' },
    { ...expiryMessage(id, deadline), deadline: '2026-09-27T12:00:00Z' },
  ])
    assert.equal(expiryMessageSchema.safeParse(m).success, false);
});
test('work collision atomically rejects all create writes', async () => {
  const s = new CartStore().seed();
  s.before = (actions) => {
    const item = actions.at(-1)!.Put!.Item!;
    s.put('operations', item);
  };
  await assert.rejects(s.repository().mutate(s.request(), metrics()));
  assert.equal(s.commits, 0);
  s.invariants();
  assert.equal(
    [...s.rows.keys()].filter((k) => k.startsWith('commerce|')).length,
    0,
  );
});
test('committed creation survives dispatch failure/lost response and replay dispatches only outstanding work', async () => {
  const s = new CartStore().seed();
  const d = new Dispatch();
  d.fail = true;
  const r = s.repository(d);
  const req = s.request();
  s.after = () => {
    throw new Error('lost response');
  };
  const c = await r.mutate(req, metrics());
  s.after = undefined;
  assert.equal(c.status, 201);
  assert.ok(
    s.row('operations', expiryKey(c.cart.cartId, c.cart.shoppingExpiresAt)),
  );
  d.fail = false;
  assert.deepEqual(await r.mutate(req, metrics()), c);
  assert.equal(d.sent.length, 1);
  assert.equal(d.sent[0].delay, 480);
  await r.mutate(release(s, c), metrics());
  assert.deepEqual(await r.mutate(req, metrics()), c);
  assert.equal(d.sent.length, 1);
  s.invariants();
});
test('exact deadline releases every line atomically then duplicate uses ConditionCheck without ETag change', async () => {
  const { s, c, w } = await setup(2);
  s.now = Date.parse(c.cart.shoppingExpiresAt);
  const result = await w.expire(wake(c));
  assert.equal(result.outcome, 'expired');
  const actions = s.transactions.at(-1)!;
  assert.equal(actions.length, 4);
  assert.deepEqual(
    actions.slice(0, 2).map((a) => a.Put!.Item!.SK),
    [`INVENTORY#${productId}`, `INVENTORY#${otherProductId}`],
  );
  assert.equal(actions[2].Put!.Item!.status, 'EXPIRED');
  assert.ok(actions[3].Delete);
  assert.equal(
    s.row('operations', expiryKey(c.cart.cartId, c.cart.shoppingExpiresAt)),
    undefined,
  );
  const terminal = structuredClone(s.row('commerce', cartKey(c.cart.cartId)));
  assert.equal((await w.expire(wake(c))).outcome, 'terminal');
  assert.deepEqual(s.row('commerce', cartKey(c.cart.cartId)), terminal);
  assert.ok(s.transactions.at(-1)![0].ConditionCheck);
  assert.ok(s.transactions.at(-1)![1].Delete);
  s.invariants();
});
test('never early; early replacement must succeed before acknowledgment', async () => {
  const { s, c, w, d } = await setup();
  s.now = Date.parse(c.cart.shoppingExpiresAt) - 1;
  const handler = createExpiryWorker(w, d, queue, () => s.now);
  assert.deepEqual(await handler(event(wake(c))), { batchItemFailures: [] });
  assert.equal(d.sent[0].delay, 1);
  assert.equal(s.commits, 1);
  d.fail = true;
  assert.deepEqual(await handler(event(wake(c))), {
    batchItemFailures: [{ itemIdentifier: 'message-1' }],
  });
  assert.equal(s.commits, 1);
});
test('stale deadline cleans only obsolete work, retaining current ownership and revision', async () => {
  const { s, c, w } = await setup();
  const stale = expiryMessage(
    c.cart.cartId,
    new Date(Date.parse(c.cart.shoppingExpiresAt) - 1000).toISOString(),
  );
  s.put(
    'operations',
    expiryWork(stale.cartId, stale.deadline, c.cart.createdAt),
  );
  s.now = Date.parse(c.cart.shoppingExpiresAt) + 1;
  assert.equal((await w.expire(stale)).outcome, 'obsolete');
  assert.equal(
    s.row('commerce', cartKey(c.cart.cartId))!.updatedAt,
    c.cart.updatedAt,
  );
  assert.ok(
    s.row('operations', expiryKey(c.cart.cartId, c.cart.shoppingExpiresAt)),
  );
  s.invariants();
});
for (const status of ['PAUSED', 'CLOSED', 'OPEN'])
  test(`expiry ignores ${status} lifecycle, absent pointer and Product deactivation`, async () => {
    const { s, c, w } = await setup();
    s.row('catalog', catalogKeys.drop(dropId))!.status = status;
    s.row('catalog', catalogKeys.product(productId))!.active = false;
    s.rows.delete(s.key('catalog', catalogKeys.storefront));
    s.now = Date.parse(c.cart.shoppingExpiresAt);
    assert.equal((await w.expire(wake(c))).outcome, 'expired');
    s.invariants();
  });
test('CANCELLED cleanup cannot release twice and uses exact status/revision/deadline proof', async () => {
  const { s, c, w } = await setup();
  await s.repository().mutate(release(s, c), metrics());
  const before = structuredClone(s.row('commerce', cartKey(c.cart.cartId)));
  assert.equal((await w.expire(wake(c))).outcome, 'terminal');
  assert.deepEqual(s.row('commerce', cartKey(c.cart.cartId)), before);
  const check = s.transactions.at(-1)![0].ConditionCheck!;
  assert.deepEqual(check.ExpressionAttributeValues, {
    ':status': 'CANCELLED',
    ':updated': before!.updatedAt,
    ':expires': c.cart.shoppingExpiresAt,
  });
  s.invariants();
});
for (const fault of ['missing', 'malformed', 'future', 'inventory'])
  test(`${fault} persisted state fails closed retaining durable work`, async () => {
    const { s, c, w } = await setup();
    s.now = Date.parse(c.cart.shoppingExpiresAt);
    if (fault === 'missing')
      s.rows.delete(s.key('commerce', cartKey(c.cart.cartId)));
    if (fault === 'malformed')
      s.row('commerce', cartKey(c.cart.cartId))!.items = [];
    if (fault === 'future')
      s.row('commerce', cartKey(c.cart.cartId))!.status = 'PAYMENT_PENDING';
    if (fault === 'inventory')
      s.row('catalog', catalogKeys.inventory(dropId, productId))!.reserved = 0;
    await assert.rejects(w.expire(wake(c)));
    assert.equal(s.commits, 1);
    assert.ok(
      s.row('operations', expiryKey(c.cart.cartId, c.cart.shoppingExpiresAt)),
    );
  });
test('mismatched work rejects whole release, including all Inventory Puts', async () => {
  const { s, c, w } = await setup(2);
  s.now = Date.parse(c.cart.shoppingExpiresAt);
  s.row(
    'operations',
    expiryKey(c.cart.cartId, c.cart.shoppingExpiresAt),
  )!.cartId = pid(999);
  const before = structuredClone(s.rows);
  await assert.rejects(w.expire(wake(c)), /INVALID_WORK/);
  assert.deepEqual(s.rows, before);
});
test('inventory snapshot conflict retries fresh without partial multi-product release', async () => {
  const { s, c, w } = await setup(2);
  s.now = Date.parse(c.cart.shoppingExpiresAt);
  let once = true;
  s.before = () => {
    if (once) {
      once = false;
      s.row(
        'catalog',
        catalogKeys.inventory(dropId, otherProductId),
      )!.updatedAt = new Date(s.now + 1).toISOString();
    }
  };
  assert.equal((await w.expire(wake(c))).attempts, 2);
  assert.equal(s.commits, 2);
  s.invariants();
});
test('worker retries a newer Cart revision after a pre-deadline PUT commits first', async () => {
  const { s, c, w } = await setup();
  const deadline = Date.parse(c.cart.shoppingExpiresAt);
  s.now = deadline;
  s.before = async () => {
    s.before = undefined;
    s.now = deadline - 1;
    await s.repository().mutate(
      {
        operation: 'replace',
        cartId: c.cart.cartId,
        key: s.keyValue(),
        tokenHash,
        ifMatch: etag(c.cart.updatedAt),
        items: [{ productId, quantity: 5 }],
      },
      metrics(),
    );
    s.now = deadline;
  };
  assert.equal((await w.expire(wake(c))).attempts, 2);
  assert.equal(s.row('commerce', cartKey(c.cart.cartId))!.items[0].quantity, 5);
  s.invariants();
});
test('worker winning rejects stale PUT and later DELETE does not decrement', async () => {
  const { s, c, w } = await setup();
  s.now = Date.parse(c.cart.shoppingExpiresAt);
  await w.expire(wake(c));
  await assert.rejects(
    s.repository().mutate(
      {
        operation: 'replace',
        cartId: c.cart.cartId,
        key: s.keyValue(),
        tokenHash,
        ifMatch: etag(c.cart.updatedAt),
        items: [{ productId, quantity: 5 }],
      },
      metrics(),
    ),
  );
  await s.repository().mutate(release(s, c), metrics());
  s.invariants();
});
test('DELETE winning causes worker to reread terminal revision', async () => {
  const { s, c, w } = await setup();
  s.now = Date.parse(c.cart.shoppingExpiresAt);
  s.before = async () => {
    s.before = undefined;
    await s.repository().mutate(release(s, c), metrics());
  };
  assert.equal((await w.expire(wake(c))).outcome, 'terminal');
  assert.equal(
    s.row('operations', expiryKey(c.cart.cartId, c.cart.shoppingExpiresAt)),
    undefined,
  );
  s.invariants();
});
test('worker bounded contention fails safely and subsequent delivery settles', async () => {
  const { s, c, w } = await setup();
  s.now = Date.parse(c.cart.shoppingExpiresAt);
  s.forcedCode = 'TransactionConflict';
  await assert.rejects(w.expire(wake(c)), /RETRY_EXHAUSTED/);
  assert.equal(s.transactions.length, 7);
  assert.deepEqual(s.sleeps, [12.5, 25, 50, 100, 125]);
  s.forcedCode = undefined;
  await w.expire(wake(c));
  s.invariants();
});
test('ambiguous worker commit response is safe on retry', async () => {
  const { s, c, w } = await setup();
  s.now = Date.parse(c.cart.shoppingExpiresAt);
  s.after = () => {
    s.after = undefined;
    throw new Error('lost');
  };
  assert.equal((await w.expire(wake(c))).outcome, 'terminal');
  s.invariants();
});
test('strict internal boundary and malformed message handling never log secrets', async () => {
  const { s, c, w, d } = await setup();
  const handler = createExpiryWorker(w, d, queue, () => s.now);
  const logs: string[] = [];
  const old = console.info;
  console.info = (x) => logs.push(String(x));
  try {
    for (const input of [
      { ...event(wake(c)), requestContext: {} },
      event(wake(c), 'wrong'),
      { routeKey: 'POST /carts', body: JSON.stringify(wake(c)) },
    ])
      await assert.rejects(handler(input));
    for (const body of [
      { ...wake(c), token },
      { secret: token },
      { ...wake(c), deadlineType: 'PAYMENT' },
    ])
      assert.equal((await handler(event(body))).batchItemFailures.length, 1);
    d.fail = true;
    await handler(event(wake(c)));
    assert.ok(!logs.join('').includes(token));
    assert.ok(!logs.join('').includes(tokenHash));
    assert.equal(s.commits, 1);
  } finally {
    console.info = old;
  }
});
test('reconciler recovers never-sent work after outage longer than queue and DLQ retention, repeatedly until settled', async () => {
  const { s, c, w, d } = await setup();
  s.now += 20 * 86400000;
  await reconcile(s, d).run();
  assert.equal(d.sent.length, 1);
  assert.equal(d.sent[0].delay, 0);
  // Simulated DLQ/lost transport: outstanding work recreates a fresh wakeup.
  await reconcile(s, d).run();
  assert.equal(d.sent.length, 2);
  assert.ok(
    s.row('operations', expiryKey(c.cart.cartId, c.cart.shoppingExpiresAt)),
  );
  await w.expire(d.sent[1].message);
  await reconcile(s, d).run();
  assert.equal(d.sent.length, 2);
  s.invariants();
});
function seedShard(s: CartStore, n: number) {
  const ids: string[] = [];
  for (let i = 1000; ids.length < n; i++)
    if (expiryShard(pid(i)) === '00') ids.push(pid(i));
  const deadline = new Date(s.now - 1000).toISOString();
  for (const id of ids) s.put('operations', expiryWork(id, deadline, deadline));
  return { ids, deadline };
}
test('pagination respects 25/shard, resumes fixed cutoff, wraps to find insertion behind cursor', async () => {
  const s = new CartStore();
  const d = new Dispatch();
  s.queryPageSize = 3;
  const { ids, deadline } = seedShard(s, 30);
  await reconcile(s, d).run();
  assert.equal(d.sent.length, 25);
  const cursor = s.row('operations', {
    PK: 'CART_EXPIRY_RECONCILE#V1',
    SK: 'SHARD#00',
  })!;
  assert.ok(cursor.lastProcessedKey);
  const older = new Date(Date.parse(deadline) - 1000).toISOString();
  s.put('operations', expiryWork(ids[0], older, older));
  s.now += 60000;
  await reconcile(s, d).run();
  assert.equal(d.sent.length, 30);
  await reconcile(s, d).run();
  assert.ok(d.sent.some((x) => x.message.deadline === older));
  assert.ok(s.queries.some((q) => q.ExclusiveStartKey));
  assert.ok(s.queries.every((q) => q.ConsistentRead));
});
test('poison and send failures advance cursor but retain evidence and revisit next round', async () => {
  const s = new CartStore();
  const d = new Dispatch();
  const { ids, deadline } = seedShard(s, 30);
  s.row('operations', expiryKey(ids[0], deadline))!.schemaVersion = 999;
  d.fail = true;
  await assert.rejects(reconcile(s, d).run());
  assert.ok(
    s.row('operations', { PK: 'CART_EXPIRY_RECONCILE#V1', SK: 'SHARD#00' })!
      .lastProcessedKey,
  );
  d.fail = false;
  await reconcile(s, d).run();
  assert.equal(d.sent.length, 5);
  await reconcile(s, d).run();
  assert.equal(d.sent.length, 29);
  assert.ok(s.row('operations', expiryKey(ids[0], deadline)));
});
test('crash before cursor checkpoint repeats sends safely, never loses work', async () => {
  const s = new CartStore();
  const d = new Dispatch();
  seedShard(s, 3);
  let once = true;
  s.beforeCursor = () => {
    if (once) {
      once = false;
      throw new Error('crash');
    }
  };
  // Start at shard 00 to ensure the interrupted checkpoint contains work.
  s.now = Math.ceil(s.now / (16 * 60000)) * 16 * 60000;
  await assert.rejects(reconcile(s, d).run());
  assert.equal(d.sent.length, 3);
  s.beforeCursor = undefined;
  await reconcile(s, d).run();
  assert.equal(d.sent.length, 6);
});
test('100 simultaneous expirations maintain exact ACTIVE ownership after every commit', async () => {
  const s = new CartStore().seed(1, 100);
  const carts: CartResult[] = [];
  for (let i = 0; i < 100; i++)
    carts.push(
      await s
        .repository()
        .mutate(s.request([{ productId, quantity: 1 }]), metrics()),
    );
  s.now += 480000;
  let retries = 0;
  await Promise.all(
    carts.map(async (c) => {
      for (let i = 0; i < 100; i++) {
        try {
          await workerRepo(s).expire(wake(c));
          return;
        } catch (e) {
          assert.match(String(e), /RETRY_EXHAUSTED/);
          retries++;
        }
      }
      throw new Error('did not converge');
    }),
  );
  assert.ok(retries > 0);
  assert.equal(
    s.row('catalog', catalogKeys.inventory(dropId, productId))!.reserved,
    0,
  );
  assert.equal(
    [...s.rows.values()].filter((r) => r.status === 'ACTIVE').length,
    0,
  );
  s.invariants();
});

test('reconciliation time interruption checkpoints only examined keys, then resumes', async () => {
  const s = new CartStore();
  const d = new Dispatch();
  const { ids } = seedShard(s, 6);
  s.now = Math.ceil(s.now / (16 * 60000)) * 16 * 60000;
  const original = d.send.bind(d);
  let count = 0;
  d.send = async (m, delay) => {
    await original(m, delay);
    if (++count === 2) s.elapsed = 24200;
  };
  await reconcile(s, d).run();
  assert.equal(d.sent.length, 2);
  assert.equal(
    s
      .row('operations', { PK: 'CART_EXPIRY_RECONCILE#V1', SK: 'SHARD#00' })!
      .lastProcessedKey.SK.endsWith(ids[1]),
    true,
  );
  s.elapsed = 0;
  d.send = original;
  await reconcile(s, d).run();
  assert.equal(d.sent.length, 6);
});
test('future work is not dispatched; cursor compare-and-swap prevents concurrent overwrite', async () => {
  const s = new CartStore();
  const d = new Dispatch();
  const future = new Date(s.now + 480000).toISOString();
  s.put(
    'operations',
    expiryWork(pid(42), future, new Date(s.now).toISOString()),
  );
  await reconcile(s, d).run();
  assert.equal(d.sent.length, 0);
  const key = { PK: 'CART_EXPIRY_RECONCILE#V1', SK: 'SHARD#00' };
  let once = true;
  s.beforeCursor = () => {
    if (once) {
      once = false;
      s.row('operations', key)!.revision =
        '00000000-0000-4000-8000-000000000000';
    }
  };
  s.now = Math.ceil(s.now / (16 * 60000)) * 16 * 60000;
  await assert.rejects(reconcile(s, d).run());
  assert.equal(
    s.row('operations', key)!.revision,
    '00000000-0000-4000-8000-000000000000',
  );
});
test('obsolete cleanup revision conflict retries before deleting work; no Cart Put', async () => {
  const { s, c, w } = await setup();
  const msg = expiryMessage(
    c.cart.cartId,
    new Date(Date.parse(c.cart.shoppingExpiresAt) - 1000).toISOString(),
  );
  s.put('operations', expiryWork(msg.cartId, msg.deadline, c.cart.createdAt));
  let once = true;
  s.before = () => {
    if (once) {
      once = false;
      s.row('commerce', cartKey(c.cart.cartId))!.updatedAt = new Date(
        s.now + 1,
      ).toISOString();
    }
  };
  assert.equal((await w.expire(msg)).attempts, 2);
  assert.ok(
    s.transactions.slice(1).every((tx) => tx[0].ConditionCheck && tx[1].Delete),
  );
  s.invariants();
});
test('expiry safety margin refuses work without starting an AWS call', async () => {
  const { s, c, w } = await setup();
  const before = s.transactions.length;
  await assert.rejects(
    w.expire(wake(c), () => 500),
    /RETRY_EXHAUSTED/,
  );
  assert.equal(s.transactions.length, before);
});
