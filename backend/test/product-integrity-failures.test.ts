import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import {
  ProductIntegrity,
  integrityReadyKey,
  slugKey,
  receiptKey,
  payloadHash,
} from '../src/product-integrity';
import { product } from './fixtures';
const identity = {
  subject: 'synthetic',
  key: '11111111-1111-4111-8111-111111111111',
};
const owner = {
  ...slugKey(product.slug),
  canonicalSlug: product.slug,
  productId: product.productId,
};
const receipt = {
  ...receiptKey(identity),
  subject: identity.subject,
  requestKey: identity.key,
  version: 1,
  hash: payloadHash(product),
  product,
  completedAt: product.createdAt,
};
const cancelled = (code: string, index = 0) =>
  Object.assign(new Error('synthetic transaction failure'), {
    name: 'TransactionCanceledException',
    CancellationReasons: Array.from({ length: 4 }, (_, n) => ({
      Code: n === index ? code : 'None',
    })),
  });
function client(
  send: (c: GetCommand | TransactWriteCommand) => Promise<unknown>,
) {
  return { send } as unknown as Pick<DynamoDBDocumentClient, 'send'>;
}
test('receipt arriving after reconciliation read wins over an apparent slug collision', async () => {
  let committed = false;
  let receiptReads = 0;
  const service = new ProductIntegrity(
    client(async (c) => {
      if (c instanceof TransactWriteCommand)
        throw cancelled('TransactionConflict', 2);
      const pk = c.input.Key!.PK;
      if (pk === integrityReadyKey.PK)
        return { Item: { version: 1, state: 'READY' } };
      if (pk === receipt.PK) {
        if (++receiptReads === 3) committed = true;
        return { Item: committed ? receipt : undefined };
      }
      if (pk === owner.PK) {
        committed = true;
        return { Item: owner };
      }
      return {};
    }),
    'synthetic',
  );
  assert.deepEqual(await service.create(product, identity), product);
});
test('validation cancellation must not be mislabeled as an occupied slug', async () => {
  const failure = cancelled('ValidationError', 2);
  const service = new ProductIntegrity(
    client(async (c) => {
      if (c instanceof TransactWriteCommand) throw failure;
      if (c.input.Key!.PK === integrityReadyKey.PK)
        return { Item: { version: 1, state: 'READY' } };
      if (c.input.Key!.PK === owner.PK) return { Item: owner };
      return {};
    }),
    'synthetic',
  );
  await assert.rejects(service.create(product, identity), (e) => e === failure);
});
test('transient conflict without condition failure retries and returns success', async () => {
  let attempts = 0;
  const service = new ProductIntegrity(
    client(async (c) => {
      if (c instanceof TransactWriteCommand) {
        if (++attempts === 1) throw cancelled('TransactionConflict', 2);
        return {};
      }
      return c.input.Key!.PK === integrityReadyKey.PK
        ? { Item: { version: 1, state: 'READY' } }
        : {};
    }),
    'synthetic',
  );
  assert.deepEqual(await service.create(product, identity), product);
  assert.equal(attempts, 2);
});

test('unknown timeout with an occupied slug stays ambiguous unless a receipt proves success', async () => {
  const failure = Object.assign(new Error('synthetic timeout'), {
    name: 'TimeoutError',
  });
  let attempts = 0;
  const service = new ProductIntegrity(
    client(async (c) => {
      if (c instanceof TransactWriteCommand) {
        attempts++;
        throw failure;
      }
      if (c.input.Key!.PK === integrityReadyKey.PK)
        return { Item: { version: 1, state: 'READY' } };
      if (c.input.Key!.PK === owner.PK) return { Item: owner };
      return {};
    }),
    'synthetic',
  );
  await assert.rejects(service.create(product, identity), (e) => e === failure);
  assert.equal(attempts, 3);
});
test('top-level transaction conflict retries, while malformed durable receipts fail closed', async () => {
  let attempts = 0;
  const service = new ProductIntegrity(
    client(async (c) => {
      if (c instanceof TransactWriteCommand) {
        if (++attempts === 1)
          throw Object.assign(new Error('conflict'), {
            name: 'TransactionConflictException',
          });
        return {};
      }
      return c.input.Key!.PK === integrityReadyKey.PK
        ? { Item: { version: 1, state: 'READY' } }
        : {};
    }),
    'synthetic',
  );
  assert.deepEqual(await service.create(product, identity), product);
  assert.equal(attempts, 2);
  const corrupt = new ProductIntegrity(
    client(async () => ({ Item: { ...receipt, hash: '0'.repeat(64) } })),
    'synthetic',
  );
  await assert.rejects(
    corrupt.create(product, identity),
    (e: unknown) =>
      (e as { code: string }).code === 'PRODUCT_INTEGRITY_CONFLICT',
  );
});
test('late receipt takes precedence after a confirmed slug condition failure', async () => {
  let late = false;
  const service = new ProductIntegrity(
    client(async (c) => {
      if (c instanceof TransactWriteCommand)
        throw cancelled('ConditionalCheckFailed', 2);
      if (c.input.Key!.PK === receipt.PK)
        return { Item: late ? receipt : undefined };
      if (c.input.Key!.PK === owner.PK) {
        late = true;
        return { Item: owner };
      }
      return c.input.Key!.PK === integrityReadyKey.PK
        ? { Item: { version: 1, state: 'READY' } }
        : {};
    }),
    'synthetic',
  );
  assert.deepEqual(await service.create(product, identity), product);
});
