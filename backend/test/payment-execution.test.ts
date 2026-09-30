import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paymentFixture } from './payment-execution-fixture';
import {
  associationKey,
  paymentMessageSchema,
  paymentMessage,
  paymentEtag,
  stages,
} from '../src/payment-execution-domain';
import { expiryShard } from '../src/cart-expiry';
import { pid, tokenHash, token } from './cart-store';
import { catalogKeys } from '../src/keys';
import { dropId, productId } from './fixtures';
import { startPaymentSchema } from '../src/payment-domain';
import { localPaymentApi } from '../src/payment-api';
import { createHandler } from '../src/api';
import { createPaymentWorker } from '../src/payment-worker';

for (const shard of ['00', '0F'])
  test(`canonical message accepts ${shard} and helper produces it`, () => {
    const id = Array.from({ length: 1000 }, (_, i) => pid(i)).find(
      (id) => expiryShard(id) === shard,
    )!;
    assert.ok(id);
    assert.equal(
      paymentMessageSchema.safeParse({
        schemaVersion: 1,
        source: 'batch-and-batter.payment',
        kind: 'WORKFLOW',
        PK: `CART_EXPIRY#V1#${expiryShard(id)}`,
        SK: 'work',
        revision: 0,
      }).success,
      true,
    );
  });
for (const shard of ['0', 'F', '10', '0f', '000'])
  test(`reject noncanonical shard ${shard}`, () => {
    assert.equal(
      paymentMessageSchema.safeParse({
        schemaVersion: 1,
        source: 'batch-and-batter.payment',
        kind: 'WORKFLOW',
        PK: `CART_EXPIRY#V1#${shard}`,
        SK: 'work',
        revision: 0,
      }).success,
      false,
    );
  });
for (const field of [
  'confirmationTokenId',
  'amount',
  'currency',
  'paymentIntentId',
])
  test(`start contract authority: ${field}`, async () => {
    const f = await paymentFixture(false);
    const body = {
      confirmationTokenId: f.request.confirmationTokenId,
      customer: f.request.customer,
      pickupDate: f.request.pickupDate,
    };
    assert.equal(
      startPaymentSchema.safeParse(
        field === 'confirmationTokenId'
          ? { ...body, confirmationTokenId: undefined }
          : { ...body, [field]: 1 },
      ).success,
      false,
    );
  });
for (const invalid of [
  { expiresAt: 0 },
  { paymentIntent: 'pi_Other' },
  { setupIntent: 'seti_Other' },
  { type: 'bank' },
  { livemode: true },
  { id: 'ctoken_Other' },
])
  test(`reject invalid token ${Object.keys(invalid)[0]} before grace`, async () => {
    const f = await paymentFixture(false);
    f.provider.tokenResult = invalid as any;
    await assert.rejects(f.repo.start(f.request));
    assert.equal(f.cart().status, 'ACTIVE');
  });
