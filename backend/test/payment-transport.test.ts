import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPaymentWorker } from '../src/payment-worker';
import { WorkflowError, type PaymentWorkflow } from '../src/payment-workflow';
import type { StripeInbox } from '../src/stripe-webhook';
import {
  paymentTransport,
  type PaymentRecord,
  type TransportLog,
} from '../src/payment-transport';
import { handler } from '../src/payment-worker-handler';
import * as runtime from '../src/payment-runtime';
import * as workerModule from '../src/payment-worker';
import * as metrics from '../src/payment-metrics';
import * as dispatchModule from '../src/payment-dispatch';

const cartId = '01M3SXJXZAKW7H5ZYH744BC04P';
const attemptId = '01M3SXVZFPYFDX112ERHP468CF';
const queue = 'arn:aws:sqs:us-east-2:123456789012:test-payment';
const context = { awsRequestId: '12345678-1234-1234-1234-123456789012' };
const record = (overrides: Partial<PaymentRecord> = {}): PaymentRecord => ({
  messageId: '43beb7e7-934b-4b39-8978-a94f2a1d1a7c',
  eventSource: 'aws:sqs',
  eventSourceARN: queue,
  attributes: { ApproximateReceiveCount: '5' },
  body: JSON.stringify({
    schemaVersion: 1,
    source: 'batch-and-batter.payment',
    kind: 'WORKFLOW',
    PK: 'CART_EXPIRY#V1#01',
    SK: `2026-09-30T19:53:50.344Z#PAYMENT_WORKFLOW#${cartId}#${attemptId}`,
    revision: 18,
  }),
  ...overrides,
});
function fixture(run: () => Promise<string>, write: TransportLog) {
  return createPaymentWorker(
    { run } as unknown as PaymentWorkflow,
    { process: run } as unknown as StripeInbox,
    queue,
    write,
  );
}
for (const outcome of [
  'STALE_WORK',
  'COMPLETED',
  'SETTLED',
  'NOT_DUE',
  'RECONCILED',
  'LEGACY_TERMINAL',
]) {
  test(`transport ${outcome} is ACK with safe per-delivery identity`, async () => {
    const logs: Record<string, unknown>[] = [];
    let calls = 0;
    const result = await fixture(
      async () => {
        calls++;
        return outcome;
      },
      (x) => logs.push(x),
    )({ Records: [record()] }, context);
    assert.deepEqual(result, { batchItemFailures: [] });
    assert.equal(calls, 1);
    const fields = {
      messageId: record().messageId,
      receiveCount: 5,
      lambdaRequestId: context.awsRequestId,
      queueArn: queue,
      workType: 'WORKFLOW',
      revision: 18,
      cartId,
      attemptId,
    };
    assert.deepEqual(logs, [
      { operation: 'paymentTransportDelivery', ...fields },
      {
        operation: 'paymentTransportDisposition',
        ...fields,
        outcome,
        disposition: 'ACK',
      },
    ]);
  });
}
for (const legacy of [false, true]) {
  test(`transport thrown ${legacy ? 'legacy' : 'unknown'} failure retains message and fixed category`, async () => {
    const logs: Record<string, unknown>[] = [];
    const error = legacy
      ? new WorkflowError('LEGACY_PAYMENT_CONTRACT')
      : new Error('SECRET_RAW_EXCEPTION');
    const result = await fixture(
      async () => {
        throw error;
      },
      (x) => logs.push(x),
    )({ Records: [record()] }, context);
    assert.deepEqual(result.batchItemFailures, [
      { itemIdentifier: record().messageId },
    ]);
    assert.equal(logs[1].disposition, 'RETRY');
    assert.equal(logs[1].outcome, legacy ? 'LEGACY_PAYMENT_CONTRACT' : 'RETRY');
    assert.ok(!JSON.stringify(logs).includes('SECRET_RAW_EXCEPTION'));
  });
}
for (const count of [
  undefined,
  '',
  '0',
  '-1',
  '1.5',
  '1e2',
  ' 2',
  '0002',
  '9007199254740992',
  'secret',
]) {
  test(`receive count ${String(count)} becomes null without processing failure`, async () => {
    const logs: Record<string, unknown>[] = [];
    const result = await fixture(
      async () => 'COMPLETED',
      (x) => logs.push(x),
    )({
      Records: [
        record({
          attributes:
            count === undefined
              ? undefined
              : { ApproximateReceiveCount: count },
        }),
      ],
    });
    assert.equal(result.batchItemFailures.length, 0);
    assert.equal(logs[0].receiveCount, null);
    assert.equal(logs[1].receiveCount, null);
    assert.equal(logs[0].lambdaRequestId, null);
  });
}
test('sensitive fields, invalid bodies and exceptions never enter transport logs', async () => {
  const secrets = [
    'ctoken_SYNTHETIC',
    'pi_synthetic_secret_SYNTHETIC',
    'rk_test_SYNTHETIC',
    'whsec_SYNTHETIC',
    'CAPABILITY_SYNTHETIC',
    'IDEMPOTENCY_SYNTHETIC',
    'fixture@example.invalid',
    '+19999999999',
    'CARD_DATA_SYNTHETIC',
    'RECEIPT_SYNTHETIC',
  ];
  const logs: Record<string, unknown>[] = [];
  const r = {
    ...record(),
    receiptHandle: secrets[9],
    messageAttributes: { secret: secrets.join(' ') },
    body: JSON.stringify({
      ...JSON.parse(record().body),
      customer: secrets.join(' '),
    }),
  };
  const result = await fixture(
    async () => {
      throw new Error(secrets.join(' '));
    },
    (x) => logs.push(x),
  )({ Records: [r] }, context);
  assert.equal(result.batchItemFailures.length, 1);
  for (const secret of secrets)
    assert.ok(!JSON.stringify(logs).includes(secret));
  assert.equal(logs[0].workType, null);
});
test('arbitrary successful outcome is normalized but remains ACK', async () => {
  const logs: Record<string, unknown>[] = [];
  const result = await fixture(
    async () => 'RAW_PROVIDER_PAYLOAD',
    (x) => logs.push(x),
  )({ Records: [record()] });
  assert.equal(result.batchItemFailures.length, 0);
  assert.equal(logs[1].outcome, 'RETURNED');
  assert.ok(!JSON.stringify(logs).includes('RAW_PROVIDER_PAYLOAD'));
});
for (const retry of [false, true])
  for (const failingStage of ['start', 'end', 'both']) {
    test(`telemetry failure at ${failingStage} preserves ${retry ? 'RETRY' : 'ACK'}`, async () => {
      let calls = 0;
      let writes = 0;
      const result = await fixture(
        async () => {
          calls++;
          if (retry) throw new Error('failure');
          return 'SETTLED';
        },
        (x) => {
          writes++;
          if (
            failingStage === 'both' ||
            (x.operation === 'paymentTransportDelivery') ===
              (failingStage === 'start')
          )
            throw new Error('logger');
        },
      )({ Records: [record()] }, context);
      assert.equal(calls, 1);
      assert.equal(writes, 2);
      assert.deepEqual(
        result.batchItemFailures,
        retry ? [{ itemIdentifier: record().messageId }] : [],
      );
    });
  }
