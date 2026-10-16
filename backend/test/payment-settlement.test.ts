import { refundKey, eventWork } from '../src/notification-contract';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paymentFixture } from './payment-execution-fixture';
import {
  FinancialWorkflow,
  paidEventKey,
  recoveryDelay,
} from '../src/payment-settlement';
import {
  paymentMessage,
  associationKey,
} from '../src/payment-execution-domain';
import { paymentWork, orderKey } from '../src/payment-domain';
import { catalogKeys } from '../src/keys';
import { dropId } from './fixtures';
import { pid, tokenHash } from './cart-store';
import { PaymentCustomer } from '../src/payment-workflow';
import { ProviderError } from '../src/payment-provider';
import { paymentIdentity } from '../src/payment-runtime';
import { PaymentRepository } from '../src/payment-repository';
import { createPaymentWorker } from '../src/payment-worker';
import { ExpiryReconciler } from '../src/expiry-reconciler';
import { financialWorkMessage } from '../src/payment-routing';
import type { PaymentMessage } from '../src/payment-execution-domain';

async function fixture(products = 1, captureFixture = false, scope?: string) {
  const f = await paymentFixture(
    true,
    undefined,
    products,
    captureFixture,
    scope,
  );
  const logs: unknown[] = [];
  const dispatched: PaymentMessage[] = [];
  const w = new FinancialWorkflow(
    f.client,
    'commerce',
    'operations',
    f.provider,
    f.scope,
    'catalog',
    () => f.s.now,
    async (message) => {
      dispatched.push(message);
    },
    () => 0,
    async () => {},
    (e) => logs.push(e),
  );
  const current = () => w.load(f.message());
  f.provider.outcome = 'requires_capture';
  f.provider.captureIntent = async function (c?: any) {
    this.calls.push({ kind: 'capture', key: c.idempotencyKey });
    assert.equal(f.attempt().execution.capture.state, 'DISPATCHED');
    assert.equal(f.cart().status, 'PAYMENT_COMMITTING');
    const p = this.intents.get(c.intentId)!;
    p.status = 'succeeded';
    p.amountReceivedCents = p.amountCents;
    p.amountCapturableCents = 0;
    return structuredClone(p);
  };
  f.provider.cancelIntent = async function (c?: any) {
    this.calls.push({ kind: 'cancel', key: c.idempotencyKey });
    assert.equal(f.attempt().execution.cancel.state, 'DISPATCHED');
    const p = this.intents.get(c.intentId)!;
    p.status = 'canceled';
    p.amountReceivedCents = 0;
    p.amountCapturableCents = 0;
    return structuredClone(p);
  };
  const run = async () => {
    f.s.now = Math.max(
      f.s.now,
      Date.parse(f.attempt().execution.workflow.SK.split('#')[0]),
    );
    return w.run(f.message());
  };
  const authorize = async () => {
    await run();
    await run();
    await run();
  };
  const captured = async () => {
    await authorize();
    await run();
    await run();
  };
  const inventory = () =>
    f.s.row('catalog', catalogKeys.inventory(dropId, pid(2)))!;
  return {
    ...f,
    w,
    current,
    run,
    authorize,
    captured,
    inventory,
    logs,
    dispatched,
    customer: new PaymentCustomer(w, f.provider),
  };
}
test('capture claim, dispatch, evidence and paid conversion preserve ownership until atomic settlement', async () => {
  const f = await fixture();
  const originalOrder = structuredClone(
    f.s.row('commerce', orderKey(f.cart().orderId))!,
  );
  await f.authorize();
  assert.equal(f.attempt().status, 'AUTHORIZED');
  await f.run();
  assert.equal(f.cart().status, 'PAYMENT_COMMITTING');
  assert.equal(f.s.transactions.at(-1)!.length, 5);
  const start = f.cart().committingStartedAt;
  await f.run();
  assert.equal(f.attempt().execution.stage, 'FINALIZE_ORDER');
  assert.equal(f.inventory().sold, 0);
  assert.equal(
    (await f.customer.get(f.cart().cartId, tokenHash)).payment.status,
    'processing',
  );
  assert.equal(await f.run(), 'SETTLED');
  assert.equal(f.s.transactions.at(-1)!.length, 9);
  assert.equal(f.cart().status, 'CONVERTED');
  assert.equal(
    f.s.row('commerce', refundKey(f.cart().orderId))?.disposition,
    'NONE',
  );
  assert.ok(f.s.row('operations', eventWork(f.cart().orderId)));
  assert.equal(f.inventory().reserved, 0);
  assert.equal(f.inventory().sold, 2);
  assert.equal(f.cart().committingStartedAt, start);
  assert.equal(await f.w.completed(f.cart().paymentAttemptId), true);
  assert.equal(
    (await f.customer.get(f.cart().cartId, tokenHash)).payment.status,
    'paid',
  );
  assert.equal(f.provider.calls.filter((c) => c.kind === 'capture').length, 1);
  const savedOrder = f.s.row('commerce', orderKey(f.cart().orderId))!;
  for (const key of [
    'displayOrderNumber',
    'GSI1PK',
    'GSI1SK',
    'GSI2PK',
    'GSI2SK',
    'items',
    'totalCents',
  ])
    assert.deepEqual(savedOrder[key], originalOrder[key]);
});
test('different-key capture claim uses six distinct actions', async () => {
  const f = await fixture();
  await f.authorize();
  f.s.now += 1;
  await f.run();
  assert.equal(f.s.transactions.at(-1)!.length, 6);
});
for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 8])
  test(`paid finalization rollback action ${index}`, async () => {
    const f = await fixture();
    await f.captured();
    const original = new Map(structuredClone(f.s.rows));
    f.s.before = (actions) => {
      if (actions.length === 9)
        throw Object.assign(new Error('rollback'), {
          name: 'TransactionCanceledException',
          CancellationReasons: actions.map((_, i) => ({
            Code: i === index ? 'ConditionalCheckFailed' : 'None',
          })),
        });
    };
    if (index === 0) assert.equal(await f.run(), 'RESCHEDULED');
    else await assert.rejects(f.run(), /PAYMENT_BUSY/);
    assert.equal(f.inventory().reserved, 2);
    assert.equal(f.inventory().sold, 0);
    assert.equal(f.cart().status, 'PAYMENT_COMMITTING');
    assert.equal(
      f.s.row('operations', paidEventKey(f.cart().orderId)),
      undefined,
    );
    f.s.before = undefined;
    await f.run();
    assert.equal(f.cart().status, 'CONVERTED');
  });
for (const field of [
  'amountCents',
  'amountCapturableCents',
  'amountReceivedCents',
  'id',
  'captureMethod',
  'confirmationMethod',
  'livemode',
])
  test(`authorization rejects mismatching ${field}`, async () => {
    const f = await fixture();
    await f.authorize();
    const p = f.provider.intents.values().next().value!;
    (p as any)[field] =
      typeof (p as any)[field] === 'number'
        ? 1
        : field === 'livemode'
          ? true
          : 'wrong';
    await f.w.reconcile((await f.current())!);
    assert.equal(f.attempt().execution.stage, 'RECOVERY_REQUIRED');
    assert.equal(f.inventory().reserved, 2);
  });
test('wrong reverse association fails closed', async () => {
  const f = await fixture();
  await f.authorize();
  f.s.row(
    'commerce',
    associationKey(f.scope, f.attempt().execution.intentId),
  )!.orderId = pid(999);
  await f.w.reconcile((await f.current())!);
  assert.equal(f.attempt().execution.stage, 'RECOVERY_REQUIRED');
});
test('unexpected succeeded without capture authority cannot finalize', async () => {
  const f = await fixture();
  f.provider.outcome = 'succeeded';
  await f.authorize();
  assert.equal(f.cart().status, 'PAYMENT_COMMITTING');
  assert.equal(f.attempt().execution.recoveryReason, 'SETTLEMENT_INVARIANT');
  assert.equal(f.inventory().sold, 0);
});
test('lost capture response is recovered by retrieval without second capture', async () => {
  const f = await fixture();
  const capture = f.provider.captureIntent.bind(f.provider);
  f.provider.captureIntent = async (...args) => {
    await capture(...args);
    throw new Error('lost synthetic secret');
  };
  await f.captured();
  await f.run();
  assert.equal(f.cart().status, 'CONVERTED');
  assert.equal(f.provider.calls.filter((c) => c.kind === 'capture').length, 1);
  assert.ok(!JSON.stringify(f.logs).includes('secret'));
});
test('ambiguous claim response rereads committed timestamps', async () => {
  const f = await fixture();
  await f.authorize();
  f.s.after = () => {
    f.s.after = undefined;
    throw new Error('lost commit');
  };
  await f.run();
  const start = f.cart().committingStartedAt;
  await f.run();
  assert.equal(f.cart().committingStartedAt, start);
});
test('deadline never-dispatched start releases once with six actions', async () => {
  const f = await fixture();
  f.s.now = Date.parse(f.cart().paymentDeadline);
  const d = paymentWork(f.cart() as any).deadline;
  await f.w.run(paymentMessage({ ...d, revision: 0 }, 'PAYMENT'));
  await f.run();
  assert.equal(f.cart().status, 'EXPIRED');
  assert.equal(f.inventory().reserved, 0);
  assert.equal(f.s.transactions.at(-1)!.length, 6);
  assert.equal(
    await f.w.run(paymentMessage({ ...d, revision: 0 }, 'PAYMENT')),
    'STALE_WORK',
  );
});
test('abandoned action cancels, verifies and expires without selling', async () => {
  const f = await fixture();
  f.provider.outcome = 'requires_action';
  await f.authorize();
  f.s.now = Date.parse(f.cart().paymentDeadline);
  await f.run();
  await f.run();
  await f.run();
  assert.equal(f.cart().status, 'EXPIRED');
  assert.equal(f.inventory().reserved, 0);
  assert.equal(f.inventory().sold, 0);
});
test('unknown capture at hard stop holds inventory and honors retrieval backoff', async () => {
  const f = await fixture();
  await f.authorize();
  await f.run();
  f.provider.captureIntent = async () => {
    throw new Error('timeout');
  };
  await f.run();
  f.s.now = Date.parse(f.cart().committingDeadline);
  await f.run();
  assert.equal(f.attempt().execution.financialMode, 'READ_ONLY');
  assert.equal(f.cart().status, 'PAYMENT_COMMITTING');
  assert.equal(f.inventory().reserved, 2);
  assert.equal(f.inventory().sold, 0);
  const reads = f.provider.calls.filter((c) => c.kind === 'retrieve').length;
  await f.w.run(f.message());
  assert.equal(
    f.provider.calls.filter((c) => c.kind === 'retrieve').length,
    reads,
  );
  assert.equal(
    (await f.customer.get(f.cart().cartId, tokenHash)).payment.status,
    'processing',
  );
});
test('recovery delay is bounded and injectable', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 99].map((n) => recoveryDelay(n, () => 0)),
    [60000, 120000, 300000, 900000, 900000],
  );
  assert.equal(
    recoveryDelay(0, () => 1),
    72000,
  );
  assert.equal(
    recoveryDelay(3, () => 1),
    900000,
  );
});
test('duplicate finalizers perform one inventory conversion', async () => {
  const f = await fixture();
  await f.captured();
  const s = (await f.current())!;
  await Promise.all([f.w.settle(s), f.w.settle(s)]);
  assert.equal(f.inventory().sold, 2);
  assert.equal(f.inventory().reserved, 0);
});
test('paid completion uses settlement marker, not contemporary global inventory', async () => {
  const f = await fixture();
  await f.captured();
  await f.run();
  f.inventory().sold += 1;
  assert.equal(await f.w.completed(f.cart().paymentAttemptId), true);
});
test('close after authorization does not prevent settlement', async () => {
  const f = await fixture();
  await f.captured();
  f.s.row('catalog', catalogKeys.drop(dropId))!.status = 'CLOSED';
  await f.run();
  assert.equal(f.cart().status, 'CONVERTED');
});