test('token association and accepted deadline are immutable; changed replay token conflicts', async () => {
  const f = await paymentFixture();
  const deadline = f.cart().paymentDeadline;
  assert.equal(Date.parse(deadline), f.s.now + 240000);
  assert.equal(
    f.attempt().execution.confirmationTokenId,
    f.request.confirmationTokenId,
  );
  const ownership = [...f.s.rows.values()].filter((r) =>
    r.PK.startsWith('STRIPE_SUBMISSION#'),
  );
  assert.equal(ownership.length, 1);
  assert.ok(!JSON.stringify(ownership).includes(f.request.confirmationTokenId));
  f.s.now += 1000;
  await f.repo.start(f.request);
  await assert.rejects(
    f.repo.start({ ...f.request, confirmationTokenId: 'ctoken_Other' }),
  );
  assert.equal(f.cart().paymentDeadline, deadline);
});
test('same submission cannot be accepted by a second Cart/Attempt', async () => {
  const f = await paymentFixture();
  const c = await f.s
    .repository()
    .mutate(f.s.request([{ productId, quantity: 1 }]), { attempts: 0 });
  await assert.rejects(
    f.repo.start({
      ...f.request,
      cartId: c.cart.cartId,
      ifMatch: (await import('../src/cart-domain')).etag(c.cart.updatedAt),
      key: f.s.keyValue(),
    }),
  );
  assert.equal(
    [...f.s.rows.values()].filter((r) => r.PK.startsWith('PAYMENT_ATTEMPT#'))
      .length,
    1,
  );
});
test('durable create and confirm commands precede provider calls; binding precedes confirmation', async () => {
  const f = await paymentFixture();
  f.provider.onCreate = () => {
    assert.equal(f.attempt().execution.create.state, 'DISPATCHED');
    assert.ok(f.s.row('operations', f.message()));
  };
  f.provider.onConfirm = () => {
    assert.equal(f.attempt().execution.confirmations[0].state, 'DISPATCHED');
    assert.ok(
      f.s.row(
        'commerce',
        associationKey(f.scope, f.attempt().execution.intentId),
      ),
    );
  };
  await f.bind();
  await f.run();
  assert.equal(f.attempt().execution.stage, 'WAIT_FOR_CUSTOMER_ACTION');
  assert.equal(f.attempt().status, 'AUTHENTICATING');
  assert.equal(f.provider.createKeys.size, 1);
  assert.equal(f.provider.confirmKeys.size, 1);
});
test('duplicate and stale create deliveries never allocate a second intent', async () => {
  const f = await paymentFixture();
  const old = f.message();
  await Promise.allSettled([f.workflow.run(old), f.workflow.run(old)]);
  assert.equal(await f.workflow.run(old), 'STALE_WORK');
  await f.run();
  assert.equal(f.provider.intents.size, 1);
});
for (const lost of ['lostCreate', 'timeoutCreate'] as const)
  test(`create ${lost} retains command/work and reuses original key`, async () => {
    const f = await paymentFixture();
    f.provider[lost] = true;
    await assert.rejects(f.run());
    assert.equal(f.attempt().execution.create.state, 'DISPATCHED');
    assert.ok(f.s.row('operations', f.message()));
    f.provider[lost] = false;
    await f.run();
    await f.run();
    assert.equal(f.provider.intents.size, 1);
    assert.equal(
      new Set(
        f.provider.calls.filter((c) => c.kind === 'create').map((c) => c.key),
      ).size,
      1,
    );
  });
test('provider success followed by transaction crash recovers original Intent', async () => {
  const f = await paymentFixture();
  f.provider.onCreate = () => {
    f.s.before = () => {
      f.s.before = undefined;
      throw new Error('crash');
    };
  };
  await assert.rejects(f.run());
  f.provider.onCreate = undefined;
  assert.equal(f.provider.intents.size, 1);
  await f.run();
  await f.run();
  assert.equal(f.attempt().execution.intentId, 'pi_Test1');
  assert.equal(f.provider.intents.size, 1);
});
test('crash after bind cannot create another Intent or command', async () => {
  const f = await paymentFixture();
  await f.run();
  const binding = f.message();
  f.s.after = () => {
    f.s.after = undefined;
    throw new Error('lost bind response');
  };
  await assert.rejects(f.workflow.run(binding));
  assert.equal(await f.workflow.run(binding), 'STALE_WORK');
  await f.run();
  assert.equal(f.provider.intents.size, 1);
  assert.equal(f.attempt().execution.confirmations.length, 1);
});
test('association collision is quarantined durably without overwrite', async () => {
  const f = await paymentFixture();
  await f.run();
  const key = associationKey(f.scope, 'pi_Test1');
  f.s.put('commerce', {
    ...key,
    scope: f.scope,
    intentId: 'pi_Test1',
    cartId: pid(90),
    orderId: pid(91),
    paymentAttemptId: pid(92),
    environment: 'dev',
    createdAt: new Date(f.s.now).toISOString(),
  });
  await f.run();
  assert.equal(f.attempt().execution.stage, 'RECOVERY_REQUIRED');
  assert.equal(f.s.row('commerce', key)!.paymentAttemptId, pid(92));
  assert.ok(f.s.row('operations', f.message()));
});
test('23 hour LOCAL cutoff refuses a create retry', async () => {
  const f = await paymentFixture();
  f.s.now += 23 * 3600000;
  await f.run();
  assert.equal(f.attempt().execution.recoveryReason, 'RETRY_HORIZON');
  assert.equal(f.provider.calls.length, 0);
});
for (const [status, stage] of [
  ['requires_action', 'WAIT_FOR_CUSTOMER_ACTION'],
  ['processing', 'VERIFY_AUTHORIZATION'],
  ['requires_confirmation', 'VERIFY_AUTHORIZATION'],
  ['requires_capture', 'CLAIM_CAPTURE'],
  ['requires_payment_method', 'RESOLVE_FAILURE'],
  ['canceled', 'RESOLVE_FAILURE'],
  ['succeeded', 'FINALIZE_ORDER'],
] as const)
  test(`confirm ${status} retains inventory and maps to ${stage}`, async () => {
    const f = await paymentFixture();
    f.provider.outcome = status;
    await f.bind();
    await f.run();
    assert.equal(f.attempt().execution.stage, stage);
    assert.equal(
      f.attempt().status,
      status === 'requires_capture' ? 'AUTHORIZED' : 'AUTHENTICATING',
    );
    assert.equal(f.cart().status, 'PAYMENT_PENDING');
    assert.equal(
      f.s.row('catalog', catalogKeys.inventory(dropId, productId))!.sold,
      0,
    );
    assert.equal(
      f.s.row('catalog', catalogKeys.inventory(dropId, productId))!.reserved,
      2,
    );
  });