test('mixed batch keeps correlation and dispositions separate', async () => {
  const logs: Record<string, unknown>[] = [];
  const records = [
    record({ messageId: 'first' }),
    record({
      messageId: 'second',
      attributes: { ApproximateReceiveCount: '2' },
    }),
  ];
  const result = await paymentTransport(
    { Records: records },
    context,
    async (r) => {
      if (r.messageId === 'second') throw new Error('retry');
      return 'STALE_WORK';
    },
    (x) => logs.push(x),
  );
  assert.deepEqual(result.batchItemFailures, [{ itemIdentifier: 'second' }]);
  assert.deepEqual(
    logs.map((x) => [x.messageId, x.receiveCount, x.disposition]),
    [
      ['first', 5, undefined],
      ['first', 5, 'ACK'],
      ['second', 2, undefined],
      ['second', 2, 'RETRY'],
    ],
  );
});
test('PAYMENT and STRIPE_EVENT metadata never invent absent Attempt identity', async () => {
  for (const kind of ['PAYMENT', 'STRIPE_EVENT']) {
    const logs: Record<string, unknown>[] = [];
    const body = {
      ...JSON.parse(record().body),
      kind,
      SK:
        kind === 'PAYMENT'
          ? `2026-09-30T19:53:50.344Z#PAYMENT#${cartId}`
          : '2026-09-30T19:53:50.344Z#STRIPE_EVENT#evt_SYNTHETIC',
    };
    await fixture(
      async () => 'COMPLETED',
      (x) => logs.push(x),
    )({ Records: [record({ body: JSON.stringify(body) })] });
    assert.equal(logs[0].attemptId, null);
    assert.equal(logs[0].cartId, kind === 'PAYMENT' ? cartId : null);
    assert.ok(!JSON.stringify(logs).includes('evt_SYNTHETIC'));
  }
});
test('handler initialization failure logs final RETRY for every record', async (t) => {
  const logs: string[] = [];
  t.mock.method(runtime, 'paymentScope', () => {
    throw new Error('RAW_SETUP_SECRET');
  });
  t.mock.method(console, 'info', (x: unknown) => logs.push(String(x)));
  const result = await handler({ Records: [record()] }, context);
  assert.deepEqual(result.batchItemFailures, [
    { itemIdentifier: record().messageId },
  ]);
  const transport = logs.map((x) => JSON.parse(x)).filter((x) => x.operation);
  assert.equal(transport.length, 2);
  assert.equal(transport[1].disposition, 'RETRY');
  assert.equal(transport[1].lambdaRequestId, context.awsRequestId);
  assert.ok(!logs.join('').includes('RAW_SETUP_SECRET'));
});
test('handler setup failure survives failing metrics and log sink', async (t) => {
  t.mock.method(runtime, 'paymentScope', () => {
    throw new Error('setup');
  });
  t.mock.method(console, 'info', () => {
    throw new Error('logger');
  });
  const result = await handler({ Records: [record()] }, context);
  assert.deepEqual(result.batchItemFailures, [
    { itemIdentifier: record().messageId },
  ]);
});
test('post-processing metrics failure cannot turn handler ACK into RETRY', async (t) => {
  t.mock.method(runtime, 'paymentScope', () => 'dev:acct_SYNTHETIC');
  t.mock.method(runtime, 'paymentClient', () => ({}));
  t.mock.method(dispatchModule, 'paymentDispatch', () => async () => {});
  t.mock.method(workerModule, 'createPaymentWorker', () => async () => ({
    batchItemFailures: [],
  }));
  t.mock.method(metrics, 'paymentMetrics', () => {
    throw new Error('metrics');
  });
  assert.deepEqual(await handler({ Records: [record()] }, context), {
    batchItemFailures: [],
  });
});
