import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import sharp from 'sharp';
const require = createRequire(import.meta.url);
// Test-only exports are outside out/host and out/linux deployment directories.
await build({
  stdin: {
    contents: `export * from './src/handler'; export {S3MediaStorage} from '../backend/src/media-storage'; export {MediaConflict,createIntent,claimIntent,finishIntent} from '../backend/src/media-contract';`,
    resolveDir: process.cwd(),
  },
  outfile: 'out/test-support.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['sharp'],
});
const {
  createProcessor,
  configuration,
  S3MediaStorage,
  MediaConflict,
  createIntent,
  claimIntent,
  finishIntent,
} = require('../out/test-support.cjs');
const packaged = require('../out/host/index.cjs');
const productId = '01K00000000000000000000001';
const owner = 'synthetic-admin';
const cfg = {
  enabled: true,
  region: 'us-east-2',
  bucket: 'batch-and-batter-dev-product-media-302154194958-us-east-2',
  processorArn:
    'arn:aws:lambda:us-east-2:302154194958:function:batch-and-batter-dev-media-processor',
};
async function setup(options = {}) {
  const bytes = await sharp({
    create: { width: 640, height: 480, channels: 3, background: 'brown' },
  })
    .png()
    .toBuffer();
  const request = {
    contentType: 'image/png',
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  let now = Date.now();
  let intent = {
    ...createIntent(
      productId,
      owner,
      '11111111-1111-4111-8111-111111111111',
      productId,
      request,
      now,
    ),
    state: 'QUEUED',
    attemptIds: [],
  };
  const writes = [];
  let completes = 0,
    failed = 0,
    claims = 0;
  const repo = {
    async claim(p, s, u, a) {
      claims++;
      assert.equal(p, productId);
      assert.equal(s, owner);
      assert.equal(u, intent.uploadId);
      if (options.claimError) throw new MediaConflict(options.claimError);
      if (intent.state === 'READY') return structuredClone(intent);
      intent = {
        ...claimIntent(intent, a, now),
        attemptIds: [...intent.attemptIds, a],
      };
      return structuredClone(intent);
    },
    async complete(p, s, u, a, result) {
      if (options.superseded)
        intent.leaseToken = '22222222-2222-4222-8222-222222222222';
      intent = { ...finishIntent(intent, a, now, true), result };
      completes++;
    },
    async failProcessing(p, s, u, a, code) {
      assert.equal(code, 'INVALID_MEDIA');
      intent = finishIntent(intent, a, now, false);
      failed++;
    },
  };
  const client = {
    send: async (command) => {
      const x = command.input;
      assert.equal(x.Bucket, cfg.bucket);
      if (!('Body' in x)) {
        assert.equal(
          x.Key,
          `staging/products/${productId}/${intent.uploadId}/source`,
        );
        if (options.missing) throw Error('NoSuchKey secret');
        return {
          ContentLength: options.oversized ? 9 * 1024 * 1024 : bytes.length,
          Body: Readable.from([
            options.corrupt ? Buffer.alloc(bytes.length) : bytes,
            ...(options.streamOverflow ? [Buffer.alloc(1)] : []),
          ]),
        };
      }
      assert.equal(x.IfNoneMatch, '*');
      assert.equal(x.ServerSideEncryption, 'AES256');
      assert.equal(x.ACL, undefined);
      assert.match(
        x.Key,
        new RegExp(`^approved/products/${productId}/${productId}/`),
      );
      if (options.collision || (options.partial && writes.length === 1))
        throw Error('S3 secret failure');
      writes.push(x);
      return {};
    },
  };
  const worker = createProcessor(repo, new S3MediaStorage(client, cfg));
  const event = {
    version: 1,
    productId,
    subject: owner,
    uploadId: intent.uploadId,
  };
  return {
    worker,
    event,
    writes,
    bytes,
    repo,
    get intent() {
      return intent;
    },
    get completes() {
      return completes;
    },
    get failed() {
      return failed;
    },
    get claims() {
      return claims;
    },
    advance() {
      now += 61000;
    },
    badImage() {
      request.sha256 = createHash('sha256')
        .update(Buffer.alloc(bytes.length))
        .digest('hex');
      intent.request = { ...request };
    },
  };
}
test('packaged handler export and fail-closed missing/configured destinations', async () => {
  assert.equal(typeof packaged.handler, 'function');
  assert.throws(() => configuration({}), /CONFIGURATION_INVALID/);
  for (const patch of [
    { AWS_REGION: 'us-west-2' },
    { MEDIA_BUCKET_NAME: 'foreign' },
    { CATALOG_TABLE_NAME: 'payments' },
  ])
    assert.throws(() =>
      configuration({
        AWS_REGION: cfg.region,
        MEDIA_BUCKET_NAME: cfg.bucket,
        CATALOG_TABLE_NAME: 'batch-and-batter-dev-catalog',
        ...patch,
      }),
    );
  await assert.rejects(packaged.handler({}), /CONFIGURATION_INVALID/);
});
test('strict event rejects HTTP, arbitrary keys, result claims and malformed identity before reads', async () => {
  const s = await setup();
  for (const event of [
    {},
    { ...s.event, version: 2 },
    { ...s.event, productId: 'bad' },
    { ...s.event, bucket: 'foreign' },
    { ...s.event, key: 'private' },
    { ...s.event, result: {} },
    { ...s.event, requestContext: {} },
  ])
    await assert.rejects(s.worker(event), /^Error: MEDIA_PROCESSOR_FAILED$/);
  assert.equal(s.claims, 0);
});
test('valid runtime writes sequential private variants, durable READY, no gallery/payment methods', async () => {
  const s = await setup();
  assert.deepEqual(await s.worker(s.event), { state: 'READY' });
  assert.equal(s.completes, 1);
  assert.equal(s.writes.length, 4);
  for (const w of s.writes) {
    const m = await sharp(w.Body).metadata();
    assert.ok(['jpeg', 'webp'].includes(m.format));
    assert.equal(m.exif, undefined);
    assert.equal(m.icc, undefined);
    assert.equal(
      w.ChecksumSHA256,
      createHash('sha256').update(w.Body).digest('base64'),
    );
  }
  const original = s.intent.result;
  assert.deepEqual(await s.worker(s.event), { state: 'READY' });
  assert.deepEqual(s.intent.result, original);
  assert.equal(s.writes.length, 4);
  assert.equal(s.completes, 1);
});
for (const [label, options] of [
  ['missing staging', { missing: true }],
  ['conditional collision', { collision: true }],
  ['partial write', { partial: true }],
  ['superseded lease', { superseded: true }],
  ['database unavailable', { claimError: 'MEDIA_STORAGE_UNAVAILABLE' }],
  ['missing intent', { claimError: 'UPLOAD_NOT_FOUND' }],
])
  test(label + ' never reports successful READY', async () => {
    const s = await setup(options);
    await assert.rejects(s.worker(s.event), /^Error: MEDIA_PROCESSOR_FAILED$/);
    assert.equal(s.completes, 0);
    assert.equal(s.failed, 0);
    if (options.partial) assert.equal(s.writes.length, 1);
  });
for (const [label, options] of [
  ['oversized header', { oversized: true }],
  ['bounded stream overflow', { streamOverflow: true }],
  ['wrong checksum', { corrupt: true }],
])
  test(label + ' is terminal invalid media', async () => {
    const s = await setup(options);
    assert.deepEqual(await s.worker(s.event), { state: 'FAILED' });
    assert.equal(s.failed, 1);
    assert.equal(s.writes.length, 0);
  });
test('invalid image with matching checksum fails terminally', async () => {
  const s = await setup({ corrupt: true });
  s.badImage();
  assert.deepEqual(await s.worker(s.event), { state: 'FAILED' });
  assert.equal(s.writes.length, 0);
});
test('expired deliveries are ignored without S3 writes', async () => {
  const s = await setup({ claimError: 'UPLOAD_EXPIRED' });
  assert.deepEqual(await s.worker(s.event), { state: 'IGNORED' });
  assert.equal(s.writes.length, 0);
});
test('concurrent duplicate deliveries process once', async () => {
  const s = await setup();
  const r = await Promise.all([s.worker(s.event), s.worker(s.event)]);
  assert.deepEqual(r.map((x) => x.state).sort(), ['IGNORED', 'READY']);
  assert.equal(s.completes, 1);
});
test('retryable infrastructure failure retains lease then recovers using a new attempt', async () => {
  const options = { partial: true };
  const s = await setup(options);
  await assert.rejects(s.worker(s.event));
  const old = s.intent.leaseToken;
  assert.equal(s.intent.state, 'PROCESSING');
  options.partial = false;
  s.advance();
  assert.deepEqual(await s.worker(s.event), { state: 'READY' });
  assert.notEqual(s.intent.leaseToken, old);
  assert.equal(s.completes, 1);
});