test('confirm response loss uses the same durable command without new generation', async () => {
  const f = await paymentFixture();
  await f.bind();
  f.provider.lostConfirm = true;
  await f.run();
  assert.equal(f.provider.confirmKeys.size, 1);
  assert.equal(f.attempt().execution.confirmations.length, 1);
});
test('Attempt-only transitions advance payment ETag; stale continuation is rejected', async () => {
  const f = await paymentFixture();
  const before = await f.customer.get(f.request.cartId, tokenHash);
  const cartUpdatedAt = f.cart().updatedAt;
  await f.bind();
  await f.run();
  const after = await f.customer.get(f.request.cartId, tokenHash);
  assert.notEqual(before.etag, after.etag);
  assert.equal(f.cart().updatedAt, cartUpdatedAt);
  assert.equal(after.payment.status, 'action_required');
  assert.equal(after.payment.clientSecret, 'synthetic-action-secret');
  f.provider.intents.get('pi_Test1')!.status = 'requires_capture';
  f.provider.intents.get('pi_Test1')!.amountCapturableCents =
    f.provider.intents.get('pi_Test1')!.amountCents;
  await assert.rejects(
    f.customer.confirm({
      cartId: f.request.cartId,
      tokenHash,
      ifMatch: before.etag,
      key: f.s.keyValue(),
      continuationGeneration: 1,
    }),
  );
});
test('customer action wakes canonical retrieval; replay never reconfirms or extends grace', async () => {
  const f = await paymentFixture();
  await f.bind();
  await f.run();
  const deadline = f.cart().paymentDeadline;
  f.provider.intents.get('pi_Test1')!.status = 'requires_capture';
  f.provider.intents.get('pi_Test1')!.amountCapturableCents =
    f.provider.intents.get('pi_Test1')!.amountCents;
  const current = await f.customer.get(f.request.cartId, tokenHash);
  const req = {
    cartId: f.request.cartId,
    tokenHash,
    ifMatch: current.etag,
    key: f.s.keyValue(),
    continuationGeneration: 1,
  };
  await f.customer.confirm(req);
  await f.customer.confirm(req);
  assert.equal(f.attempt().execution.confirmations.length, 1);
  assert.equal(f.cart().paymentDeadline, deadline);
  f.provider.outcome = 'requires_capture';
  await f.run();
  assert.equal(f.provider.confirmKeys.size, 1);
  assert.equal(f.provider.intents.size, 1);
});
test('continuation at payment deadline fails closed', async () => {
  const f = await paymentFixture();
  await f.bind();
  await f.run();
  const current = await f.customer.get(f.request.cartId, tokenHash);
  f.s.now = Date.parse(f.cart().paymentDeadline);
  await assert.rejects(
    f.customer.confirm({
      cartId: f.request.cartId,
      tokenHash,
      ifMatch: current.etag,
      key: f.s.keyValue(),
      continuationGeneration: 1,
    }),
  );
  assert.equal(f.attempt().execution.confirmations.length, 1);
});
for (const stage of stages.options.filter((s) =>
  [
    'CLAIM_CAPTURE',
    'CAPTURE',
    'VERIFY_CAPTURE',
    'FINALIZE_ORDER',
    'RESOLVE_FAILURE',
    'RECOVERY_REQUIRED',
  ].includes(s),
))
  test(`5B2A retains but cannot execute ${stage}`, async () => {
    const f = await paymentFixture();
    const state = (await f.workflow.load(f.message()))!;
    await f.workflow.advance(state, { ...state.e, stage });
    const before = structuredClone(f.s.rows);
    assert.equal(await f.run(), 'PHASE_5B2B_REQUIRED');
    assert.deepEqual(f.s.rows, before);
    assert.equal(f.provider.calls.length, 0);
  });
