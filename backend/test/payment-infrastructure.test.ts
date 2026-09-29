import { token } from './cart-store';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paymentFixture } from './payment-execution-fixture';
import { PaymentRepository } from '../src/payment-repository';
import { paymentStartEnabled, secretLoader } from '../src/payment-runtime';
import { localPaymentApi } from '../src/payment-api';
import { webhookEntrypoint } from '../src/stripe-webhook-handler';
import {
  financialGauges,
  observeFinancial,
  monitoringProjection,
} from '../src/payment-metrics';
import { workflowSchema } from '../src/payment-execution-domain';
import type { ApiEvent } from '../src/api';

function repository(
  f: Awaited<ReturnType<typeof paymentFixture>>,
  enabled = false,
  dispatch?: ConstructorParameters<typeof PaymentRepository>[9],
) {
  return new PaymentRepository(
    f.client,
    'catalog',
    'commerce',
    'operations',
    { fixture: 'DEVELOPMENT_ONLY_ZERO_TAX_ZERO_FEE', currency: 'usd' },
    {
      now: () => f.s.now,
      id: () => {
        throw new Error('No admission expected');
      },
    },
    f.provider,
    f.scope,
    enabled,
    dispatch,
  );
}
for (const value of [undefined, '', 'false', 'TRUE', '1', ' true ', 'yes'])
  test(`admission fails closed for ${JSON.stringify(value)}`, () =>
    assert.equal(paymentStartEnabled(value), false));
test('only literal true enables admission', () =>
  assert.equal(paymentStartEnabled('true'), true));
