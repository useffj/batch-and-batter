import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CartStore, pid, token, tokenHash } from './cart-store';
import { dropId, productId, pickup } from './fixtures';
import {
  cartKey,
  cartSchema,
  etag,
  ownsReserved,
  type Cart,
} from '../src/cart-domain';
import { catalogKeys } from '../src/keys';
import { PaymentRepository } from '../src/payment-repository';
import {
  attemptKey,
  orderKey,
  orderSchema,
  paymentAttemptSchema,
  paymentWork,
  paymentWorkSchema,
  workflowWorkSchema,
  modelCommitting,
  modelUnknownHardStop,
  paymentAmount,
  startPaymentSchema,
  type PaymentPricing,
} from '../src/payment-domain';
import {
  expiryKey,
  expiryMessage,
  expiryWork,
  expiryMessageSchema,
} from '../src/cart-expiry';
import { ExpiryRepository } from '../src/expiry-repository';
import { ExpiryReconciler } from '../src/expiry-reconciler';
import { createExpiryWorker } from '../src/expiry-worker';
import { localPaymentApi } from '../src/payment-api';
import { createHandler, type ApiEvent } from '../src/api';
import type {
  PaymentProvider,
  AuthorizedPaymentCommand,
  IntentSnapshot,
} from '../src/payment-provider';

const DEVELOPMENT_ONLY_ZERO_TAX_ZERO_FEE: PaymentPricing = {
  fixture: 'DEVELOPMENT_ONLY_ZERO_TAX_ZERO_FEE',
  currency: 'usd',
};
const customer = {
  name: 'Local Fixture',
  email: 'local@example.test',
  phone: '+15555550123',
  smsTransactionalConsent: false,
};
const client = (s: CartStore) =>
  ({ send: s.send.bind(s) }) as unknown as ConstructorParameters<
    typeof PaymentRepository
  >[0];
const expiry = (s: CartStore) =>
  new ExpiryRepository(client(s), 'catalog', 'commerce', 'operations', {
    now: () => s.now,
    monotonic: () => s.elapsed,
    random: () => 0,
    sleep: async () => {},
  });
async function setup(count = 1) {
  const s = new CartStore().seed(count);
  s.put('catalog', { ...pickup, ...catalogKeys.pickup(dropId, pickup.date) });
  const created = await s.repository().mutate(
    s.request(
      Array.from({ length: count }, (_, i) => ({
        productId: pid(i + 2),
        quantity: 2,
      })),
    ),
    { attempts: 0 },
  );
  const repo = new PaymentRepository(
    client(s),
    'catalog',
    'commerce',
    'operations',
    DEVELOPMENT_ONLY_ZERO_TAX_ZERO_FEE,
    { now: () => s.now, id: () => pid(++s.sequence) },
    {
      retrieveConfirmationToken: async (id) => ({
        id,
        livemode: false,
        expiresAt: s.now + 3600000,
        paymentIntent: null,
        setupIntent: null,
        type: 'card',
      }),
    },
    'dev:local',
    true,
  );
  const request = {
    cartId: created.cart.cartId,
    tokenHash,
    key: s.keyValue(),
    ifMatch: etag(created.cart.updatedAt),
    pickupDate: pickup.date,
    customer,
    confirmationTokenId: 'ctoken_LocalFixture',
  };
  const cart = () =>
    cartSchema.parse(
      (({ PK, SK, ...row }) => row)(
        s.row('commerce', cartKey(created.cart.cartId))!,
      ),
    );
  const inventory = () =>
    s.row('catalog', catalogKeys.inventory(dropId, productId))!;
  return { s, repo, request, created, cart, inventory };
}
const fails = (code: string) => (e: unknown) =>
  (e as { code?: string })?.code === code;

