import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { MediaRepository } from '../src/media-repository';
import {
  intentSchema,
  assetSchema,
  verifiedResultSchema,
} from '../src/media-records';
import { createIntent, mediaKeys, outputKey } from '../src/media-contract';
import { product } from './fixtures';
import { catalogKeys } from '../src/keys';
const request = {
  contentType: 'image/png',
  bytes: 1000,
  sha256: 'a'.repeat(64),
};
const id = product.productId,
  owner = 'synthetic-admin';
const reject = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: unknown) => (e as { code: string }).code === code);
function fake(
  mode:
    | 'timeout-before'
    | 'timeout-after'
    | 'throttle'
    | 'cancel-unknown'
    | 'cancel-ready'
    | 'cancel-product'
    | 'success',
) {
  const records = new Map<string, Record<string, unknown>>();
  const key = (v: Record<string, unknown>) => JSON.stringify([v.PK, v.SK]);
  records.set(key(catalogKeys.product(id)), {
    ...product,
    ...catalogKeys.product(id),
  });
  let writes = 0;
  const client = {
    send: async (c: GetCommand | TransactWriteCommand) => {
      if (c instanceof GetCommand)
        return { Item: structuredClone(records.get(key(c.input.Key!))) };
      writes++;
      if (mode === 'timeout-before')
        throw Object.assign(new Error('sensitive provider details'), {
          name: 'TimeoutError',
        });
      if (mode === 'throttle')
        throw Object.assign(new Error('sensitive provider details'), {
          name: 'ProvisionedThroughputExceededException',
        });
      if (mode.startsWith('cancel')) {
        const reasons = c.input.TransactItems!.map(() => ({ Code: 'None' }));
        if (mode === 'cancel-ready') reasons[0].Code = 'ConditionalCheckFailed';
        if (mode === 'cancel-product')
          reasons[1].Code = 'ConditionalCheckFailed';
        throw Object.assign(new Error('raw cancellation'), {
          name: 'TransactionCanceledException',
          ...(mode === 'cancel-unknown'
            ? {}
            : { CancellationReasons: reasons }),
        });
      }
      // Only used to inject lost acknowledgements; concurrency is tested on DynamoDB Local.
      for (const a of c.input.TransactItems!)
        if (a.Put) records.set(key(a.Put.Item!), structuredClone(a.Put.Item!));
      if (mode === 'timeout-after')
        throw Object.assign(new Error('lost response'), {
          name: 'TimeoutError',
        });
      return {};
    },
  } as unknown as DynamoDBDocumentClient;
  return {
    repo: new MediaRepository(client, 'synthetic', () => 1000),
    records,
    writes: () => writes,
  };
}
for (const mode of ['timeout-before', 'throttle', 'cancel-unknown'] as const)
  test(`injected ${mode} returns sanitized uncertain outcome without blind retries`, async () => {
    const s = fake(mode);
    await reject(
      s.repo.createUpload(id, owner, randomUUID(), request),
      'MEDIA_STORAGE_UNAVAILABLE',
    );
    assert.equal(s.writes(), 1);
    assert.equal(s.records.size, 1);
  });
test('injected response loss recovers the durable original intent', async () => {
  const s = fake('timeout-after'),
    key = randomUUID();
  const a = await s.repo.createUpload(id, owner, key, request);
  assert.deepEqual(await s.repo.createUpload(id, owner, key, request), a);
  assert.equal(s.writes(), 1);
});
test('injected cancellation reasons identify readiness and Product conflicts', async () => {
  await reject(
    fake('cancel-ready').repo.createUpload(id, owner, randomUUID(), request),
    'PRODUCT_WRITES_NOT_READY',
  );
  await reject(
    fake('cancel-product').repo.createUpload(id, owner, randomUUID(), request),
    'PRODUCT_CONFLICT',
  );
});
test('corrupted durable record fails closed without overwriting it', async () => {
  const s = fake('success'),
    key = randomUUID();
  const i = await s.repo.createUpload(id, owner, key, request);
  const k = JSON.stringify([mediaKeys.upload(i.uploadId).PK, 'STATE']);
  s.records.set(k, { ...s.records.get(k), state: 'READY' });
  await reject(
    s.repo.createUpload(id, owner, key, request),
    'MEDIA_RECORD_INVALID',
  );
  assert.equal(s.writes(), 1);
});
test('intent schema rejects attempt history and inconsistent ready receipt', () => {
  const i = {
    ...createIntent(id, owner, randomUUID(), id, request, 1000),
    attemptIds: [],
  };
  assert.ok(intentSchema.safeParse(i).success);
  assert.equal(intentSchema.safeParse({ ...i, attempts: 1 }).success, false);
  assert.equal(
    intentSchema.safeParse({ ...i, state: 'READY', completedAt: 1100 }).success,
    false,
  );
  assert.equal(
    intentSchema.safeParse({ ...i, arbitrary: 'value' }).success,
    false,
  );
});
test('verified metadata requires complete format pairs and exact immutable ownership', () => {
  const i = createIntent(id, owner, randomUUID(), id, request, 1000),
    attemptId = randomUUID();
  const result = {
    processingVersion: 1,
    width: 480,
    height: 480,
    variants: ['webp', 'jpeg'].map((format) => ({
      size: 480,
      format,
      width: 480,
      height: 480,
      bytes: 100,
      sha256: 'a'.repeat(64),
      key: outputKey(i, attemptId, 480, format),
    })),
  };
  assert.ok(verifiedResultSchema.safeParse(result).success);
  assert.equal(
    verifiedResultSchema.safeParse({
      ...result,
      variants: [result.variants[0]],
    }).success,
    false,
  );
  const a = {
    version: 1,
    productId: id,
    mediaId: id,
    uploadId: i.uploadId,
    revision: 1,
    state: 'READY',
    readyAt: 1000,
    attemptId,
    result,
  };
  assert.ok(assetSchema.safeParse(a).success);
  assert.equal(
    assetSchema.safeParse({
      ...a,
      result: {
        ...result,
        variants: result.variants.map((v) => ({ ...v, key: 'arbitrary/key' })),
      },
    }).success,
    false,
  );
});

test('completion rechecks deadline after delayed guard reads', async () => {
  let now = 1000;
  const attempt = randomUUID();
  const base = createIntent(id, owner, randomUUID(), id, request, now);
  const processing = intentSchema.parse({
    ...base,
    state: 'PROCESSING',
    attempts: 1,
    attemptIds: [attempt],
    leaseToken: attempt,
    leaseUntil: 2000,
  });
  let writes = 0;
  const client = {
    send: async (c: GetCommand | TransactWriteCommand) => {
      if (c instanceof TransactWriteCommand) {
        writes++;
        return {};
      }
      if (c.input.Key!.PK === catalogKeys.product(id).PK) {
        now = 2000;
        return { Item: { ...product, ...catalogKeys.product(id) } };
      }
      return { Item: { ...processing, ...mediaKeys.upload(base.uploadId) } };
    },
  } as unknown as DynamoDBDocumentClient;
  const repo = new MediaRepository(client, 'synthetic', () => now);
  const result = {
    processingVersion: 1,
    width: 480,
    height: 480,
    variants: ['webp', 'jpeg'].map((format) => ({
      size: 480,
      format,
      width: 480,
      height: 480,
      bytes: 100,
      sha256: 'b'.repeat(64),
      key: outputKey(base, attempt, 480, format),
    })),
  };
  await reject(
    repo.complete(id, owner, base.uploadId, attempt, result),
    'PROCESSING_CONFLICT',
  );
  assert.equal(writes, 0);
});
