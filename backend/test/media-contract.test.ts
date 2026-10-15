import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MEDIA,
  mediaKeys,
  createIntent,
  replayIntent,
  queueIntent,
  claimIntent,
  finishIntent,
  expireIntent,
  stagingKey,
  outputKey,
  planManifest,
  deletionEligible,
  fenceDeletion,
  compactReceipt,
  manifestRequestSchema,
  uploadRequestSchema,
  type Asset,
} from '../src/media-contract';
const productId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const mediaId = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const other = '01ARZ3NDEKTSV4RRFFQ69G5FAX';
const key = '11111111-1111-4111-8111-111111111111';
const attempt = '22222222-2222-4222-8222-222222222222';
const second = '33333333-3333-4333-8333-333333333333';
const request = {
  contentType: 'image/png',
  bytes: 1000,
  sha256: 'a'.repeat(64),
};
const intent = () =>
  createIntent(productId, 'admin', key, mediaId, request, 1000);
const asset = (): Asset => ({
  productId,
  mediaId,
  revision: 1,
  state: 'READY',
  readyAt: 1000,
});
test('media keys cannot enter Product META namespace or accept path injection', () => {
  for (const k of [
    mediaKeys.manifest(productId),
    mediaKeys.asset(productId, mediaId),
    mediaKeys.upload(intent().uploadId),
  ]) {
    assert.equal(k.PK.startsWith('PRODUCT#'), false);
    assert.notEqual(k.SK, 'META');
  }
  assert.throws(() => mediaKeys.manifest('../escape'));
  assert.throws(() => mediaKeys.upload('../escape'));
});
test('upload identity scopes administrator and Product, replay preserves original media and expiry', () => {
  const original = intent();
  const retry = createIntent(productId, 'admin', key, other, request, 2000);
  assert.deepEqual(replayIntent(original, retry), original);
  assert.notEqual(
    createIntent(other, 'admin', key, mediaId, request, 1000).uploadId,
    original.uploadId,
  );
  assert.notEqual(
    createIntent(productId, 'another-admin', key, mediaId, request, 1000)
      .uploadId,
    original.uploadId,
  );
  assert.throws(
    () =>
      replayIntent(
        original,
        createIntent(
          productId,
          'admin',
          key,
          mediaId,
          { ...request, bytes: 999 },
          1000,
        ),
      ),
    /IDEMPOTENCY_CONFLICT/,
  );
});
test('bounded strict upload schema rejects destinations, MIME, size and checksum errors', () => {
  for (const raw of [
    { ...request, key: 'arbitrary' },
    { ...request, bytes: MEDIA.maxInputBytes + 1 },
    { ...request, bytes: 0 },
    { ...request, contentType: 'image/svg+xml' },
    { ...request, sha256: 'invalid' },
  ])
    assert.equal(uploadRequestSchema.safeParse(raw).success, false);
});
test('completion identity, expiry and terminal failures fail closed', () => {
  const i = intent();
  assert.throws(() => queueIntent(i, other, 'admin', 1100), /UPLOAD_NOT_FOUND/);
  assert.throws(
    () => queueIntent(i, productId, 'other-admin', 1100),
    /UPLOAD_NOT_FOUND/,
  );
  assert.throws(
    () => queueIntent(i, productId, 'admin', i.expiresAt),
    /UPLOAD_EXPIRED/,
  );
  assert.throws(
    () => queueIntent({ ...i, state: 'FAILED' }, productId, 'admin', 1100),
    /UPLOAD_FAILED/,
  );
});
test('completion is replayable and cannot restart successful processing', () => {
  const queued = queueIntent(intent(), productId, 'admin', 1100);
  assert.deepEqual(queueIntent(queued, productId, 'admin', 1200), queued);
  const ready = finishIntent(
    claimIntent(queued, attempt, 1300),
    attempt,
    1400,
    true,
  );
  assert.deepEqual(
    queueIntent(ready, productId, 'admin', ready.expiresAt + 1),
    ready,
  );
  assert.throws(() => claimIntent(ready, second, 1500), /PROCESSING_CONFLICT/);
});
test('active leases reject duplicate delivery; interrupted attempts recover with a new lease', () => {
  const processing = claimIntent(
    queueIntent(intent(), productId, 'admin', 1100),
    attempt,
    1200,
  );
  assert.throws(
    () => claimIntent(processing, second, 1300),
    /PROCESSING_CONFLICT/,
  );
  const recovered = claimIntent(processing, second, processing.leaseUntil!);
  assert.equal(recovered.attempts, 2);
  assert.throws(
    () => finishIntent(recovered, attempt, recovered.leaseUntil! - 1, true),
    /PROCESSING_CONFLICT/,
  );
  assert.throws(
    () => finishIntent(recovered, second, recovered.leaseUntil!, true),
    /PROCESSING_CONFLICT/,
  );
  assert.throws(
    () =>
      claimIntent(
        { ...recovered, attempts: 3 },
        attempt,
        recovered.leaseUntil!,
      ),
    /ATTEMPTS_EXHAUSTED/,
  );
});
test('immutable output namespace separates attempts and rejects arbitrary variants', () => {
  assert.equal(
    stagingKey(intent()),
    `staging/products/${productId}/${intent().uploadId}/source`,
  );
  assert.notEqual(
    outputKey(intent(), attempt, 480, 'webp'),
    outputKey(intent(), second, 480, 'webp'),
  );
  assert.throws(() => outputKey(intent(), attempt, 123, 'webp'));
  assert.throws(() => outputKey(intent(), attempt, 480, '../source'));
});
test('manifest validation enforces unique count, alt and strict fields', () => {
  const image = { mediaId, alt: 'Cookie' };
  for (const images of [
    [image, image],
    [{ ...image, alt: ' ' }],
    [{ ...image, alt: 'a'.repeat(161) }],
    Array(7).fill(image),
  ])
    assert.equal(
      manifestRequestSchema.safeParse({ expectedRevision: 0, images }).success,
      false,
    );
  assert.equal(
    manifestRequestSchema.safeParse({
      expectedRevision: 0,
      images: [image],
      url: 'external',
    }).success,
    false,
  );
});
test('manifest preserves ordering, first-primary semantics and does not mutate input records', () => {
  const a = asset(),
    b = { ...asset(), mediaId: other };
  const before = structuredClone([a, b]);
  const plan = planManifest(
    productId,
    undefined,
    {
      expectedRevision: 0,
      images: [
        { mediaId: other, alt: 'First' },
        { mediaId, alt: 'Second' },
      ],
    },
    [a, b],
    2000,
    true,
    true,
  );
  assert.equal(plan.manifest.images[0].mediaId, other);
  assert.equal(
    plan.assets.every((a) => a.state === 'ATTACHED'),
    true,
  );
  assert.deepEqual([a, b], before);
  assert.deepEqual(Object.keys(plan).sort(), ['assets', 'manifest']);
});
test('manifest refuses revision conflicts, cross-Product attachment, absent Product and readiness', () => {
  const input = { expectedRevision: 0, images: [{ mediaId, alt: 'Cookie' }] };
  assert.throws(
    () =>
      planManifest(
        productId,
        { productId, revision: 1, images: [] },
        input,
        [asset()],
        2000,
        true,
        true,
      ),
    /MEDIA_REVISION_CONFLICT/,
  );
  assert.throws(
    () =>
      planManifest(
        productId,
        undefined,
        input,
        [{ ...asset(), productId: other }],
        2000,
        true,
        true,
      ),
    /ASSET_NOT_FOUND/,
  );
  for (const [exists, ready] of [
    [false, true],
    [true, false],
  ])
    assert.throws(
      () =>
        planManifest(
          productId,
          undefined,
          input,
          [asset()],
          2000,
          exists,
          ready,
        ),
      /CATALOG_NOT_READY/,
    );
});
test('removal retires rather than deletes, and retired/deleting media cannot attach', () => {
  const current = {
    productId,
    revision: 1,
    images: [{ mediaId, alt: 'Cookie' }],
  };
  const plan = planManifest(
    productId,
    current,
    { expectedRevision: 1, images: [] },
    [{ ...asset(), state: 'ATTACHED' }],
    2000,
    true,
    true,
  );
  assert.equal(plan.assets[0].state, 'RETIRED');
  for (const state of ['RETIRED', 'DELETING', 'DELETED'] as const)
    assert.throws(
      () =>
        planManifest(
          productId,
          undefined,
          { expectedRevision: 0, images: current.images },
          [{ ...asset(), state }],
          2000,
          true,
          true,
        ),
      /ASSET_STATE_CONFLICT/,
    );
});
test('cleanup eligibility respects grace and references; fencing prevents attachment', () => {
  const a = asset(),
    now = a.readyAt + MEDIA.graceMs;
  assert.equal(deletionEligible(a, false, now - 1), false);
  assert.equal(deletionEligible(a, true, now), false);
  assert.equal(
    deletionEligible({ ...a, state: 'ATTACHED' }, false, now),
    false,
  );
  assert.equal(deletionEligible({ ...a, state: 'RETIRED' }, false, now), false);
  assert.equal(fenceDeletion(a, false, now).state, 'DELETING');
  assert.throws(() => fenceDeletion(a, true, now));
});
test('receipt compaction retains duplicate identity only after terminal retention', () => {
  const ready = finishIntent(
    claimIntent(queueIntent(intent(), productId, 'admin', 1100), attempt, 1200),
    attempt,
    1300,
    true,
  );
  assert.throws(() => compactReceipt(ready, 1300 + MEDIA.receiptMs - 1));
  const tombstone = compactReceipt(ready, 1300 + MEDIA.receiptMs);
  assert.equal(tombstone.uploadId, ready.uploadId);
  assert.equal(tombstone.requestHash, ready.requestHash);
  assert.equal(tombstone.state, 'TOMBSTONE');
  assert.throws(() => compactReceipt(intent(), 1300 + MEDIA.receiptMs));
});
test('expiry fences pending processing and preserves successful receipts', () => {
  const i = intent();
  assert.throws(() => expireIntent(i, i.expiresAt - 1), /UPLOAD_NOT_EXPIRED/);
  const expired = expireIntent(i, i.expiresAt);
  assert.equal(expired.state, 'EXPIRED');
  assert.throws(
    () => claimIntent(expired, attempt, i.expiresAt),
    /UPLOAD_EXPIRED/,
  );
  assert.equal(
    compactReceipt(expired, i.expiresAt + MEDIA.receiptMs).state,
    'TOMBSTONE',
  );
  const ready = { ...i, state: 'READY' as const, completedAt: 1300 };
  assert.deepEqual(expireIntent(ready, i.expiresAt), ready);
});
