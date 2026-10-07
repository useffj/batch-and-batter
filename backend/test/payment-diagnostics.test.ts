import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  sanitizedPaymentError,
  withPaymentDiagnostics,
  paymentDiagnostic,
} from '../src/payment-diagnostics';

test('diagnostics project only allowlisted classifications and never raw error data', () => {
  const secret =
    'ctoken_private sk_test_private pi_private_secret_private customer@example.test';
  const result = sanitizedPaymentError(
    Object.assign(new Error(secret), {
      name: 'TransactionCanceledException',
      code: secret,
      body: secret,
      response: { data: secret },
      customer: secret,
      $metadata: { requestId: 'aws-request-1', sensitive: secret },
      CancellationReasons: [
        { Code: 'ConditionalCheckFailed', Message: secret, Item: { secret } },
        { Code: secret },
      ],
    }),
  );
  assert.deepEqual(result, {
    errorClassification: 'TransactionCanceledException',
    errorCode: 'UNKNOWN',
    awsRequestId: 'aws-request-1',
    cancellationCodes: ['ConditionalCheckFailed', 'UNKNOWN'],
  });
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(
    sanitizedPaymentError({
      name: secret,
      code: secret,
      $metadata: { requestId: secret },
    }).awsRequestId,
    null,
  );
  assert.deepEqual(
    sanitizedPaymentError(
      new Proxy(
        {},
        {
          get() {
            throw new Error(secret);
          },
        },
      ),
    ),
    { errorClassification: 'UNCLASSIFIED', errorCode: 'UNKNOWN' },
  );
});

test('delivery diagnostic contexts remain isolated and logging failure cannot replace errors', async () => {
  const entries: Record<string, unknown>[] = [];
  let release!: () => void;
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  const first = withPaymentDiagnostics(
    { messageId: 'one' },
    (e) => entries.push(e),
    async () => {
      await barrier;
      paymentDiagnostic(
        'financialTransition',
        { code: 'PAYMENT_BUSY' },
        'REREAD',
      );
    },
  );
  await withPaymentDiagnostics(
    { messageId: 'two' },
    (e) => entries.push(e),
    async () => {
      paymentDiagnostic('workflowAdvance', { name: 'TimeoutError' }, 'RETHROW');
    },
  );
  release();
  await first;
  assert.deepEqual(
    entries.map((e) => e.messageId),
    ['two', 'one'],
  );
  const original = new Error('original');
  await assert.rejects(
    withPaymentDiagnostics(
      {},
      () => {
        throw new Error('logger');
      },
      async () => {
        paymentDiagnostic('workerSetup', original, 'RETHROW');
        throw original;
      },
    ),
    (e) => e === original,
  );
});