test('lost workflow dispatch leaves successor durable and wrong revision cannot execute', async () => {
  const f = await paymentFixture(true, async () => {
    throw new Error('queue down');
  });
  await f.run();
  assert.ok(f.s.row('operations', f.message()));
  assert.equal(
    await f.workflow.run({ ...f.message(), revision: 999 }),
    'STALE_WORK',
  );
  await f.run();
  assert.equal(f.attempt().execution.stage, 'CONFIRM');
});
test('local confirm route validates capability/revision/generation and production routes stay absent', async () => {
  const f = await paymentFixture();
  await f.bind();
  await f.run();
  f.provider.intents.get('pi_Test1')!.status = 'requires_capture';
  f.provider.intents.get('pi_Test1')!.amountCapturableCents =
    f.provider.intents.get('pi_Test1')!.amountCents;
  const current = await f.customer.get(f.request.cartId, tokenHash);
  const event = {
    routeKey: 'POST /carts/{cartId}/payment/confirm',
    requestContext: { requestId: 'fixture', http: { method: 'POST' } },
    headers: {
      'X-Cart-Token': token,
      'If-Match': current.etag,
      'Idempotency-Key': f.s.keyValue(),
    },
    pathParameters: { cartId: f.request.cartId },
    body: JSON.stringify({ continuationGeneration: 1 }),
  };
  assert.equal(
    (await localPaymentApi(event, f.repo, f.customer)).statusCode,
    202,
  );
  const handler = createHandler(() => {
    throw new Error('must not construct dependencies');
  });
  for (const route of [
    'POST /carts/{cartId}/payment/start',
    'POST /carts/{cartId}/payment/confirm',
    'GET /carts/{cartId}/payment',
    'POST /webhooks/stripe',
  ])
    assert.equal(
      (
        await handler({
          ...event,
          routeKey: route,
          requestContext: {
            ...event.requestContext,
            http: { method: route.split(' ')[0] },
          },
        })
      ).statusCode,
      404,
    );
});
test('worker rejects wrong source and logs no provider exception data', async () => {
  const f = await paymentFixture();
  const worker = createPaymentWorker(f.workflow, f.inbox, 'queue');
  const logs: string[] = [];
  const old = console.info;
  console.info = (s) => logs.push(String(s));
  try {
    const result = await worker({
      Records: [
        {
          messageId: 'm',
          eventSource: 'aws:sqs',
          eventSourceARN: 'wrong',
          body: JSON.stringify(f.message()),
        },
      ],
    });
    assert.equal(result.batchItemFailures.length, 1);
    f.provider.createIntent = async () => {
      throw new Error(
        f.request.confirmationTokenId +
          f.request.customer.email +
          f.request.key,
      );
    };
    await worker({
      Records: [
        {
          messageId: 'm',
          eventSource: 'aws:sqs',
          eventSourceARN: 'queue',
          body: JSON.stringify(f.message()),
        },
      ],
    });
    for (const secret of [
      f.request.confirmationTokenId,
      f.request.customer.email,
      f.request.key,
      token,
    ])
      assert.ok(!logs.join('').includes(secret));
  } finally {
    console.info = old;
  }
  const operational = JSON.stringify(
    [...f.s.rows].filter(([key]) => key.startsWith('operations|')),
  );
  for (const secret of [
    f.request.confirmationTokenId,
    f.request.customer.email,
    f.request.key,
    token,
    'synthetic-action-secret',
  ])
    assert.ok(!operational.includes(secret));
});