test('disabled new start performs receipt read only; no provider, transaction, dispatch or IDs', async () => {
  const f = await paymentFixture(false);
  let reads = 0,
    sends = 0;
  f.provider.retrieveConfirmationToken = async () => {
    reads++;
    throw new Error();
  };
  const repo = repository(f, false, async () => {
    sends++;
  });
  const before = structuredClone(f.cart());
  await assert.rejects(repo.start(f.request), {
    code: 'PAYMENTS_DISABLED',
    status: 503,
  });
  assert.deepEqual(f.cart(), before);
  assert.equal(reads, 0);
  assert.equal(sends, 0);
  assert.equal(f.cart().paymentAttemptId, undefined);
});
test('disabled admission preserves accepted receipt replay and conflict semantics', async () => {
  const f = await paymentFixture();
  const repo = repository(f);
  assert.deepEqual(await repo.start(f.request), await f.repo.start(f.request));
  await assert.rejects(
    repo.start({ ...f.request, confirmationTokenId: 'ctoken_OtherFixture' }),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );
});
test('payment HTTP maps disabled admission to sanitized 503 no-store', async () => {
  const f = await paymentFixture(false);
  const event = {
    routeKey: 'POST /carts/{cartId}/payment/start',
    requestContext: { requestId: 'disabled', http: { method: 'POST' } },
    pathParameters: { cartId: f.request.cartId },
    headers: {
      'x-cart-token': token,
      'if-match': f.request.ifMatch,
      'idempotency-key': f.request.key,
    },
    body: JSON.stringify({
      confirmationTokenId: f.request.confirmationTokenId,
      pickupDate: f.request.pickupDate,
      customer: f.request.customer,
    }),
  } as ApiEvent;
  const result = await localPaymentApi(event, repository(f));
  assert.equal(result.statusCode, 503);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(JSON.parse(result.body).code, 'PAYMENTS_DISABLED');
});
test('lazy SecureString loader retries missing secret and expires successful cache', async () => {
  let calls = 0,
    now = 0;
  const load = secretLoader(
    {
      send: async (command: any) => {
        calls++;
        assert.deepEqual(command.input, {
          Name: '/fixture/secret',
          WithDecryption: true,
        });
        if (calls === 1) throw new Error('private failure');
        return { Parameter: { Type: 'SecureString', Value: 'synthetic' } };
      },
    } as any,
    '/fixture/secret',
    () => now,
  );
  await assert.rejects(load(), { message: 'PAYMENT_SECRET_UNAVAILABLE' });
  assert.equal(await load(), 'synthetic');
  await load();
  assert.equal(calls, 2);
  now = 60000;
  await load();
  assert.equal(calls, 3);
});
test('non-SecureString and empty values fail closed', async () => {
  for (const Parameter of [
    { Type: 'String', Value: 'synthetic' },
    { Type: 'SecureString', Value: '' },
    undefined,
  ]) {
    await assert.rejects(
      secretLoader({ send: async () => ({ Parameter }) } as any, '/fixture')(),
      /PAYMENT_SECRET_UNAVAILABLE/,
    );
  }
});
test('missing webhook secret returns 503 without invoking signature/receipt implementation and later recovers', async () => {
  let available = false,
    calls = 0;
  const handler = webhookEntrypoint(
    async () => {
      if (!available) throw new Error('secret detail');
      return 'synthetic';
    },
    () => async () => {
      calls++;
      return { statusCode: 200, body: '{}' };
    },
  );
  const e = {
    routeKey: 'POST /webhooks/stripe',
    requestContext: { http: { method: 'POST' } },
  } as ApiEvent;
  const result = await handler(e);
  assert.equal(result.statusCode, 503);
  assert.equal(calls, 0);
  assert.doesNotMatch(result.body, /secret detail/);
  available = true;
  assert.equal((await handler(e)).statusCode, 200);
  assert.equal(calls, 1);
});
test('monitoring projection derives only safe financial facts, legacy V3 still parses', async () => {
  const f = await paymentFixture();
  await f.bind();
  const e = f.attempt().execution;
  const projection = monitoringProjection(e, f.cart() as any);
  assert.deepEqual(projection, {
    consecutiveReadFailures: 0,
    unknownOutcome: false,
  });
  const { PK, SK, ...work } = f.s.row('operations', e.workflow)!;
  assert.ok(workflowSchema.safeParse(work).success);
  delete work.monitoring;
  assert.ok(workflowSchema.safeParse(work).success);
});
test('age gauges include future retry work and do not expose business IDs', () => {
  const g = financialGauges(),
    now = Date.parse('2026-09-29T00:20:00.000Z');
  observeFinancial(
    g,
    {
      deadlineType: 'PAYMENT_WORKFLOW',
      deadline: '2026-09-29T00:30:00.000Z',
      monitoring: {
        unknownOutcome: true,
        committingDeadline: '2026-09-29T00:19:00.000Z',
        captureVerifiedAt: '2026-09-29T00:18:00.000Z',
        recoveryStartedAt: '2026-09-29T00:00:00.000Z',
        consecutiveReadFailures: 3,
      },
    },
    now,
  );
  assert.deepEqual(g, {
    WorkflowOverdueMs: 0,
    UnknownOutcome: 1,
    CommittingOverdue: 1,
    CapturedUnfinalizedMs: 120000,
    ConsecutiveReadFailures: 3,
    RecoveryAgeMs: 1200000,
  });
});
test('post-commit dispatch sends workflow and deadline; failures leave accepted responsibility intact', async () => {
  const f = await paymentFixture(false);
  const sent: string[] = [];
  const repo = new PaymentRepository(
    f.client,
    'catalog',
    'commerce',
    'operations',
    { fixture: 'DEVELOPMENT_ONLY_ZERO_TAX_ZERO_FEE', currency: 'usd' },
    {
      now: () => f.s.now,
      id: () => `01K5J1${String(++f.s.sequence).padStart(20, '0')}`,
    },
    f.provider,
    f.scope,
    true,
    async (m) => {
      sent.push(m.kind);
      throw new Error('lost dispatch');
    },
  );
  assert.equal((await repo.start(f.request)).status, 201);
  assert.deepEqual(sent, ['WORKFLOW', 'PAYMENT']);
  assert.equal(f.cart().status, 'PAYMENT_PENDING');
  assert.equal(
    [...f.s.rows.values()].filter(
      (r) =>
        r.deadlineType === 'PAYMENT' || r.deadlineType === 'PAYMENT_WORKFLOW',
    ).length,
    2,
  );
  await repository(f).start(f.request);
  assert.equal(sent.length, 2);
});
test('disabled admission leaves admitted customer GET and continuation operative', async () => {
  const f = await paymentFixture();
  f.provider.outcome = 'requires_action';
  await f.bind();
  await f.run();
  assert.equal((await repository(f).start(f.request)).status, 201);
  const first = await f.customer.get(f.request.cartId, f.request.tokenHash);
  assert.equal(first.payment.status, 'action_required');
  const p = f.provider.intents.get(f.attempt().execution.intentId)!;
  p.status = 'requires_confirmation';
  const result = await f.customer.confirm({
    cartId: f.request.cartId,
    tokenHash: f.request.tokenHash,
    key: f.s.keyValue(),
    ifMatch: first.etag,
    continuationGeneration: first.payment.continuationGeneration,
  });
  assert.equal(result.status, 202);
});
test('monitoring projection commits with workflow revision and rolls back with failed transition', async () => {
  const f = await paymentFixture();
  await f.bind();
  const state = (await f.workflow.load(f.message()))!;
  await f.workflow.advance(state, {
    ...state.e,
    consecutiveReadFailures: 3,
    recoveryStartedAt: new Date(f.s.now).toISOString(),
  });
  const next = f.s.row('operations', f.attempt().execution.workflow)!;
  assert.equal(next.monitoring.consecutiveReadFailures, 3);
  assert.equal(
    next.monitoring.recoveryStartedAt,
    f.attempt().execution.recoveryStartedAt,
  );
  const before = structuredClone(next);
  f.s.before = () => {
    throw new Error('transaction failure');
  };
  const current = (await f.workflow.load(f.message()))!;
  await assert.rejects(
    f.workflow.advance(current, { ...current.e, consecutiveReadFailures: 4 }),
  );
  assert.deepEqual(
    f.s.row('operations', f.attempt().execution.workflow),
    before,
  );
});

test('reconciler observes future backoff projections and withholds heartbeat on truncated monitoring', async () => {
  const { ExpiryReconciler } = await import('../src/expiry-reconciler');
  const { financialWorkMessage } = await import('../src/payment-routing');
  const f = await paymentFixture();
  await f.bind();
  const state = (await f.workflow.load(f.message()))!;
  await f.workflow.advance(
    state,
    { ...state.e, consecutiveReadFailures: 3 },
    state.a.status,
    [],
    900000,
  );
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
    { message: financialWorkMessage, send: async () => {} },
  );
  const records: any[] = [],
    original = console.info;
  console.info = (line: string) => records.push(JSON.parse(line));
  try {
    await reconciler.run();
    let metrics = records.find((r) => r.Component === 'reconciler');
    assert.equal(metrics.ConsecutiveReadFailures, 3);
    assert.equal(metrics.RecoveryHeartbeat, 1);
    records.length = 0;
    f.s.queryPageSize = 1;
    await reconciler.run();
    metrics = records.find((r) => r.Component === 'reconciler');
    assert.equal(metrics.RecoveryHeartbeat, 0);
    assert.equal(metrics.CapturedUnfinalizedMs, undefined);
  } finally {
    console.info = original;
  }
});