for (const paid of [true, false])
  for (const event of [false, true]) {
    const size = 12 + (paid ? 8 : 5) + (event ? 2 : 0);
    test(`${paid ? 'paid' : 'unpaid'} twelve-line transaction ${event ? 'with event' : 'ordinary'} has ${size} unique actions`, async () => {
      const f = await fixture(12);
      if (paid) await f.captured();
      else {
        f.s.now = Date.parse(f.cart().paymentDeadline);
        await f.run();
      }
      const s = (await f.current())!;
      const extra = event
        ? [
            {
              Put: {
                TableName: 'operations',
                Item: { PK: 'EVENT#synthetic', SK: 'META' },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            {
              Delete: {
                TableName: 'operations',
                Key: { PK: 'INBOX#synthetic', SK: 'META' },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
          ]
        : [];
      await f.w.settle(s, extra);
      assert.equal(f.s.transactions.at(-1)!.length, size);
      f.s.invariants();
    });
    for (let index = 0; index < size; index++)
      test(`${paid ? 'paid' : 'unpaid'} twelve-line ${event ? 'event' : 'ordinary'} rollback ${index}/${size}`, async () => {
        const f = await fixture(12);
        if (paid) await f.captured();
        else {
          f.s.now = Date.parse(f.cart().paymentDeadline);
          await f.run();
        }
        const s = (await f.current())!;
        const extra = event
          ? [
              {
                Put: {
                  TableName: 'operations',
                  Item: { PK: 'EVENT#synthetic', SK: 'META' },
                  ConditionExpression: 'attribute_not_exists(PK)',
                },
              },
              {
                Delete: {
                  TableName: 'operations',
                  Key: { PK: 'INBOX#synthetic', SK: 'META' },
                  ConditionExpression: 'attribute_not_exists(PK)',
                },
              },
            ]
          : [];
        f.s.before = (a) => {
          if (a.length === size)
            throw Object.assign(new Error('forced rollback'), {
              CancellationReasons: a.map((_, i) => ({
                Code: i === index ? 'ConditionalCheckFailed' : 'None',
              })),
            });
        };
        if (index < 12) assert.equal(await f.w.settle(s, extra), 'RESCHEDULED');
        else await assert.rejects(f.w.settle(s, extra), /PAYMENT_BUSY/);
        assert.equal(f.inventory().reserved, 2);
        assert.equal(f.inventory().sold, 0);
        f.s.invariants();
      });
  }
for (const reason of ['EXPIRED', 'FAILED', 'CANCELLED'] as const)
  test(`safe terminal mapping ${reason}`, async () => {
    const f = await fixture();
    await f.authorize();
    await f.w.selectCancel((await f.current())!, reason);
    await f.run();
    await f.run();
    assert.equal(
      f.cart().status,
      reason === 'EXPIRED' ? 'EXPIRED' : 'CANCELLED',
    );
    assert.equal(f.attempt().status, reason);
    assert.equal(
      f.s.row('commerce', orderKey(f.cart().orderId))!.status,
      reason,
    );
    assert.equal(f.inventory().reserved, 0);
    assert.equal(f.inventory().sold, 0);
    assert.equal(await f.w.completed(f.cart().paymentAttemptId), true);
    assert.equal(
      (await f.customer.get(f.cart().cartId, tokenHash)).payment.status,
      reason.toLowerCase(),
    );
  });
test('stale capture message after finalization never calls provider', async () => {
  const f = await fixture();
  await f.authorize();
  await f.run();
  const m = f.message();
  await f.run();
  await f.run();
  const calls = f.provider.calls.length;
  assert.equal(await f.w.run(m), 'STALE_WORK');
  assert.equal(f.provider.calls.length, calls);
});
test('capture crash after provider success before evidence persistence recovers by retrieval', async () => {
  const f = await fixture();
  await f.authorize();
  await f.run();
  const capture = f.provider.captureIntent.bind(f.provider);
  f.provider.captureIntent = async (...args) => {
    const p = await capture(...args);
    f.s.before = () => {
      throw new Error('process terminated');
    };
    return p;
  };
  await assert.rejects(f.run());
  assert.equal(f.attempt().execution.capture.state, 'DISPATCHED');
  assert.equal(f.inventory().sold, 0);
  f.s.before = undefined;
  await f.run();
  await f.run();
  assert.equal(f.inventory().sold, 2);
  assert.equal(f.provider.calls.filter((c) => c.kind === 'capture').length, 1);
});
for (const status of ['4xx', '5xx', 'timeout', 'connection failure'])
  test(`capture ${status} never implies safe failure`, async () => {
    const f = await fixture();
    await f.authorize();
    await f.run();
    f.provider.captureIntent = async () => {
      throw new Error(status);
    };
    await f.run();
    assert.equal(f.cart().status, 'PAYMENT_COMMITTING');
    assert.equal(f.inventory().reserved, 2);
    assert.equal(f.inventory().sold, 0);
  });
test('cancel lost response is recovered only from canonical canceled state', async () => {
  const f = await fixture();
  await f.authorize();
  await f.w.selectCancel((await f.current())!, 'CANCELLED');
  const cancel = f.provider.cancelIntent.bind(f.provider);
  f.provider.cancelIntent = async (...args) => {
    await cancel(...args);
    throw new Error('lost');
  };
  await f.run();
  await f.run();
  assert.equal(f.inventory().reserved, 0);
});
test('unknown cancel cannot release inventory', async () => {
  const f = await fixture();
  await f.authorize();
  await f.w.selectCancel((await f.current())!, 'CANCELLED');
  f.provider.cancelIntent = async () => {
    throw new Error('timeout');
  };
  await f.run();
  assert.equal(f.inventory().reserved, 2);
  assert.equal(f.attempt().execution.releaseEvidence, undefined);
});
for (const field of [
  'amountReceivedCents',
  'amountCapturableCents',
  'amountCents',
])
  test(`capture verification rejects ${field} mismatch`, async () => {
    const f = await fixture();
    await f.authorize();
    await f.run();
    const cap = f.provider.captureIntent.bind(f.provider);
    f.provider.captureIntent = async (...args) => {
      const p = await cap(...args);
      (f.provider.intents.get(p.id)! as any)[field] = 1;
      return p;
    };
    await f.run();
    assert.equal(f.attempt().execution.stage, 'RECOVERY_REQUIRED');
    assert.equal(f.inventory().sold, 0);
  });
test('late processing worker uses original deadline and never restarts committing clock', async () => {
  const f = await fixture();
  f.provider.outcome = 'processing';
  await f.authorize();
  f.s.now = Date.parse(f.cart().paymentDeadline) + 130000;
  await f.run();
  assert.equal(f.cart().committingStartedAt, f.cart().paymentDeadline);
  assert.equal(
    Date.parse(f.cart().committingDeadline),
    Date.parse(f.cart().paymentDeadline) + 120000,
  );
  assert.equal(f.attempt().execution.financialMode, 'READ_ONLY');
});
test('deadline equality closes action secret and confirmation admission', async () => {
  const f = await fixture();
  f.provider.outcome = 'requires_action';
  await f.authorize();
  f.s.now = Date.parse(f.cart().paymentDeadline);
  await f.run();
  assert.ok(f.attempt().execution.admissionClosedAt);
  assert.equal(
    'clientSecret' in
      (await f.customer.get(f.cart().cartId, tokenHash)).payment,
    false,
  );
});
test('unknown recovery duplicate delivery admits at most one provider read per minute', async () => {
  const f = await fixture();
  await f.authorize();
  await f.w.unknown((await f.current())!);
  f.s.now = Date.parse(f.attempt().execution.nextCheckAt);
  const before = f.provider.calls.length;
  const message = f.message();
  await Promise.allSettled([f.w.run(message), f.w.run(message)]);
  assert.equal(f.provider.calls.length - before, 1);
  assert.ok(Date.parse(f.attempt().execution.nextCheckAt) >= f.s.now + 60000);
});
test('webhook can finalize and complete inbox without a second capture', async () => {
  const f = await fixture();
  await f.captured();
  await f.inbox.accept({
    eventId: 'evt_FinancialFixture',
    intentId: f.attempt().execution.intentId,
    eventType: 'payment_intent.succeeded',
  });
  const receipt = f.s.row('operations', {
    PK: 'EXTERNAL_EVENT#STRIPE#evt_FinancialFixture',
    SK: 'META',
  })!;
  await f.inbox.process(paymentMessage(receipt.work, 'STRIPE_EVENT'), f.w);
  assert.equal(f.cart().status, 'CONVERTED');
  assert.equal(f.s.transactions.at(-1)!.length, 11);
  assert.equal(
    f.s.row('operations', { PK: receipt.PK, SK: receipt.SK })!.state,
    'PROCESSED',
  );
});
test('terminal out-of-order webhook completes without resurrecting workflow', async () => {
  const f = await fixture();
  await f.captured();
  await f.run();
  await f.inbox.accept({
    eventId: 'evt_OldCreated',
    intentId: f.attempt().execution.intentId,
    eventType: 'payment_intent.created',
  });
  const r = f.s.row('operations', {
    PK: 'EXTERNAL_EVENT#STRIPE#evt_OldCreated',
    SK: 'META',
  })!;
  assert.equal(
    await f.inbox.process(paymentMessage(r.work, 'STRIPE_EVENT'), f.w),
    'COMPLETED',
  );
  assert.equal(f.inventory().sold, 2);
});
test('recovery webhook honors nextCheckAt and transfers responsibility', async () => {
  const f = await fixture();
  await f.authorize();
  await f.w.unknown((await f.current())!);
  await f.inbox.accept({
    eventId: 'evt_RecoveryWake',
    intentId: f.attempt().execution.intentId,
    eventType: 'payment_intent.processing',
  });
  const r = f.s.row('operations', {
    PK: 'EXTERNAL_EVENT#STRIPE#evt_RecoveryWake',
    SK: 'META',
  })!;
  const before = f.provider.calls.length;
  assert.equal(
    await f.inbox.process(paymentMessage(r.work, 'STRIPE_EVENT'), f.w),
    'TRANSFERRED',
  );
  assert.equal(f.provider.calls.length, before);
});

test('real snapshot changes rebuild all inventory and succeed on third attempt', async () => {
  const f = await fixture();
  await f.captured();
  let conflicts = 0;
  f.s.before = (a) => {
    if (a.length === 9 && conflicts++ < 2) f.inventory().total++;
  };
  assert.equal(await f.run(), 'SETTLED');
  assert.equal(conflicts, 3);
  assert.equal(f.inventory().sold, 2);
});
test('three inventory conflicts retain durable finalization without recapture', async () => {
  const f = await fixture();
  await f.captured();
  let attempts = 0;
  f.s.before = (a) => {
    if (a.length === 9) {
      attempts++;
      f.inventory().total++;
    }
  };
  assert.equal(await f.run(), 'RESCHEDULED');
  assert.equal(attempts, 3);
  assert.equal(f.attempt().execution.stage, 'FINALIZE_ORDER');
  assert.equal(f.inventory().reserved, 2);
  assert.equal(f.provider.calls.filter((c) => c.kind === 'capture').length, 1);
});
for (const corrupt of [false, true])
  test(`captured inventory ${corrupt ? 'corruption' : 'absence'} escalates without release`, async () => {
    const f = await fixture();
    await f.captured();
    if (corrupt) f.inventory().reserved = -1;
    else
      f.s.rows.delete(
        f.s.key('catalog', catalogKeys.inventory(dropId, pid(2))),
      );
    // Corrupt fixture cannot satisfy the store's global invariant assertion on any unrelated write.
    f.s.invariants = () => {};
    assert.equal(await f.run(), 'RECOVERY_REQUIRED');
    assert.equal(f.cart().status, 'PAYMENT_COMMITTING');
    assert.equal(f.attempt().execution.recoveryReason, 'SETTLEMENT_INVARIANT');
  });
test('old SHOPPING message cannot release a captured Cart', async () => {
  const { ExpiryRepository } = await import('../src/expiry-repository');
  const { expiryMessage } = await import('../src/cart-expiry');
  const f = await fixture();
  await f.captured();
  f.s.now = Date.parse(f.cart().shoppingExpiresAt) + 1;
  const r = new ExpiryRepository(
    f.client,
    'catalog',
    'commerce',
    'operations',
    {
      now: () => f.s.now,
      monotonic: () => 0,
      sleep: async () => {},
      random: () => 0,
    },
  );
  await r.expire(expiryMessage(f.cart().cartId, f.cart().shoppingExpiresAt));
  assert.equal(f.inventory().reserved, 2);
  assert.equal(f.inventory().sold, 0);
});
test('duplicate claim preserves timestamps and immutable capture authority', async () => {
  const f = await fixture();
  await f.authorize();
  const s = (await f.current())!;
  await Promise.allSettled([f.w.claimCapture(s), f.w.claimCapture(s)]);
  const current = (await f.current())!;
  assert.ok(current.e.capture);
  assert.equal(
    current.cart.committingStartedAt,
    new Date(f.s.now).toISOString(),
  );
  await assert.rejects(
    f.w.transition(
      current,
      { ...current.e },
      {
        cart: {
          ...current.cart,
          committingStartedAt: new Date(f.s.now + 1).toISOString(),
        },
      },
    ),
    /INVALID_AUTHORITY/,
  );
});
test('claim versus deadline closes admission once without loss of inventory', async () => {
  const f = await fixture();
  await f.authorize();
  f.s.now = Date.parse(f.cart().paymentDeadline);
  const s = (await f.current())!;
  const d = paymentWork(f.cart() as any).deadline;
  await Promise.allSettled([
    f.w.claimCapture(s),
    f.w.deadline(paymentMessage({ ...d, revision: 0 }, 'PAYMENT')),
  ]);
  assert.equal(f.inventory().reserved, 2);
  assert.equal(f.inventory().sold, 0);
  assert.ok(f.attempt().execution.admissionClosedAt);
});
test('PREPARED to DISPATCHED crash retains original capture command for recovery', async () => {
  const f = await fixture();
  await f.authorize();
  await f.run();
  const read = f.provider.retrieveIntent.bind(f.provider);
  let fail = true;
  f.provider.retrieveIntent = async (id) => {
    if (fail) throw new Error('network down');
    return read(id);
  };
  await f.run();
  assert.equal(f.attempt().execution.capture.state, 'DISPATCHED');
  assert.equal(f.inventory().reserved, 2);
  fail = false;
  await f.run();
  await f.run();
  await f.run();
  assert.equal(f.inventory().sold, 2);
});
test('recovery later observes capture and settles without another command', async () => {
  const f = await fixture();
  await f.authorize();
  await f.run();
  f.provider.captureIntent = async () => {
    throw new Error('lost');
  };
  await f.run();
  f.s.now = Date.parse(f.cart().committingDeadline);
  await f.run();
  const p = f.provider.intents.values().next().value!;
  p.status = 'succeeded';
  p.amountReceivedCents = p.amountCents;
  p.amountCapturableCents = 0;
  const calls = f.provider.calls.filter((c) => c.kind === 'capture').length;
  await f.run();
  await f.run();
  assert.equal(f.inventory().sold, 2);
  assert.equal(
    f.provider.calls.filter((c) => c.kind === 'capture').length,
    calls,
  );
});
test('financial logs and outbox contain identifiers only, excluding private fixture fields', async () => {
  const f = await fixture();
  await f.captured();
  await f.run();
  const evidence = JSON.stringify([
    f.logs,
    f.s.row('operations', paidEventKey(f.cart().orderId)),
  ]);
  for (const value of [
    f.request.customer.name,
    f.request.customer.email,
    f.request.customer.phone,
    f.request.confirmationTokenId,
    'client_secret',
    'managementTokenHash',
  ])
    assert.ok(!evidence.includes(value));
});

test('succeeded webhook before capture response finalizes once', async () => {
  const f = await fixture();
  await f.authorize();
  await f.run();
  const capture = f.provider.captureIntent.bind(f.provider);
  f.provider.captureIntent = async (...args) => {
    const p = await capture(...args);
    await f.inbox.accept({
      eventId: 'evt_WebhookFirst',
      intentId: p.id,
      eventType: 'payment_intent.succeeded',
    });
    const r = f.s.row('operations', {
      PK: 'EXTERNAL_EVENT#STRIPE#evt_WebhookFirst',
      SK: 'META',
    })!;
    await f.inbox.process(paymentMessage(r.work, 'STRIPE_EVENT'), f.w);
    return p;
  };
  await f.run();
  assert.equal(f.cart().status, 'CONVERTED');
  assert.equal(f.inventory().sold, 2);
  assert.equal(f.provider.calls.filter((c) => c.kind === 'capture').length, 1);
});
test('conflicting paid outbox escalates without converting inventory', async () => {
  const f = await fixture();
  await f.captured();
  f.s.put('operations', {
    ...paidEventKey(f.cart().orderId),
    unexpected: 'corrupt',
  });
  assert.equal(await f.run(), 'RECOVERY_REQUIRED');
  assert.equal(f.inventory().reserved, 2);
  assert.equal(f.inventory().sold, 0);
  assert.equal(f.attempt().execution.recoveryReason, 'SETTLEMENT_INVARIANT');
});
test('terminal settlement mismatch is rejected rather than treated as completed', async () => {
  const f = await fixture();
  await f.captured();
  await f.run();
  f.s.row('commerce', orderKey(f.cart().orderId))!.settlement.id = '0'.repeat(
    64,
  );
  await assert.rejects(
    f.w.completed(f.cart().paymentAttemptId),
    /INVALID_AUTHORITY/,
  );
});

test('temporary pre-deadline read outage does not prematurely close customer interaction', async () => {
  const f = await fixture();
  f.provider.outcome = 'requires_action';
  await f.authorize();
  const read = f.provider.retrieveIntent.bind(f.provider);
  f.provider.retrieveIntent = async () => {
    throw new Error('temporary unavailable');
  };
  await f.run();
  assert.equal(f.cart().status, 'PAYMENT_PENDING');
  assert.equal(f.attempt().execution.admissionClosedAt, undefined);
  f.provider.retrieveIntent = read;
  await f.run();
  assert.equal(
    (await f.customer.get(f.cart().cartId, tokenHash)).payment.status,
    'action_required',
  );
});

for (const outcome of [
  'requires_capture',
  'processing',
  'requires_payment_method',
  'canceled',
  'succeeded',
  'requires_action',
] as const) {
  test(`automatic customer action reconciles ${outcome} without another confirmation`, async () => {
    const f = await fixture();
    f.provider.outcome = 'requires_action';
    await f.authorize();
    const deadline = f.cart().paymentDeadline;
    assert.equal(f.attempt().status, 'AUTHENTICATING');
    assert.equal(f.attempt().execution.stage, 'WAIT_FOR_CUSTOMER_ACTION');
    const current = await f.customer.get(f.cart().cartId, tokenHash);
    assert.equal(current.payment.status, 'action_required');
    const p = f.provider.intents.get('pi_Test1')!;
    p.status = outcome;
    p.amountCapturableCents =
      outcome === 'requires_capture' ? p.amountCents : 0;
    p.amountReceivedCents = outcome === 'succeeded' ? p.amountCents : 0;
    p.paymentFailed = outcome === 'requires_payment_method';
    const request = {
      cartId: f.cart().cartId,
      tokenHash,
      ifMatch: current.etag,
      key: f.s.keyValue(),
      continuationGeneration: 1,
    };
    await f.customer.confirm(request);
    await f.customer.confirm(request);
    const work = f.message();
    await f.run();
    await f.w.run(work);
    assert.equal(
      f.provider.calls.filter((c) => c.kind === 'confirm').length,
      1,
    );
    assert.equal(
      f.provider.calls.filter((c) => c.kind === 'capture').length,
      0,
    );
    assert.equal(f.attempt().execution.confirmations.length, 1);
    assert.equal(f.cart().paymentDeadline, deadline);
    assert.equal(f.inventory().reserved, 2);
    assert.equal(f.inventory().sold, 0);
    const expected = {
      requires_capture: 'CLAIM_CAPTURE',
      processing: 'VERIFY_AUTHORIZATION',
      requires_payment_method: 'CANCEL',
      canceled: 'RESOLVE_FAILURE',
      requires_action: 'WAIT_FOR_CUSTOMER_ACTION',
      succeeded: 'RECOVERY_REQUIRED',
    };
    assert.equal(f.attempt().execution.stage, expected[outcome]);
    assert.ok(
      !JSON.stringify([...f.s.rows.values()]).includes(
        'synthetic-action-secret',
      ),
    );
    if (outcome === 'requires_capture') {
      assert.equal(f.attempt().status, 'AUTHORIZED');
      assert.equal(f.attempt().execution.stage, 'CLAIM_CAPTURE');
    }
    assert.notEqual(
      (await f.customer.get(f.cart().cartId, tokenHash)).payment.status,
      'paid',
    );
  });
}

for (const [attemptStatus, cartStatus, customerStatus] of [
  ['EXPIRED', 'EXPIRED', 'expired'],
  ['FAILED', 'CANCELLED', 'failed'],
  ['CANCELLED', 'CANCELLED', 'cancelled'],
  ['CAPTURED', 'CONVERTED', 'paid'],
] as const) {
  test(`historical ${attemptStatus} is readable without provider access or execution`, async () => {
    const f = await fixture();
    if (attemptStatus === 'CAPTURED') {
      await f.captured();
      await f.run();
    } else {
      await f.authorize();
      await f.w.selectCancel((await f.current())!, attemptStatus);
      await f.run();
      await f.run();
    }
    assert.equal(f.attempt().status, attemptStatus);
    assert.equal(f.cart().status, cartStatus);
    assert.equal(await f.w.completed(f.cart().paymentAttemptId), true);
    const calls = f.provider.calls.length;
    f.attempt().execution.parameters.confirmationMethod = 'manual';
    const before = structuredClone(f.s.rows);
    const a = await f.w.attempt(f.cart().paymentAttemptId);
    assert.equal(a!.execution!.parameters.confirmationMethod, 'manual');
    assert.equal(
      (await f.customer.get(f.cart().cartId, tokenHash)).payment.status,
      customerStatus,
    );
    assert.equal(await f.run(), 'STALE_WORK');
    assert.equal(f.provider.calls.length, calls);
    assert.deepEqual(f.s.rows, before);
  });
}
for (const stage of [
  'CREATE_INTENT',
  'CONFIRM',
  'WAIT_FOR_CUSTOMER_ACTION',
  'CLAIM_CAPTURE',
  'CAPTURE',
  'CANCEL',
  'VERIFY_CAPTURE',
] as const) {
  test(`legacy ${stage} retains responsibility and blocks all execution`, async () => {
    const f = await fixture();
    const state = (await f.current())!;
    await f.w.advance(state, { ...state.e, stage });
    f.attempt().execution.parameters.confirmationMethod = 'manual';
    const before = structuredClone(f.s.rows);
    assert.equal(
      (await f.customer.get(f.cart().cartId, tokenHash)).payment.status,
      'processing',
    );
    await assert.rejects(f.run(), /LEGACY_PAYMENT_CONTRACT/);
    const deadline = paymentWork(f.cart() as any).deadline;
    await assert.rejects(
      f.w.deadline(paymentMessage({ ...deadline, revision: 0 }, 'PAYMENT')),
      /LEGACY_PAYMENT_CONTRACT/,
    );
    const current = await f.customer.get(f.cart().cartId, tokenHash);
    await assert.rejects(
      f.customer.confirm({
        cartId: f.cart().cartId,
        tokenHash,
        ifMatch: current.etag,
        key: f.s.keyValue(),
        continuationGeneration: 1,
      }),
      /LEGACY_PAYMENT_CONTRACT/,
    );
    assert.equal('clientSecret' in current.payment, false);
    assert.equal(f.provider.calls.length, 0);
    assert.deepEqual(f.s.rows, before);
  });
}
test('settled legacy paid webhook is acknowledged without Stripe retrieval or financial resurrection', async () => {
  const f = await fixture();
  await f.captured();
  await f.run();
  f.attempt().execution.parameters.confirmationMethod = 'manual';
  const before = structuredClone(f.inventory());
  const calls = f.provider.calls.length;
  await f.inbox.accept({
    eventId: 'evt_LegacyTerminal',
    intentId: f.attempt().execution.intentId,
    eventType: 'payment_intent.succeeded',
  });
  const r = f.s.row('operations', {
    PK: 'EXTERNAL_EVENT#STRIPE#evt_LegacyTerminal',
    SK: 'META',
  })!;
  assert.equal(
    await f.inbox.process(paymentMessage(r.work, 'STRIPE_EVENT'), f.w),
    'COMPLETED',
  );
  assert.equal(f.provider.calls.length, calls);
  assert.deepEqual(f.inventory(), before);
  assert.equal(
    (await f.customer.get(f.cart().cartId, tokenHash)).payment.status,
    'paid',
  );
});
test('unresolved legacy webhook retains inbox responsibility without provider access', async () => {
  const f = await fixture();
  await f.authorize();
  f.attempt().execution.parameters.confirmationMethod = 'manual';
  await f.inbox.accept({
    eventId: 'evt_LegacyUnresolved',
    intentId: f.attempt().execution.intentId,
    eventType: 'payment_intent.amount_capturable_updated',
  });
  const r = f.s.row('operations', {
    PK: 'EXTERNAL_EVENT#STRIPE#evt_LegacyUnresolved',
    SK: 'META',
  })!;
  const calls = f.provider.calls.length;
  const before = structuredClone(f.s.rows);
  await assert.rejects(
    f.inbox.process(paymentMessage(r.work, 'STRIPE_EVENT'), f.w),
    /LEGACY_PAYMENT_CONTRACT/,
  );
  assert.equal(f.provider.calls.length, calls);
  assert.deepEqual(f.s.rows, before);
});

for (const terminal of [false, true]) {
  test(`queue legacy ${terminal ? 'terminal no-op' : 'unresolved escalation'} has no financial side effects`, async () => {
    const f = await fixture();
    if (terminal) {
      await f.captured();
      await f.run();
    }
    f.attempt().execution.parameters.confirmationMethod = 'manual';
    const before = structuredClone(f.s.rows);
    const calls = f.provider.calls.length;
    const logs: string[] = [];
    const original = console.info;
    console.info = (line) => logs.push(line);
    try {
      const result = await createPaymentWorker(
        f.w,
        f.inbox,
        'fixture-queue',
      )({
        Records: [
          {
            messageId: 'legacy-message',
            eventSource: 'aws:sqs',
            eventSourceARN: 'fixture-queue',
            body: JSON.stringify(f.message()),
          },
        ],
      });
      assert.equal(result.batchItemFailures.length, terminal ? 0 : 1);
      const disposition = logs
        .map((line) => JSON.parse(line))
        .find((entry) => entry.operation === 'paymentTransportDisposition');
      assert.equal(disposition.disposition, terminal ? 'ACK' : 'RETRY');
      if (!terminal)
        assert.equal(disposition.outcome, 'LEGACY_PAYMENT_CONTRACT');
    } finally {
      console.info = original;
    }
    assert.equal(f.provider.calls.length, calls);
    assert.deepEqual(f.s.rows, before);
  });
}

test('legacy committing state blocks direct financial operations without releasing ownership', async () => {
  const f = await fixture();
  await f.authorize();
  await f.run();
  assert.equal(f.cart().status, 'PAYMENT_COMMITTING');
  const state = (await f.current())!;
  (state.e.parameters as { confirmationMethod: string }).confirmationMethod =
    'manual';
  f.attempt().execution.parameters.confirmationMethod = 'manual';
  const before = structuredClone(f.s.rows);
  const calls = f.provider.calls.length;
  for (const action of [
    () => f.w.reconcile(state),
    () => f.w.claimCapture(state),
    () => f.w.selectCancel(state, 'EXPIRED'),
    () => f.w.settle(state),
    () => f.run(),
  ])
    await assert.rejects(action(), /LEGACY_PAYMENT_CONTRACT/);
  assert.equal(
    (await f.customer.get(f.cart().cartId, tokenHash)).payment.status,
    'processing',
  );
  assert.equal(f.inventory().reserved, 2);
  assert.equal(f.provider.calls.length, calls);
  assert.deepEqual(f.s.rows, before);
});

const rejectionDiagnostic = {
  boundary: 'provider_response' as const,
  httpStatus: 400,
  errorType: 'invalid_request_error' as const,
  requestId: 'req_RejectedFixture',
  param: 'final_capture' as const,
  shouldRetry: false,
};
async function rejectedFixture() {
  const f = await fixture(1, true);
  await f.authorize();
  await f.run();
  f.provider.captureIntent = async () => {
    f.provider.calls.push({ kind: 'capture' });
    throw new ProviderError('PROVIDER_REQUEST_REJECTED', rejectionDiagnostic);
  };
  assert.equal(await f.run(), 'PROVIDER_REQUEST_REJECTED');
  assert.equal(f.attempt().execution.capture.state, 'PROVIDER_REJECTED');
  return f;
}
test('definitive rejection stops automatic capture replay and retains responsibility', async () => {
  const f = await rejectedFixture();
  for (let i = 0; i < 5; i++) await f.run();
  assert.equal(f.provider.calls.filter((c) => c.kind === 'capture').length, 1);
  assert.equal(f.cart().status, 'PAYMENT_COMMITTING');
  assert.equal(f.inventory().reserved, 5);
  assert.equal(f.inventory().sold, 0);
  assert.equal(
    (await f.customer.get(f.cart().cartId, tokenHash)).payment.status,
    'processing',
  );
  assert.equal(
    f.attempt().execution.capture.rejection.diagnostic.requestId,
    'req_RejectedFixture',
  );
});
test('generation two is atomically unique, preserves rejected history and settles once', async () => {
  const f = await rejectedFixture();
  const old = structuredClone(f.attempt().execution.capture);
  const state = (await f.current())!;
  await assert.rejects(f.w.prepareReplacementCapture(state, false));
  const results = await Promise.allSettled([
    f.w.prepareReplacementCapture(state, true),
    f.w.prepareReplacementCapture(state, true),
  ]);
  assert.ok(results.some((r) => r.status === 'fulfilled'));
  assert.equal(f.attempt().execution.capture.generation, 2);
  assert.notEqual(f.attempt().execution.capture.id, old.id);
  assert.deepEqual(f.attempt().execution.captureHistory, [old]);
  const identity = f.attempt().execution.capture.id;
  const prepared = f.attempt().execution.capture.preparedAt;
  let count = 0;
  f.provider.captureIntent = async (c?: any) => {
    count++;
    assert.equal(c.idempotencyKey, identity);
    assert.equal(f.attempt().execution.capture.state, 'DISPATCHED');
    assert.equal(f.attempt().execution.capture.preparedAt, prepared);
    if (count === 1) throw new ProviderError('PROVIDER_UNKNOWN');
    const p = f.provider.intents.get(c.intentId)!;
    p.status = 'succeeded';
    p.amountReceivedCents = 2625;
    p.amountCapturableCents = 0;
    return structuredClone(p);
  };
  await f.run();
  await f.run();
  await f.run();
  assert.equal(count, 2);
  assert.equal(f.cart().status, 'CONVERTED');
  assert.equal(f.attempt().status, 'CAPTURED');
  assert.equal(f.inventory().reserved, 0);
  assert.equal(f.inventory().sold, 5);
  assert.deepEqual(f.attempt().execution.captureHistory, [old]);
  await f.run();
  assert.equal(f.inventory().sold, 5);
  await assert.rejects(f.w.prepareReplacementCapture(state, true));
});
for (const invalid of [
  'received',
  'status',
  'association',
  'reserved',
  'aggregate',
  'ownership',
  'cart',
  'order',
  'unproven',
] as const) {
  test(`replacement capture rejects unsafe ${invalid}`, async () => {
    const f = await rejectedFixture();
    if (invalid === 'received')
      f.provider.intents.get('pi_Test1')!.amountReceivedCents = 1;
    if (invalid === 'status')
      f.provider.intents.get('pi_Test1')!.status = 'processing';
    if (invalid === 'association')
      f.provider.intents.get('pi_Test1')!.metadata.cartId = pid(999);
    if (invalid === 'reserved') f.inventory().reserved = 4;
    if (invalid === 'aggregate') f.inventory().sold = 16;
    if (invalid === 'ownership') f.cart().items[0].quantity = 4;
    if (invalid === 'cart') f.cart().status = 'EXPIRED';
    if (invalid === 'order')
      f.s.row('commerce', orderKey(f.cart().orderId))!.status = 'PAID';
    if (invalid === 'unproven') {
      f.attempt().execution.capture.state = 'DISPATCHED';
      delete f.attempt().execution.capture.rejection;
    }
    const before = structuredClone(f.s.rows);
    await assert.rejects(async () => {
      const s = await f.current();
      if (!s) throw Error('blocked');
      await f.w.prepareReplacementCapture(s, true);
    });
    assert.deepEqual(f.s.rows, before);
    assert.equal(
      f.provider.calls.filter((c) => c.kind === 'capture').length,
      1,
    );
  });
}
test('current live-shaped unknown generation one can be classified but never replayed with changed parameters', async () => {
  const f = await fixture(1, true);
  await f.authorize();
  await f.run();
  const c = f.attempt().execution.capture;
  c.state = 'DISPATCHED';
  c.dispatchedAt = new Date(f.s.now).toISOString();
  delete c.requestShape;
  f.s.now += 200000;
  await f.w.unknown((await f.current())!);
  const old = structuredClone(f.attempt().execution.capture);
  assert.equal(f.attempt().amountCents, 2625);
  assert.equal(await f.run(), 'RECONCILED');
  assert.equal(f.provider.calls.filter((c) => c.kind === 'capture').length, 0);
  const s = (await f.current())!;
  const { param: omittedParameter, ...actualDiagnostic } = rejectionDiagnostic;
  assert.equal(omittedParameter, 'final_capture');
  await f.w.classifyRejectedCapture(
    s,
    {
      diagnostic: actualDiagnostic,
      source: 'OPERATOR',
      recordedAt: new Date(f.s.now).toISOString(),
      requestAt: old.dispatchedAt,
    },
    true,
  );
  const rejected = structuredClone(f.attempt().execution.capture);
  assert.equal(rejected.dispatchedAt, old.dispatchedAt);
  await f.w.prepareReplacementCapture((await f.current())!, true);
  assert.deepEqual(f.attempt().execution.captureHistory, [rejected]);
  assert.equal(f.attempt().execution.capture.state, 'PREPARED');
  assert.equal(f.provider.calls.filter((c) => c.kind === 'capture').length, 0);
});
for (const invalid of ['received', 'status', 'reserved'] as const) {
  test(`generation two dispatch rechecks ${invalid}`, async () => {
    const f = await rejectedFixture();
    await f.w.prepareReplacementCapture((await f.current())!, true);
    if (invalid === 'received')
      f.provider.intents.get('pi_Test1')!.amountReceivedCents = 1;
    if (invalid === 'status')
      f.provider.intents.get('pi_Test1')!.status = 'processing';
    if (invalid === 'reserved') f.inventory().reserved = 4;
    await f.run().catch(() => {});
    assert.equal(
      f.provider.calls.filter((c) => c.kind === 'capture').length,
      1,
    );
    assert.equal(f.inventory().sold, 0);
  });
}

test('replacement inventory condition defeats a race after canonical proof', async () => {
  const f = await rejectedFixture();
  const s = (await f.current())!;
  f.s.before = () => {
    f.s.before = undefined;
    f.inventory().reserved = 4;
  };
  await assert.rejects(f.w.prepareReplacementCapture(s, true));
  assert.equal(f.attempt().execution.capture.state, 'PROVIDER_REJECTED');
  assert.equal(f.attempt().execution.captureHistory, undefined);
});
test('replacement authorization window expiry preserves ownership without cancellation', async () => {
  const f = await rejectedFixture();
  await f.w.prepareReplacementCapture((await f.current())!, true);
  f.s.now = Date.parse(f.attempt().execution.capture.dispatchUntil);
  await f.run();
  assert.equal(f.attempt().execution.financialMode, 'READ_ONLY');
  assert.equal(f.attempt().execution.cancel, undefined);
  assert.equal(f.inventory().reserved, 5);
});

async function addOtherReservation(
  f: Awaited<ReturnType<typeof rejectedFixture>>,
  quantity: number,
) {
  return f.s
    .repository()
    .mutate(f.s.request([{ productId: pid(2), quantity }]), { attempts: 0 });
}
function successfulReplacement(f: Awaited<ReturnType<typeof rejectedFixture>>) {
  let captures = 0;
  f.provider.captureIntent = async (c?: any) => {
    captures++;
    assert.equal(f.attempt().execution.capture.state, 'DISPATCHED');
    const p = f.provider.intents.get(c.intentId)!;
    p.status = 'succeeded';
    p.amountReceivedCents = 2625;
    p.amountCapturableCents = 0;
    return structuredClone(p);
  };
  return () => captures;
}
for (const shared of [false, true]) {
  test(`replacement accepts prior SOLD stock with ${shared ? 'shared' : 'exclusive'} reservations and settles once`, async () => {
    const f = await rejectedFixture();
    f.inventory().sold = 2;
    const other = shared ? await addOtherReservation(f, 3) : undefined;
    const captures = successfulReplacement(f);
    await f.w.prepareReplacementCapture((await f.current())!, true);
    await f.run();
    const finalization = (await f.current())!;
    assert.equal(await f.w.settle(finalization), 'SETTLED');
    assert.equal(await f.w.run(finalization.message), 'STALE_WORK');
    assert.equal(captures(), 1);
    assert.equal(f.cart().status, 'CONVERTED');
    assert.equal(f.attempt().status, 'CAPTURED');
    assert.equal(
      f.s.row('commerce', orderKey(f.cart().orderId))!.status,
      'PAID',
    );
    assert.equal(f.inventory().reserved, shared ? 3 : 0);
    assert.equal(f.inventory().sold, 7);
    assert.equal(
      f.inventory().total - f.inventory().reserved - f.inventory().sold,
      shared ? 10 : 13,
    );
    if (other) assert.equal(other.cart.items[0].quantity, 3);
    assert.equal(
      [...f.s.rows.values()].filter((r) => r.eventType === 'PAID').length,
      1,
    );
  });
}
test('reservation after replacement preparation survives captured finalization contention', async () => {
  const f = await rejectedFixture();
  f.inventory().sold = 2;
  const captures = successfulReplacement(f);
  await f.w.prepareReplacementCapture((await f.current())!, true);
  await f.run();
  assert.equal(f.attempt().execution.stage, 'FINALIZE_ORDER');
  f.s.before = async (actions) => {
    if (actions[0]?.Put?.TableName !== 'catalog') return;
    f.s.before = undefined;
    await addOtherReservation(f, 3);
  };
  assert.equal(await f.run(), 'SETTLED');
  assert.equal(f.inventory().reserved, 3);
  assert.equal(f.inventory().sold, 7);
  assert.equal(captures(), 1);
});
test('another owner SOLD transition after capture is preserved on inventory reread', async () => {
  const f = await rejectedFixture();
  f.inventory().sold = 2;
  const other = await addOtherReservation(f, 3);
  const captures = successfulReplacement(f);
  await f.w.prepareReplacementCapture((await f.current())!, true);
  await f.run();
  f.s.before = (actions) => {
    if (actions[0]?.Put?.TableName !== 'catalog') return;
    f.s.before = undefined;
    // Model the atomic outcome of the other owner's settlement between our read and CAS.
    const owner = [...f.s.rows.values()].find(
      (r) => r.cartId === other.cart.cartId && r.SK === 'META',
    )!;
    owner.status = 'CONVERTED';
    f.inventory().reserved -= 3;
    f.inventory().sold += 3;
  };
  assert.equal(await f.run(), 'SETTLED');
  assert.equal(f.inventory().reserved, 0);
  assert.equal(f.inventory().sold, 10);
  assert.equal(
    f.inventory().total - f.inventory().reserved - f.inventory().sold,
    10,
  );
  assert.equal(captures(), 1);
});
test('captured replacement survives exhausted inventory retries without another capture', async () => {
  const f = await rejectedFixture();
  const captures = successfulReplacement(f);
  await f.w.prepareReplacementCapture((await f.current())!, true);
  await f.run();
  let conflicts = 0;
  f.s.before = async (actions) => {
    if (actions[0]?.Put?.TableName !== 'catalog') return;
    f.s.before = undefined;
    await addOtherReservation(f, 1);
    conflicts++;
    f.s.before = race;
  };
  const race = f.s.before;
  assert.equal(await f.run(), 'RESCHEDULED');
  assert.equal(conflicts, 3);
  assert.equal(f.cart().status, 'PAYMENT_COMMITTING');
  assert.equal(
    (await f.customer.get(f.cart().cartId, tokenHash)).payment.status,
    'processing',
  );
  f.s.before = undefined;
  assert.equal(await f.run(), 'SETTLED');
  assert.equal(f.inventory().reserved, 3);
  assert.equal(f.inventory().sold, 5);
  assert.equal(captures(), 1);
});
test('ownership line race blocks replacement even with sufficient aggregate reservations', async () => {
  const f = await rejectedFixture();
  await addOtherReservation(f, 3);
  const state = (await f.current())!;
  f.s.before = () => {
    f.s.before = undefined;
    f.cart().items[0].quantity = 4;
  };
  await assert.rejects(f.w.prepareReplacementCapture(state, true));
  assert.equal(f.attempt().execution.capture.generation, undefined);
  assert.equal(f.attempt().execution.captureHistory, undefined);
});
test('legitimate preparation inventory contention permits fresh recovery proof', async () => {
  const f = await rejectedFixture();
  const state = (await f.current())!;
  f.s.before = async () => {
    f.s.before = undefined;
    await addOtherReservation(f, 3);
  };
  await assert.rejects(f.w.prepareReplacementCapture(state, true));
  await f.w.prepareReplacementCapture((await f.current())!, true);
  assert.equal(f.attempt().execution.capture.generation, 2);
  assert.equal(f.inventory().reserved, 8);
});

for (const timing of [
  'before',
  'at-deadline',
  'selected-before-deadline',
] as const) {
  test(`canonical decline safely releases once: ${timing}`, async () => {
    const f = await fixture(1, true);
    await f.run();
    await f.run();
    f.provider.confirmIntent = async () => {
      const p = f.provider.intents.get('pi_Test1')!;
      p.status = 'requires_payment_method';
      p.paymentFailed = true;
      throw new ProviderError('PROVIDER_UNKNOWN');
    };
    if (timing === 'at-deadline') {
      const p = f.provider.intents.get('pi_Test1')!;
      p.status = 'requires_payment_method';
      p.paymentFailed = true;
      f.s.now = Date.parse(f.cart().paymentDeadline);
      await f.w.reconcile((await f.current())!);
    } else {
      await f.run();
    }
    assert.equal(f.attempt().execution.stage, 'CANCEL');
    assert.equal(f.attempt().execution.recoveryReason, undefined);
    assert.equal(f.inventory().reserved, 5);
    if (timing === 'selected-before-deadline')
      f.s.now = Date.parse(f.cart().paymentDeadline);
    await f.run();
    const finalization = (await f.current())!;
    assert.equal(await f.run(), 'SETTLED');
    assert.equal(await f.w.run(finalization.message), 'STALE_WORK');
    assert.equal(
      f.cart().status,
      timing === 'at-deadline' ? 'EXPIRED' : 'CANCELLED',
    );
    assert.equal(
      f.attempt().status,
      timing === 'at-deadline' ? 'EXPIRED' : 'FAILED',
    );
    assert.equal(
      f.s.row('commerce', orderKey(f.cart().orderId))!.status,
      f.attempt().status,
    );
    assert.equal(f.inventory().reserved, 0);
    assert.equal(f.inventory().sold, 0);
    assert.equal(f.inventory().total, 20);
    assert.equal(f.attempt().execution.capture, undefined);
    assert.equal(f.cart().committingStartedAt, undefined);
    assert.equal(
      f.s.row('operations', paidEventKey(f.cart().orderId)),
      undefined,
    );
    assert.equal(
      f.provider.calls.some((c) => c.kind === 'capture'),
      false,
    );
    const view = (await f.customer.get(f.cart().cartId, tokenHash)).payment;
    assert.equal(view.status, timing === 'at-deadline' ? 'expired' : 'failed');
    assert.equal('clientSecret' in view, false);
  });
}

test('decline release preserves another owner and prior SOLD quantities', async () => {
  const f = await fixture(1, true);
  f.inventory().sold = 2;
  await addOtherReservation(f, 3);
  await f.run();
  await f.run();
  f.provider.confirmIntent = async () => {
    const p = f.provider.intents.get('pi_Test1')!;
    p.status = 'requires_payment_method';
    p.paymentFailed = true;
    throw new Error('private provider error must not be logged');
  };
  await f.run();
  await f.run();
  const stale = f.message();
  await f.run();
  await f.w.run(stale);
  assert.equal(f.inventory().reserved, 3);
  assert.equal(f.inventory().sold, 2);
  assert.equal(f.attempt().status, 'FAILED');
  assert.ok(!JSON.stringify(f.logs).includes('private provider error'));
});

test('decline webhook duplicates before and after failure cannot double-release', async () => {
  const f = await fixture(1, true);
  await f.run();
  await f.run();
  const p = f.provider.intents.get('pi_Test1')!;
  p.status = 'requires_payment_method';
  p.paymentFailed = true;
  f.provider.confirmIntent = async () => {
    throw new Error('synthetic decline');
  };
  await f.run();
  const event = {
    eventId: 'evt_DefinitiveDecline',
    intentId: p.id,
    eventType: 'payment_intent.payment_failed' as const,
  };
  await f.inbox.accept(event);
  await f.inbox.accept(event);
  const key = { PK: 'EXTERNAL_EVENT#STRIPE#' + event.eventId, SK: 'META' };
  const receipt = f.s.row('operations', key)!;
  const message = paymentMessage(receipt.work, 'STRIPE_EVENT');
  await f.inbox.process(message, f.w);
  await f.run();
  await f.run();
  await f.inbox.accept(event);
  await f.inbox.process(message, f.w);
  assert.equal(f.attempt().status, 'FAILED');
  assert.equal(f.inventory().reserved, 0);
  assert.equal(f.inventory().sold, 0);
  assert.equal(f.s.row('operations', key)!.state, 'PROCESSED');
  assert.equal(f.attempt().execution.capture, undefined);
});

async function abandonedFixture() {
  const f = await fixture(1, true);
  f.provider.outcome = 'requires_action';
  await f.authorize();
  assert.equal(f.attempt().status, 'AUTHENTICATING');
  assert.equal(f.attempt().execution.stage, 'WAIT_FOR_CUSTOMER_ACTION');
  return f;
}

test('abandonment deadline releases five once and returns secret-free expired status', async () => {
  const f = await abandonedFixture();
  const deadline = f.cart().paymentDeadline;
  const before = (await f.customer.get(f.cart().cartId, tokenHash)).payment;
  assert.equal(before.status, 'action_required');
  assert.ok(before.clientSecret);
  await f.run();
  assert.equal(f.cart().paymentDeadline, deadline);
  const key = paymentWork(f.cart() as any).deadline;
  const message = paymentMessage({ ...key, revision: 0 }, 'PAYMENT');
  f.s.now = Date.parse(deadline);
  await f.w.run(message);
  assert.equal(f.attempt().execution.cancel.state, 'PREPARED');
  assert.equal(f.inventory().reserved, 5);
  await f.run();
  assert.equal(f.attempt().execution.releaseEvidence, 'CANCELED');
  assert.equal(f.inventory().reserved, 5);
  const stale = f.message();
  await f.run();
  assert.equal(await f.w.run(message), 'STALE_WORK');
  assert.equal(await f.w.run(stale), 'STALE_WORK');
  assert.equal(f.cart().paymentDeadline, deadline);
  assert.equal(f.cart().status, 'EXPIRED');
  assert.equal(f.attempt().status, 'EXPIRED');
  assert.equal(
    f.s.row('commerce', orderKey(f.cart().orderId))!.status,
    'EXPIRED',
  );
  assert.deepEqual(
    [f.inventory().total, f.inventory().reserved, f.inventory().sold],
    [20, 0, 0],
  );
  assert.equal(f.s.row('operations', key), undefined);
  assert.equal(f.s.row('operations', stale), undefined);
  assert.equal(
    f.s.row('operations', paidEventKey(f.cart().orderId)),
    undefined,
  );
  assert.equal(f.attempt().execution.capture, undefined);
  assert.equal(f.provider.calls.filter((c) => c.kind === 'cancel').length, 1);
  assert.equal(f.provider.calls.filter((c) => c.kind === 'confirm').length, 1);
  assert.equal(
    f.provider.calls.some((c) => c.kind === 'capture'),
    false,
  );
  const view = (await f.customer.get(f.cart().cartId, tokenHash)).payment;
  assert.equal(view.status, 'expired');
  assert.equal('clientSecret' in view, false);
  assert.ok(!JSON.stringify(f.logs).includes('synthetic-action-secret'));
});

test('canonical cancellation before deadline observation needs no second cancellation', async () => {
  const f = await abandonedFixture();
  f.provider.intents.get(f.attempt().execution.intentId)!.status = 'canceled';
  f.s.now = Date.parse(f.cart().paymentDeadline);
  await f.run();
  assert.equal(f.attempt().execution.releaseEvidence, 'CANCELED');
  await f.run();
  assert.equal(f.cart().status, 'EXPIRED');
  assert.equal(
    f.provider.calls.some((c) => c.kind === 'cancel'),
    false,
  );
});

test('abandonment cancellation webhook and stale expiry cannot double-release', async () => {
  const f = await abandonedFixture();
  f.s.now = Date.parse(f.cart().paymentDeadline);
  await f.run();
  await f.run();
  const stale = f.message();
  const event = {
    eventId: 'evt_AbandonmentFixture',
    intentId: f.attempt().execution.intentId,
    eventType: 'payment_intent.canceled' as const,
  };
  await f.inbox.accept(event);
  const key = { PK: 'EXTERNAL_EVENT#STRIPE#' + event.eventId, SK: 'META' };
  const message = paymentMessage(
    f.s.row('operations', key)!.work,
    'STRIPE_EVENT',
  );
  await f.inbox.process(message, f.w);
  await f.w.run(stale);
  await f.inbox.accept(event);
  await f.inbox.process(message, f.w);
  assert.equal(f.cart().status, 'EXPIRED');
  assert.equal(f.inventory().reserved, 0);
  assert.equal(f.inventory().sold, 0);
  assert.equal(f.s.row('operations', key)!.state, 'PROCESSED');
});

test('abandonment release retries concurrent unrelated inventory ownership', async () => {
  const f = await abandonedFixture();
  f.inventory().sold = 2;
  f.s.now = Date.parse(f.cart().paymentDeadline);
  await f.run();
  await f.run();
  f.s.before = async (actions) => {
    if (actions[0]?.Put?.TableName !== 'catalog') return;
    f.s.before = undefined;
    await addOtherReservation(f, 3);
  };
  await f.run();
  assert.equal(f.cart().status, 'EXPIRED');
  assert.equal(f.inventory().reserved, 3);
  assert.equal(f.inventory().sold, 2);
});

test('abandonment unknown cancellation retains inventory and durable responsibility', async () => {
  const f = await abandonedFixture();
  f.s.now = Date.parse(f.cart().paymentDeadline);
  await f.run();
  f.provider.cancelIntent = async () => {
    throw new Error('PRIVATE_PROVIDER_PAYLOAD');
  };
  f.provider.retrieveIntent = async () => {
    throw new Error('PRIVATE_PROVIDER_PAYLOAD');
  };
  await f.run();
  assert.equal(f.attempt().execution.releaseEvidence, undefined);
  assert.equal(f.inventory().reserved, 5);
  assert.equal(f.inventory().sold, 0);
  assert.ok(f.s.row('operations', f.message()));
  assert.ok(f.s.row('operations', paymentWork(f.cart() as any).deadline));
  assert.equal(
    (await f.customer.get(f.cart().cartId, tokenHash)).payment.status,
    'processing',
  );
  assert.ok(!JSON.stringify(f.logs).includes('PRIVATE_PROVIDER_PAYLOAD'));
});

test('authorization racing abandonment deadline follows capture authority rather than expiry', async () => {
  const f = await abandonedFixture();
  const p = f.provider.intents.get(f.attempt().execution.intentId)!;
  p.status = 'requires_capture';
  p.amountCapturableCents = p.amountCents;
  f.s.now = Date.parse(f.cart().paymentDeadline);
  await f.run();
  assert.equal(f.attempt().status, 'AUTHORIZED');
  assert.equal(f.inventory().reserved, 5);
  assert.equal(f.attempt().execution.cancel, undefined);
  await f.run();
  await f.run();
  await f.run();
  assert.equal(f.cart().status, 'CONVERTED');
  assert.equal(f.inventory().sold, 5);
});

// All provider operations below are in-memory fixture calls, never Stripe requests.
test('explicit DEV ledger binding preserves historical recovery and exactly-once paid settlement with admission disabled', async () => {
  const { scope } = paymentIdentity({
    STRIPE_ENVIRONMENT: 'dev',
    STRIPE_ACCOUNT_ID: 'acct_actualfixture',
    STRIPE_LEDGER_ACCOUNT_ID: 'acct_actualfixture',
    STRIPE_LEDGER_NAMESPACE: 'dev:acct_historicalfixture',
  });
  const f = await fixture(1, true, scope);
  const disabled = new PaymentRepository(
    f.client,
    'catalog',
    'commerce',
    'operations',
    { fixture: 'DEVELOPMENT_ONLY_ZERO_TAX_ZERO_FEE', currency: 'usd' },
    {
      now: () => f.s.now,
      id: () => {
        throw new Error('new admission forbidden');
      },
    },
    f.provider,
    scope,
    false,
  );
  const before = structuredClone(f.attempt());
  assert.equal((await disabled.start(f.request)).status, 201);
  assert.deepEqual(f.attempt(), before);
  await assert.rejects(disabled.start({ ...f.request, key: f.s.keyValue() }), {
    code: 'PAYMENTS_DISABLED',
  });
  await f.authorize();
  const intent = f.attempt().execution.intentId;
  assert.ok(f.s.row('commerce', associationKey(scope, intent)));
  assert.equal(
    f.s.row('commerce', associationKey('dev:acct_actualfixture', intent)),
    undefined,
  );
  await f.run();
  await f.run();
  assert.equal(await f.run(), 'SETTLED');
  assert.equal(await f.w.completed(f.cart().paymentAttemptId), true);
  assert.equal(
    (await f.customer.get(f.cart().cartId, tokenHash)).payment.status,
    'paid',
  );
  await f.run();
  assert.equal(f.provider.calls.filter((c) => c.kind === 'capture').length, 1);
  assert.equal(f.inventory().reserved, 0);
  assert.equal(f.inventory().sold, 5);
  assert.ok(f.s.row('operations', paidEventKey(f.cart().orderId)));
  const isolated = new FinancialWorkflow(
    f.client,
    'commerce',
    'operations',
    f.provider,
    'dev:acct_unrelated',
    'catalog',
    () => f.s.now,
  );
  await assert.rejects(isolated.completed(f.cart().paymentAttemptId));
});

for (const winner of [0, 1]) {
  test(
    `controlled confirmation replay interleaving, winner ${winner}, settles once`,
    { timeout: 5000 },
    async () => {
      const f = await fixture();
      await f.run(); // CREATE
      await f.run(); // BIND
      const deferred = () => {
        let resolve!: () => void;
        const promise = new Promise<void>((r) => {
          resolve = r;
        });
        return { promise, resolve };
      };
      const entered = [deferred(), deferred()];
      const release = [deferred(), deferred()];
      const confirm = f.provider.confirmIntent.bind(f.provider);
      let index = 0;
      f.provider.confirmIntent = async (command) => {
        const i = index++;
        const result = await confirm(command);
        entered[i].resolve();
        await release[i].promise;
        return result;
      };
      const logs: Record<string, unknown>[] = [];
      const queue = 'arn:aws:sqs:us-east-2:123456789012:concurrency';
      const worker = createPaymentWorker(f.w, f.inbox, queue, (e) =>
        logs.push(e),
      );
      const invoke = (id: string) =>
        worker(
          {
            Records: [
              {
                messageId: id,
                eventSource: 'aws:sqs',
                eventSourceARN: queue,
                body: JSON.stringify(f.message()),
              },
            ],
          },
          { awsRequestId: `invocation-${id}` },
        );
      const first = invoke('first');
      await entered[0].promise; // First owns the durable DISPATCHED command.
      const stale = f.message();
      const second = invoke('second');
      await entered[1].promise; // Both observe the same authorized Intent.
      const runs = [first, second];
      release[winner].resolve();
      assert.deepEqual(await runs[winner], { batchItemFailures: [] });
      await f.run(); // Advance beyond the competing authorization transition.
      release[1 - winner].resolve();
      assert.equal((await runs[1 - winner]).batchItemFailures.length, 1);
      assert.ok(logs.some((e) => e.errorCode === 'PAYMENT_BUSY'));
      assert.ok(
        logs.some(
          (e) =>
            e.operation === 'financialTransition' &&
            e.errorClassification === 'TransactionCanceledException',
        ),
      );
      const confirms = f.provider.calls.filter((c) => c.kind === 'confirm');
      assert.equal(confirms.length, 2);
      assert.equal(new Set(confirms.map((c) => c.key)).size, 1);
      assert.equal(f.provider.confirmKeys.size, 1);
      const transition = logs.find(
        (e) => e.operation === 'financialTransition',
      )!;
      assert.equal(transition.phase, 'CONFIRM');
      assert.equal(
        transition.lambdaRequestId,
        `invocation-${winner === 0 ? 'second' : 'first'}`,
      );
      assert.match(String(transition.commandIdSha256), /^[a-f0-9]{64}$/);
      for (const secret of [
        f.request.customer.email,
        f.request.confirmationTokenId,
        confirms[0].key!,
      ])
        assert.ok(!JSON.stringify(logs).includes(secret));
      // Force both workers to reach their transaction with the same snapshot.
      const compete = async () => {
        const atWrite = [deferred(), deferred()];
        const proceed = [deferred(), deferred()];
        let writes = 0;
        f.s.before = async () => {
          const i = writes++;
          if (i < 2) {
            atWrite[i].resolve();
            await proceed[i].promise;
          }
        };
        const pointer = f.message();
        const a = f.w.run(pointer);
        await atWrite[0].promise;
        const b = f.w.run(pointer);
        await atWrite[1].promise;
        const tasks = [a, b].map((p) =>
          p.then(
            (value) => ({ value }),
            (error) => ({ error }),
          ),
        );
        proceed[winner].resolve();
        const won = await tasks[winner];
        proceed[1 - winner].resolve();
        const lost = await tasks[1 - winner];
        f.s.before = undefined;
        assert.ok('value' in won);
        if ('error' in lost) assert.equal(lost.error.code, 'PAYMENT_BUSY');
        else
          assert.ok(
            ['STALE_WORK', 'COMPLETED', 'SETTLED'].includes(lost.value),
          );
      };
      await compete();
      assert.equal(
        f.provider.calls.filter((c) => c.kind === 'capture').length,
        1,
      );
      await compete();
      assert.equal(await f.w.run(stale), 'STALE_WORK');
      assert.equal(f.cart().status, 'CONVERTED');
      assert.equal(f.attempt().status, 'CAPTURED');
      assert.equal(
        f.s.row('commerce', orderKey(f.cart().orderId))!.status,
        'PAID',
      );
      assert.equal(f.inventory().sold, 2);
      assert.equal(f.inventory().reserved, 0);
      assert.equal(
        [...f.s.rows.values()].filter((r) => r.eventType === 'PAID').length,
        1,
      );
      assert.ok(f.s.row('operations', paidEventKey(f.cart().orderId)));
    },
  );
}

test('transition diagnostics distinguish transaction failure from failed authoritative reread without changing retry', async () => {
  const f = await fixture();
  await f.authorize();
  const originalAttempt = f.w.attempt.bind(f.w);
  const denied = Object.assign(new Error('SECRET_RAW_READ_ERROR'), {
    name: 'AccessDeniedException',
  });
  f.s.before = () => {
    f.w.attempt = async () => {
      throw denied;
    };
    throw Object.assign(new Error('SECRET_RAW_TRANSACTION_ERROR'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [
        { Code: 'ConditionalCheckFailed', Message: 'SECRET_CUSTOMER' },
      ],
    });
  };
  const logs: Record<string, unknown>[] = [];
  const queue = 'arn:aws:sqs:us-east-2:123456789012:diagnostics';
  const worker = createPaymentWorker(f.w, f.inbox, queue, (e) => logs.push(e));
  const result = await worker(
    {
      Records: [
        {
          messageId: 'reread',
          eventSource: 'aws:sqs',
          eventSourceARN: queue,
          body: JSON.stringify(f.message()),
        },
      ],
    },
    { awsRequestId: 'read-invocation' },
  );
  assert.equal(result.batchItemFailures.length, 1);
  assert.ok(
    logs.some(
      (e) =>
        e.operation === 'financialTransition' &&
        e.errorClassification === 'TransactionCanceledException',
    ),
  );
  assert.ok(
    logs.some(
      (e) =>
        e.operation === 'transitionReread' &&
        e.errorClassification === 'AccessDeniedException',
    ),
  );
  assert.equal(logs.at(-1)!.disposition, 'RETRY');
  assert.ok(!JSON.stringify(logs).includes('SECRET_'));
  assert.equal(f.inventory().sold, 0);
  f.w.attempt = originalAttempt;
  f.s.before = undefined;
});

async function routeDueWaitingWork(
  f: Awaited<ReturnType<typeof fixture>>,
  fail = false,
) {
  const messages: PaymentMessage[] = [];
  const reconciler = new ExpiryReconciler(
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
      send: async (m) => {
        if (fail) throw new Error('synthetic send failure');
        messages.push(m);
      },
    },
  );
  await reconciler.run();
  return messages;
}

test('waiting polls remain durable without self-enqueue, missed routing safely expires once', async () => {
  const f = await fixture();
  f.provider.outcome = 'requires_action';
  await f.authorize();
  const deadline = f.cart().paymentDeadline;
  const sends = f.dispatched.length;
  const first = f.message();
  // Independent wakes can be duplicated or frequent; none extends the worker chain.
  for (let i = 0; i < 12; i++) {
    f.s.now += 15000;
    const due = await routeDueWaitingWork(f);
    const current = f.message();
    assert.ok(
      due.some((m) => m.SK === current.SK && m.revision === current.revision),
    );
    await f.w.run(current);
    assert.equal(await f.w.run(current), 'STALE_WORK');
    assert.ok(f.s.row('operations', f.message()));
    assert.equal(f.dispatched.length, sends);
    assert.equal(f.cart().paymentDeadline, deadline);
  }
  f.s.now += 15000;
  await assert.rejects(routeDueWaitingWork(f, true));
  assert.ok(f.s.row('operations', f.message()));
  // A missed minute does not remove responsibility or move the deadline.
  f.s.now = Date.parse(deadline) + 120000;
  const due = await routeDueWaitingWork(f);
  assert.ok(due.some((m) => m.kind === 'PAYMENT'));
  assert.ok(due.some((m) => m.kind === 'WORKFLOW'));
  for (const m of due) {
    if (m.kind === 'STRIPE_EVENT') await f.inbox.process(m, f.w);
    else await f.w.run(m);
  }
  for (let i = 0; i < 8 && f.attempt().status !== 'EXPIRED'; i++) await f.run();
  assert.equal(f.attempt().status, 'EXPIRED');
  assert.equal(f.attempt().execution.releaseEvidence, 'CANCELED');
  assert.equal(f.cart().paymentDeadline, deadline);
  assert.equal(await f.w.run(first), 'STALE_WORK');
  for (const m of due) assert.equal(await f.w.run(m), 'STALE_WORK');
  assert.equal(f.provider.calls.filter((c) => c.kind === 'cancel').length, 1);
  assert.equal(f.provider.calls.filter((c) => c.kind === 'capture').length, 0);
  assert.deepEqual(
    [f.inventory().total, f.inventory().reserved, f.inventory().sold],
    [100, 0, 0],
  );
  assert.equal(
    f.s.row('operations', paidEventKey(f.cart().orderId)),
    undefined,
  );
});

for (const winner of ['continuation', 'webhook'] as const) {
  test(`waiting continuation races webhook and deadline, ${winner} wins, settles once`, async () => {
    const f = await fixture();
    f.provider.outcome = 'requires_action';
    await f.authorize();
    const deadline = f.cart().paymentDeadline;
    const intent = f.attempt().execution.intentId;
    const view = await f.customer.get(f.cart().cartId, tokenHash);
    const p = f.provider.intents.get(intent)!;
    p.status = 'requires_capture';
    p.amountCapturableCents = p.amountCents;
    let entered!: () => void, release!: () => void;
    const barrier = new Promise<void>((r) => {
      entered = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const retrieve = f.provider.retrieveIntent.bind(f.provider);
    let first = true;
    f.provider.retrieveIntent = async (id) => {
      const result = await retrieve(id);
      if (first) {
        first = false;
        entered();
        await gate;
      }
      return result;
    };
    await f.inbox.accept({
      eventId: 'evt_WaitRace',
      intentId: intent,
      eventType: 'payment_intent.amount_capturable_updated',
    });
    const receipt = f.s.row('operations', {
      PK: 'EXTERNAL_EVENT#STRIPE#evt_WaitRace',
      SK: 'META',
    })!;
    const webhook = () =>
      f.inbox.process(paymentMessage(receipt.work, 'STRIPE_EVENT'), f.w);
    const continuation = () =>
      f.customer.confirm({
        cartId: f.cart().cartId,
        tokenHash,
        ifMatch: view.etag,
        key: f.s.keyValue(),
        continuationGeneration: 1,
      });
    const sends = f.dispatched.length;
    const loser = winner === 'continuation' ? webhook : continuation;
    const blocked = loser().then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await barrier;
    await (winner === 'continuation' ? continuation() : webhook());
    assert.ok(
      f.dispatched.length > sends,
      'authentication completion wakes immediately',
    );
    f.s.now = Date.parse(deadline);
    const due = await routeDueWaitingWork(f);
    for (const m of due) {
      if (m.kind === 'STRIPE_EVENT') await f.inbox.process(m, f.w);
      else await f.w.run(m);
    }
    release();
    await blocked;
    for (let i = 0; i < 10 && f.cart().status !== 'CONVERTED'; i++)
      await f.run();
    for (const m of due) {
      if (m.kind === 'STRIPE_EVENT') await f.inbox.process(m, f.w);
      else await f.w.run(m);
    }
    assert.equal(f.cart().status, 'CONVERTED');
    assert.equal(f.attempt().execution.intentId, intent);
    assert.equal(f.provider.intents.size, 1);
    for (const kind of ['create', 'confirm', 'capture'])
      assert.equal(f.provider.calls.filter((c) => c.kind === kind).length, 1);
    assert.equal(f.provider.calls.filter((c) => c.kind === 'cancel').length, 0);
    assert.equal(f.cart().paymentDeadline, deadline);
    assert.deepEqual(
      [f.inventory().total, f.inventory().reserved, f.inventory().sold],
      [100, 0, 2],
    );
    assert.ok(f.s.row('operations', paidEventKey(f.cart().orderId)));
    assert.equal(
      (await f.customer.get(f.cart().cartId, tokenHash)).payment.status,
      'paid',
    );
  });
}

test('minute-cadence reconciliation discovers waiting work without a worker wake', async () => {
  const f = await fixture();
  f.provider.outcome = 'requires_action';
  await f.authorize();
  const sends = f.dispatched.length;
  const deadline = f.cart().paymentDeadline;
  // A due time just after a scheduled tick waits until the next tick.
  const dueAt = Date.parse(f.message().SK.split('#')[0]);
  f.s.now = dueAt - 1;
  assert.equal(
    (await routeDueWaitingWork(f)).some((m) => m.kind === 'WORKFLOW'),
    false,
  );
  for (let tick = 0; tick < 3; tick++) {
    f.s.now += 60000;
    const messages = await routeDueWaitingWork(f);
    const waits = messages.filter((m) => m.kind === 'WORKFLOW');
    assert.equal(waits.length, 1);
    await f.w.run(waits[0]);
    assert.equal(f.attempt().execution.stage, 'WAIT_FOR_CUSTOMER_ACTION');
    assert.equal(f.dispatched.length, sends);
    assert.equal(f.cart().paymentDeadline, deadline);
    assert.equal(f.inventory().reserved, 2);
    assert.equal(f.inventory().sold, 0);
  }
});