test('handoff freezes snapshots, owns inventory, creates eleven distinct atomic actions including submission ownership and three durable records', async () => {
  const { s, repo, request, created, cart, inventory } = await setup(12);
  const stock = structuredClone(
    [...s.rows].filter(([k]) => k.includes('|INVENTORY#')),
  );
  s.now += 10;
  const result = await repo.start(request);
  const c = cart();
  assert.equal(result.status, 201);
  assert.equal(c.status, 'PAYMENT_PENDING');
  assert.equal(c.paymentGraceUsed, true);
  assert.equal(c.paymentDeadline, new Date(s.now + 240000).toISOString());
  assert.equal(c.shoppingExpiresAt, created.cart.shoppingExpiresAt);
  assert.deepEqual(
    [...s.rows].filter(([k]) => k.includes('|INVENTORY#')),
    stock,
  );
  const { PK, SK, ...attempt } = s.row(
    'commerce',
    attemptKey(c.paymentAttemptId!),
  )!;
  assert.equal(paymentAttemptSchema.parse(attempt).status, 'CREATED');
  const { PK: op, SK: os, ...order } = s.row('commerce', orderKey(c.orderId!))!;
  const o = orderSchema.parse(order);
  assert.equal(o.status, 'PAYMENT_PENDING');
  assert.equal(o.totalCents, 10800);
  assert.equal(o.taxCents, 0);
  assert.equal(o.feeCents, 0);
  assert.equal(o.pickup.location, 'Test location');
  assert.equal(
    s.row('operations', expiryKey(c.cartId, c.shoppingExpiresAt)),
    undefined,
  );
  const work = paymentWork(c);
  assert.ok(s.row('operations', work.deadline));
  assert.ok(s.row('operations', work.workflow));
  assert.equal(work.workflow.deadline, c.paymentStartedAt);
  const actions = s.transactions.at(-1)!;
  assert.equal(actions.length, 11);
  assert.deepEqual(
    actions.map((a) =>
      a.Put ? 'Put' : a.Delete ? 'Delete' : 'ConditionCheck',
    ),
    [
      'ConditionCheck',
      'ConditionCheck',
      'ConditionCheck',
      'Put',
      'Put',
      'Put',
      'Delete',
      'Put',
      'Put',
      'Put',
      'Put',
    ],
  );
  assert.equal(
    actions[3].Put!.ExpressionAttributeValues![':expected'],
    created.cart.updatedAt,
  );
  assert.equal(
    actions[3].Put!.ExpressionAttributeValues![':now'],
    c.paymentStartedAt,
  );
  assert.match(
    actions[3].Put!.ConditionExpression!,
    /attribute_not_exists\(#grace\)/,
  );
  assert.ok(!actions.some((a) => a.Put?.Item?.SK?.startsWith('INVENTORY#')));
  assert.ok(!JSON.stringify(result).includes(tokenHash));
  assert.ok(!JSON.stringify(actions[9].Put!.Item).includes(customer.email));
  assert.ok(!JSON.stringify(actions[9].Put!.Item).includes(request.key));
  s.row('catalog', catalogKeys.product(productId))!.name = 'Changed';
  assert.equal(o.items[0].name, 'Cookie');
  assert.equal(inventory().reserved, 2);
});
for (let index = 0; index < 11; index++)
  test(`failure at handoff action ${index} rolls back every ownership/order/work write`, async () => {
    const { s, repo, request } = await setup();
    const before = structuredClone(s.rows);
    s.before = (actions) => {
      const op =
        actions[index].Put ??
        actions[index].Delete ??
        actions[index].ConditionCheck!;
      op.ConditionExpression = '#missing = :value';
      op.ExpressionAttributeNames = { '#missing': 'notPresent' };
      op.ExpressionAttributeValues = { ':value': 'never' };
    };
    await assert.rejects(repo.start(request));
    assert.deepEqual(s.rows, before);
  });
for (const offset of [-1, 0, 1])
  test(`shopping deadline boundary ${offset}ms`, async () => {
    const { s, repo, request, created } = await setup();
    s.now = Date.parse(created.cart.shoppingExpiresAt) + offset;
    if (offset < 0)
      assert.equal((await repo.start(request)).cart.status, 'PAYMENT_PENDING');
    else
      await assert.rejects(repo.start(request), fails('RESERVATION_EXPIRED'));
  });
test('replay returns stable attempt/order/deadline even after deadline; new key cannot restart grace', async () => {
  const { s, repo, request } = await setup();
  const first = await repo.start(request);
  const commits = s.commits;
  s.now += 300000;
  assert.deepEqual(await repo.start(request), first);
  assert.equal(s.commits, commits);
  await assert.rejects(
    repo.start({ ...request, key: s.keyValue() }),
    fails('PAYMENT_ALREADY_STARTED'),
  );
  await assert.rejects(
    repo.start({ ...request, customer: { ...customer, name: 'Different' } }),
    fails('IDEMPOTENCY_CONFLICT'),
  );
  await assert.rejects(
    repo.start({ ...request, tokenHash: 'f'.repeat(64) }),
    fails('UNAUTHORIZED'),
  );
});
test('lost transaction response resolves committed receipt without another Order', async () => {
  const { s, repo, request } = await setup();
  s.after = () => {
    s.after = undefined;
    throw new Error('lost response');
  };
  const first = await repo.start(request);
  assert.deepEqual(await repo.start(request), first);
  assert.equal(
    [...s.rows.keys()].filter((k) => k.includes('|ORDER#')).length,
    1,
  );
});
for (const sameKey of [true, false])
  test(`two concurrent tabs, same key=${sameKey}, one handoff`, async () => {
    const { s, repo, request } = await setup();
    const results = await Promise.allSettled([
      repo.start(request),
      repo.start({ ...request, key: sameKey ? request.key : s.keyValue() }),
    ]);
    assert.equal(
      results.filter((r) => r.status === 'fulfilled').length,
      sameKey ? 2 : 1,
    );
    if (!sameKey)
      assert.ok(
        results.some(
          (r) =>
            r.status === 'rejected' &&
            fails('PAYMENT_ALREADY_STARTED')(r.reason),
        ),
      );
    assert.equal(
      [...s.rows.keys()].filter((k) => k.includes('|ORDER#')).length,
      1,
    );
    assert.equal(
      [...s.rows.keys()].filter((k) => k.includes('|PAYMENT_ATTEMPT#')).length,
      1,
    );
  });
for (const status of ['PAUSED', 'CLOSED'])
  test(`${status} rejects new start; lifecycle race rejects atomically`, async () => {
    const { s, repo, request } = await setup();
    const d = s.row('catalog', catalogKeys.drop(dropId))!;
    d.status = status;
    await assert.rejects(repo.start(request), fails('DROP_NOT_OPEN'));
    d.status = 'OPEN';
    s.before = () => {
      s.before = undefined;
      d.status = status;
      d.updatedAt = new Date(s.now + 1).toISOString();
      if (status === 'CLOSED')
        s.rows.delete(s.key('catalog', catalogKeys.storefront));
    };
    await assert.rejects(repo.start(request), fails('DROP_NOT_OPEN'));
    assert.equal(
      [...s.rows.keys()].filter((k) => k.includes('|ORDER#')).length,
      0,
    );
  });
for (const status of ['PAUSED', 'CLOSED'])
  test(`started ownership survives later ${status}, storefront removal and Product deactivation`, async () => {
    const { s, repo, request, cart, inventory } = await setup();
    await repo.start(request);
    const original = cart();
    s.row('catalog', catalogKeys.drop(dropId))!.status = status;
    s.rows.delete(s.key('catalog', catalogKeys.storefront));
    s.row('catalog', catalogKeys.product(productId))!.active = false;
    s.now += 600000;
    assert.equal(
      (await repo.get(original.cartId, tokenHash)).cart.status,
      'PAYMENT_PENDING',
    );
    assert.deepEqual(cart(), original);
    assert.equal(inventory().reserved, 2);
  });
for (const winner of ['PUT', 'DELETE', 'EXPIRY'])
  test(`${winner} wins before payment transaction; handoff cannot use stale revision`, async () => {
    const { s, repo, request, created } = await setup();
    s.before = async () => {
      s.before = undefined;
      if (winner === 'PUT')
        await s.repository().mutate(
          {
            operation: 'replace',
            cartId: request.cartId,
            tokenHash,
            key: s.keyValue(),
            ifMatch: request.ifMatch,
            items: [{ productId, quantity: 1 }],
          },
          { attempts: 0 },
        );
      if (winner === 'DELETE')
        await s.repository().mutate(
          {
            operation: 'release',
            cartId: request.cartId,
            tokenHash,
            key: s.keyValue(),
          },
          { attempts: 0 },
        );
      if (winner === 'EXPIRY') {
        s.now = Date.parse(created.cart.shoppingExpiresAt);
        await expiry(s).expire(
          expiryMessage(request.cartId, created.cart.shoppingExpiresAt),
        );
      }
    };
    await assert.rejects(repo.start(request), fails('CART_CONFLICT'));
    assert.equal(
      [...s.rows.keys()].filter((k) => k.includes('|ORDER#')).length,
      0,
    );
  });
test('payment wins before pending PUT and DELETE transactions, both fail without changing stock', async () => {
  for (const operation of ['replace', 'release'] as const) {
    const { s, repo, request, inventory } = await setup();
    s.before = async () => {
      s.before = undefined;
      await repo.start(request);
    };
    await assert.rejects(
      s.repository().mutate(
        {
          operation,
          cartId: request.cartId,
          tokenHash,
          key: s.keyValue(),
          ifMatch: request.ifMatch,
          items: [{ productId, quantity: 1 }],
        },
        { attempts: 0 },
      ),
      fails('CART_CONFLICT'),
    );
    assert.equal(inventory().reserved, 2);
  }
});
for (const status of ['PAYMENT_PENDING', 'PAYMENT_COMMITTING'] as const)
  test(`${status}: GET not shopping-expired, DELETE rejected, old SHOPPING cleanup cannot release`, async () => {
    const { s, repo, request, cart, inventory } = await setup();
    await repo.start(request);
    let c = cart();
    if (status === 'PAYMENT_COMMITTING') {
      c = modelCommitting(c, c.paymentStartedAt!);
      s.put('commerce', { ...c, ...cartKey(c.cartId) });
    }
    s.now = Date.parse(c.shoppingExpiresAt) + 100000;
    assert.equal(
      (await s.repository().get(c.cartId, tokenHash)).expired,
      false,
    );
    await assert.rejects(
      s.repository().mutate(
        {
          operation: 'release',
          cartId: c.cartId,
          tokenHash,
          key: s.keyValue(),
        },
        { attempts: 0 },
      ),
      fails('CART_CONFLICT'),
    );
    // Simulate a still-present obsolete work record, then prove only that record can disappear.
    s.put('operations', expiryWork(c.cartId, c.shoppingExpiresAt, c.createdAt));
    const before = cart();
    await expiry(s).expire(expiryMessage(c.cartId, c.shoppingExpiresAt));
    assert.deepEqual(cart(), before);
    assert.equal(inventory().reserved, 2);
    assert.ok(s.row('operations', paymentWork(c).deadline));
    assert.equal(
      s.transactions.at(-1)![0].ConditionCheck?.Key?.PK,
      `CART#${c.cartId}`,
    );
  });
test('expiry already reading ACTIVE loses to payment and retries as obsolete cleanup', async () => {
  const { s, repo, request, created, inventory } = await setup();
  const deadline = Date.parse(created.cart.shoppingExpiresAt);
  // Worker read is due; payment had validated before the deadline and wins its revision.
  s.now = deadline;
  s.before = async () => {
    s.before = undefined;
    s.now = deadline - 1;
    await repo.start(request);
    s.now = deadline;
  };
  await expiry(s).expire(
    expiryMessage(request.cartId, created.cart.shoppingExpiresAt),
  );
  assert.equal(inventory().reserved, 2);
});
test('payment work validates without secrets; reconciler retains both work kinds without dispatch', async () => {
  const { s, repo, request, cart } = await setup();
  await repo.start(request);
  const work = paymentWork(cart());
  const { PK, SK, ...deadline } = work.deadline;
  assert.ok(paymentWorkSchema.safeParse(deadline).success);
  const { PK: wp, SK: ws, ...workflow } = work.workflow;
  assert.ok(workflowWorkSchema.safeParse(workflow).success);
  assert.equal(
    expiryMessageSchema.safeParse({
      ...deadline,
      source: 'batch-and-batter.cart-expiry',
      operation: 'expireCart',
    }).success,
    false,
  );
  s.now += 240000;
  let sent = 0;
  const reconciler = new ExpiryReconciler(
    client(s),
    'operations',
    {
      send: async () => {
        sent++;
      },
    },
    {
      now: () => s.now,
      monotonic: () => 0,
      random: () => 0,
      sleep: async () => {},
    },
  );
  const result = await reconciler.run();
  assert.equal(result.invalid, 0);
  assert.equal(result.examined, 2);
  assert.equal(sent, 0);
  assert.ok(s.row('operations', work.deadline));
  assert.ok(s.row('operations', work.workflow));
});
test('PAYMENT wake-up is recognized but fails closed without work deletion or provider call', async () => {
  const { s, repo, request, cart } = await setup();
  await repo.start(request);
  const c = cart();
  const rows = structuredClone(s.rows);
  const worker = createExpiryWorker(
    expiry(s),
    {
      send: async () => {
        throw new Error('unexpected dispatch');
      },
    },
    'queue',
  );
  const result = await worker({
    Records: [
      {
        messageId: 'm',
        eventSource: 'aws:sqs',
        eventSourceARN: 'queue',
        attributes: { ApproximateReceiveCount: '1' },
        body: JSON.stringify({
          schemaVersion: 2,
          source: 'batch-and-batter.cart-expiry',
          operation: 'processPayment',
          cartId: c.cartId,
          paymentAttemptId: c.paymentAttemptId,
          deadlineType: 'PAYMENT',
          deadline: c.paymentDeadline,
        }),
      },
    ],
  });
  assert.deepEqual(result, { batchItemFailures: [{ itemIdentifier: 'm' }] });
  assert.deepEqual(s.rows, rows);
});
test('hard-stop model preserves ownership/work, freezes 120 seconds, prohibits new financial commands', async () => {
  const { repo, request, cart, s, inventory } = await setup();
  await repo.start(request);
  const pending = cart();
  const c = modelCommitting(pending, pending.paymentDeadline!);
  assert.equal(
    Date.parse(c.committingDeadline!) - Date.parse(c.committingStartedAt!),
    120000,
  );
  assert.deepEqual(modelCommitting(c, new Date(s.now + 1).toISOString()), c);
  const result = modelUnknownHardStop(c, Date.parse(c.committingDeadline!));
  assert.equal(result.cart.status, 'PAYMENT_COMMITTING');
  assert.equal(result.cart.recoveryRequired, true);
  assert.equal(result.allowFinancialCommands, false);
  assert.equal(result.releaseInventory, false);
  assert.equal(result.sellInventory, false);
  assert.equal(result.retainWork, true);
  assert.equal(result.reconcile, true);
  assert.equal(inventory().reserved, 2);
  assert.ok(s.row('operations', paymentWork(pending).workflow));
  assert.throws(() =>
    modelUnknownHardStop(c, Date.parse(c.committingDeadline!) - 1),
  );
});
for (const state of [
  'ACTIVE',
  'PAYMENT_PENDING',
  'PAYMENT_COMMITTING',
  'CONVERTED',
  'EXPIRED',
  'CANCELLED',
] as const)
  test(`ownership ${state}`, () =>
    assert.equal(
      ownsReserved(state),
      ['ACTIVE', 'PAYMENT_PENDING', 'PAYMENT_COMMITTING'].includes(state),
    ));
for (const injection of [
  'amount',
  'price',
  'tax',
  'fee',
  'currency',
  'deadline',
  'orderId',
])
  test(`checkout rejects client ${injection}`, () =>
    assert.equal(
      startPaymentSchema.safeParse({
        confirmationTokenId: 'ctoken_LocalFixture',
        pickupDate: pickup.date,
        customer,
        [injection]: 123,
      }).success,
      false,
    ));
test('amount uses accepted snapshots and rejects overflow/implicit production pricing', async () => {
  const { cart } = await setup();
  const c = cart();
  assert.equal(
    paymentAmount(c, DEVELOPMENT_ONLY_ZERO_TAX_ZERO_FEE).totalCents,
    900,
  );
  assert.throws(() =>
    paymentAmount(
      { ...c, items: [{ ...c.items[0], quantity: Number.MAX_SAFE_INTEGER }] },
      DEVELOPMENT_ONLY_ZERO_TAX_ZERO_FEE,
    ),
  );
  assert.throws(() =>
    paymentAmount(c, { currency: 'usd', fixture: 'production' } as any),
  );
});
test('strict state validation rejects incomplete payment ownership and illegal committing fields', async () => {
  const { cart, repo, request } = await setup();
  const c = cart();
  assert.equal(
    cartSchema.safeParse({ ...c, status: 'PAYMENT_PENDING' }).success,
    false,
  );
  await repo.start(request);
  const p = cart();
  assert.equal(cartSchema.safeParse({ ...p, status: 'ACTIVE' }).success, false);
  assert.equal(
    cartSchema.safeParse({ ...p, status: 'PAYMENT_COMMITTING' }).success,
    false,
  );
  assert.equal(
    cartSchema.safeParse({
      ...p,
      paymentDeadline: new Date(
        Date.parse(p.paymentDeadline!) + 1,
      ).toISOString(),
    }).success,
    false,
  );
});
test('local API safe DTO/logs and production entrypoint leaves payment routes unmatched', async () => {
  const { s, repo, request } = await setup();
  const event: ApiEvent = {
    routeKey: 'POST /carts/{cartId}/payment/start',
    requestContext: { requestId: 'safe', http: { method: 'POST' } },
    headers: {
      'X-Cart-Token': token,
      'Idempotency-Key': request.key,
      'If-Match': request.ifMatch,
    },
    pathParameters: { cartId: request.cartId },
    body: JSON.stringify({
      pickupDate: pickup.date,
      customer,
      confirmationTokenId: request.confirmationTokenId,
    }),
  };
  const logs: string[] = [];
  const original = console.info;
  console.info = (s) => logs.push(String(s));
  try {
    const response = await localPaymentApi(event, repo);
    assert.equal(response.statusCode, 201);
    for (const secret of [
      token,
      tokenHash,
      request.key,
      customer.email,
      customer.phone,
    ]) {
      assert.ok(!logs.join('').includes(secret));
      assert.ok(!response.body.includes(secret));
    }
  } finally {
    console.info = original;
  }
  const handler = createHandler(() => {
    throw new Error('No production payment dependencies');
  });
  for (const routeKey of [
    'POST /carts/{cartId}/payment/start',
    'GET /carts/{cartId}/payment',
  ])
    assert.equal(
      (
        await handler({
          ...event,
          routeKey,
          requestContext: {
            ...event.requestContext,
            http: { method: routeKey.split(' ')[0] },
          },
        })
      ).statusCode,
      404,
    );
});
// Deterministic port implementation: never imported by a runtime entrypoint.
class FakeProvider implements PaymentProvider {
  async retrieveConfirmationToken(id: string) {
    return {
      id,
      livemode: false as const,
      expiresAt: Date.now() + 3600000,
      paymentIntent: null,
      setupIntent: null,
      type: 'card' as const,
    };
  }
  async customerAction() {
    return { intent: this.result, clientSecret: null };
  }
  calls: string[] = [];
  private result: IntentSnapshot = {
    id: 'local-test-only',
    status: 'requires_confirmation',
    amountCents: 900,
    amountReceivedCents: 0,
    currency: 'usd',
    captureMethod: 'manual',
    confirmationMethod: 'automatic',
    amountCapturableCents: 900,
    livemode: false,
    metadata: {
      environment: 'dev',
      cartId: pid(100),
      orderId: pid(101),
      paymentAttemptId: pid(102),
      dropId,
    },
  };
  async createIntent(c: AuthorizedPaymentCommand) {
    this.calls.push('create');
    return { ...this.result, amountCents: c.amountCents, currency: c.currency };
  }
  async retrieveIntent() {
    this.calls.push('retrieve');
    return this.result;
  }
  async confirmIntent() {
    this.calls.push('confirm');
    return { ...this.result, status: 'requires_capture' as const };
  }
  async captureIntent() {
    this.calls.push('capture');
    return {
      ...this.result,
      status: 'succeeded' as const,
      amountReceivedCents: 900,
    };
  }
  async cancelIntent() {
    this.calls.push('cancel');
    return { ...this.result, status: 'canceled' as const };
  }
}
test('provider port fake is deterministic and cannot be reached by handoff', async () => {
  const provider = new FakeProvider();
  const { repo, request } = await setup();
  await repo.start(request);
  assert.deepEqual(provider.calls, []);
  assert.equal((await provider.retrieveIntent()).captureMethod, 'manual');
  assert.equal((await provider.confirmIntent()).status, 'requires_capture');
});

for (const field of [
  'dropId',
  'date',
  'active',
  'startTime',
  'endTime',
  'timezone',
])
  test(`pickup snapshot check rejects concurrent ${field} mutation`, async () => {
    const { s, repo, request } = await setup();
    const before = structuredClone(s.row('commerce', cartKey(request.cartId)));
    s.before = () => {
      s.before = undefined;
      const row = s.row('catalog', catalogKeys.pickup(dropId, pickup.date))!;
      row[field] =
        field === 'active'
          ? false
          : field === 'dropId'
            ? pid(50)
            : field === 'date'
              ? '2026-10-02'
              : field === 'timezone'
                ? 'UTC'
                : '15:00';
    };
    await assert.rejects(repo.start(request), fails('INVALID_PICKUP_DATE'));
    assert.deepEqual(s.row('commerce', cartKey(request.cartId)), before);
  });
for (const state of ['CONVERTED', 'CANCELLED', 'EXPIRED'] as const)
  test(`${state} old SHOPPING cleanup never changes inventory or Cart`, async () => {
    const { s, repo, request, cart, inventory } = await setup();
    await repo.start(request);
    const pending = cart();
    // Future terminal fixture: quantities already atomically settled, never a Phase 5B1 writer.
    const terminal = { ...pending, status: state };
    s.put('commerce', { ...terminal, ...cartKey(terminal.cartId) });
    inventory().reserved = 0;
    if (state === 'CONVERTED') inventory().sold = 2;
    s.put(
      'operations',
      expiryWork(
        terminal.cartId,
        terminal.shoppingExpiresAt,
        terminal.createdAt,
      ),
    );
    const stock = structuredClone(inventory());
    await expiry(s).expire(
      expiryMessage(terminal.cartId, terminal.shoppingExpiresAt),
    );
    assert.deepEqual(inventory(), stock);
    assert.deepEqual(cart(), terminal);
    if (state === 'CONVERTED')
      await assert.rejects(
        s.repository().mutate(
          {
            operation: 'release',
            cartId: terminal.cartId,
            tokenHash,
            key: s.keyValue(),
          },
          { attempts: 0 },
        ),
        fails('CART_CONFLICT'),
      );
  });
test('pickup belongs to Drop, must be active, and published window must not have ended', async () => {
  for (const invalid of ['missing', 'inactive', 'ended']) {
    const { s, repo, request } = await setup();
    const key = catalogKeys.pickup(dropId, pickup.date);
    if (invalid === 'missing') s.rows.delete(s.key('catalog', key));
    if (invalid === 'inactive') s.row('catalog', key)!.active = false;
    if (invalid === 'ended') {
      const row = s.row('catalog', key)!;
      s.rows.delete(s.key('catalog', key));
      row.date = '2026-09-21';
      Object.assign(row, catalogKeys.pickup(dropId, row.date));
      s.put('catalog', row);
      request.pickupDate = row.date;
    }
    await assert.rejects(repo.start(request), fails('INVALID_PICKUP_DATE'));
  }
});
test('current Cart accepted price wins over subsequently changed catalog price', async () => {
  const { s, repo, request, cart } = await setup();
  s.row('catalog', catalogKeys.dropProduct(dropId, productId))!.priceCents =
    999;
  await repo.start(request);
  assert.equal(
    s.row('commerce', orderKey(cart().orderId!))!.subtotalCents,
    900,
  );
});
test('local GET exposes safe payment deadline without contact information or recovery flags', async () => {
  const { repo, request, s, cart } = await setup();
  await repo.start(request);
  const c = modelCommitting(cart(), cart().paymentStartedAt!);
  const recovery = modelUnknownHardStop(c, Date.parse(c.committingDeadline!));
  s.put('commerce', { ...recovery.cart, ...cartKey(c.cartId) });
  const response = await localPaymentApi(
    {
      routeKey: 'GET /carts/{cartId}/payment',
      requestContext: { requestId: 'safe', http: { method: 'GET' } },
      headers: { 'x-cart-token': token },
      pathParameters: { cartId: c.cartId },
    },
    repo,
  );
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.cart.status, 'PAYMENT_COMMITTING');
  assert.equal(body.payment.paymentDeadline, c.paymentDeadline);
  for (const forbidden of [
    'managementTokenHash',
    'recoveryRequired',
    'recoveryReason',
    'PK',
    'SK',
    customer.email,
    customer.phone,
    token,
  ])
    assert.ok(!response.body.includes(forbidden));
});
test('storefront guard, expired idempotency key and wrong capability fail without handoff', async () => {
  const { s, repo, request } = await setup();
  await assert.rejects(
    repo.start({ ...request, tokenHash: 'f'.repeat(64) }),
    fails('UNAUTHORIZED'),
  );
  await assert.rejects(
    repo.start({ ...request, key: s.keyValue(s.now - 86400000) }),
    fails('IDEMPOTENCY_KEY_EXPIRED'),
  );
  await assert.rejects(
    repo.start({ ...request, ifMatch: etag('old') }),
    fails('CART_CONFLICT'),
  );
  s.rows.delete(s.key('catalog', catalogKeys.storefront));
  await assert.rejects(repo.start(request), fails('STOREFRONT_CONFLICT'));
});
test('local API rejects amount injection and does not log malicious error payloads', async () => {
  const { repo, request } = await setup();
  const lines: string[] = [];
  const original = console.info;
  console.info = (s) => lines.push(String(s));
  try {
    const event: ApiEvent = {
      routeKey: 'POST /carts/{cartId}/payment/start',
      requestContext: { requestId: 'safe', http: { method: 'POST' } },
      headers: {
        'X-Cart-Token': token,
        'Idempotency-Key': request.key,
        'If-Match': request.ifMatch,
      },
      pathParameters: { cartId: request.cartId },
      body: JSON.stringify({ pickupDate: pickup.date, customer, amount: 1 }),
    };
    assert.equal((await localPaymentApi(event, repo)).statusCode, 400);
    event.body = JSON.stringify({
      pickupDate: pickup.date,
      customer,
      confirmationTokenId: request.confirmationTokenId,
    });
    const response = await localPaymentApi(event, {
      get: repo.get.bind(repo),
      start: async () => {
        throw new Error(`secret ${token} ${customer.email} ${request.key}`);
      },
    });
    assert.equal(response.statusCode, 500);
    for (const value of [token, customer.email, request.key]) {
      assert.ok(!response.body.includes(value));
      assert.ok(!lines.join('').includes(value));
    }
  } finally {
    console.info = original;
  }
});