test('crash after create dispatch authority commits but before provider runs is replay safe', async () => {
  const f = await paymentFixture();
  f.s.after = () => {
    f.s.after = undefined;
    throw new Error('process crash');
  };
  await assert.rejects(f.run());
  assert.equal(f.provider.calls.length, 0);
  assert.equal(f.attempt().execution.create.state, 'DISPATCHED');
  await f.run();
  await f.run();
  assert.equal(f.provider.intents.size, 1);
});
test('crash after confirm dispatch authority commits uses original generation', async () => {
  const f = await paymentFixture();
  await f.bind();
  f.s.after = () => {
    f.s.after = undefined;
    throw new Error('process crash');
  };
  await assert.rejects(f.run());
  assert.equal(f.provider.confirmKeys.size, 0);
  await f.run();
  assert.equal(f.provider.confirmKeys.size, 1);
  assert.equal(f.attempt().execution.confirmations.length, 1);
});
test('SDK-style confirmation decline exception is resolved by retrieval, not its raw error', async () => {
  const f = await paymentFixture();
  await f.bind();
  f.provider.confirmIntent = async () => {
    const p = f.provider.intents.get('pi_Test1')!;
    p.paymentFailed = true;
    p.status = 'requires_payment_method';
    throw new Error('private decline data');
  };
  await f.run();
  assert.equal(f.attempt().execution.stage, 'RESOLVE_FAILURE');
  assert.equal(f.cart().status, 'PAYMENT_PENDING');
});
test('ambiguous confirm failure with unconfirmed Intent retains original dispatched command', async () => {
  const f = await paymentFixture();
  await f.bind();
  f.provider.confirmIntent = async () => {
    throw new Error('unknown');
  };
  await assert.rejects(f.run());
  assert.equal(f.attempt().execution.stage, 'CONFIRM');
  assert.equal(f.attempt().execution.confirmations[0].state, 'DISPATCHED');
  assert.ok(f.s.row('operations', f.message()));
});
test('immutable parameters/token cannot be replaced by a workflow transition', async () => {
  const f = await paymentFixture();
  const state = (await f.workflow.load(f.message()))!;
  await assert.rejects(
    f.workflow.advance(state, {
      ...state.e,
      confirmationTokenId: 'ctoken_Replacement',
    }),
  );
  await assert.rejects(
    f.workflow.advance(state, {
      ...state.e,
      parameters: { ...state.e.parameters, amountCents: 999 },
    }),
  );
  assert.equal(f.provider.calls.length, 0);
});
test('requires_capture with incorrect capturable amount is quarantined', async () => {
  const f = await paymentFixture();
  await f.bind();
  f.provider.confirmIntent = async () => ({
    ...f.provider.intents.get('pi_Test1')!,
    status: 'requires_capture',
    amountCapturableCents: 1,
  });
  await f.run();
  assert.equal(f.attempt().execution.stage, 'RECOVERY_REQUIRED');
  assert.notEqual(f.attempt().status, 'AUTHORIZED');
});
test('confirmation receipt resolves a lost transaction response with stable acceptance', async () => {
  const f = await paymentFixture();
  await f.bind();
  await f.run();
  f.provider.intents.get('pi_Test1')!.status = 'requires_capture';
  f.provider.intents.get('pi_Test1')!.amountCapturableCents =
    f.provider.intents.get('pi_Test1')!.amountCents;
  const { etag } = await f.customer.get(f.request.cartId, tokenHash);
  const req = {
    cartId: f.request.cartId,
    tokenHash,
    ifMatch: etag,
    key: f.s.keyValue(),
    continuationGeneration: 1,
  };
  f.s.after = () => {
    f.s.after = undefined;
    throw new Error('response lost');
  };
  assert.equal((await f.customer.confirm(req)).status, 202);
  assert.equal((await f.customer.confirm(req)).status, 202);
  assert.equal(f.attempt().execution.confirmations.length, 1);
});

test('DynamoDB reads send only PK/SK, never queue envelope or revision fields as key attributes', async () => {
  const f = await paymentFixture();
  const original = f.client.send.bind(f.client);
  (f.client as any).send = async (command: any, ...rest: any[]) => {
    if (command.constructor.name === 'GetCommand')
      assert.deepEqual(Object.keys(command.input.Key).sort(), ['PK', 'SK']);
    return (original as any)(command, ...rest);
  };
  await f.bind();
  await f.run();
  await f.customer.get(f.request.cartId, tokenHash);
});

test('deadline crossing during association lookup prevents confirmation dispatch', async () => {
  const f = await paymentFixture();
  await f.bind();
  const original = f.client.send.bind(f.client);
  (f.client as any).send = async (command: any, ...rest: any[]) => {
    const result = await (original as any)(command, ...rest);
    if (
      command.constructor.name === 'GetCommand' &&
      command.input.Key.PK.startsWith('STRIPE_PAYMENT_INTENT#')
    )
      f.s.now = Date.parse(f.cart().paymentDeadline);
    return result;
  };
  await f.run();
  assert.equal(f.provider.confirmKeys.size, 0);
  assert.equal(f.attempt().execution.recoveryReason, 'DEADLINE');
});
