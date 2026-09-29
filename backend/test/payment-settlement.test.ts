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

async function fixture(products = 1) {
  const f = await paymentFixture(true, undefined, products);
  const logs: unknown[] = [];
  const w = new FinancialWorkflow(
    f.client,
    'commerce',
    'operations',
    f.provider,
    f.scope,
    'catalog',
    () => f.s.now,
    undefined,
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
    customer: new PaymentCustomer(w, f.provider),
  };
}
test('capture claim, dispatch, evidence and paid conversion preserve ownership until atomic settlement', async () => {
  const f = await fixture();
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
  assert.equal(f.s.transactions.at(-1)!.length, 7);
  assert.equal(f.cart().status, 'CONVERTED');
  assert.equal(f.inventory().reserved, 0);
  assert.equal(f.inventory().sold, 2);
  assert.equal(f.cart().committingStartedAt, start);
  assert.equal(await f.w.completed(f.cart().paymentAttemptId), true);
  assert.equal(
    (await f.customer.get(f.cart().cartId, tokenHash)).payment.status,
    'paid',
  );
  assert.equal(f.provider.calls.filter((c) => c.kind === 'capture').length, 1);
});
test('different-key capture claim uses six distinct actions', async () => {
  const f = await fixture();
  await f.authorize();
  f.s.now += 1;
  await f.run();
  assert.equal(f.s.transactions.at(-1)!.length, 6);
});
for (const index of [0, 1, 2, 3, 4, 5, 6])
  test(`paid finalization rollback action ${index}`, async () => {
    const f = await fixture();
    await f.captured();
    const original = new Map(structuredClone(f.s.rows));
    f.s.before = (actions) => {
      if (actions.length === 7)
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
    const size = 12 + (paid ? 6 : 5) + (event ? 2 : 0);
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
  assert.equal(f.s.transactions.at(-1)!.length, 9);
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
    if (a.length === 7 && conflicts++ < 2) f.inventory().total++;
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
    if (a.length === 7) {
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
