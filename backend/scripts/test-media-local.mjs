// Loopback-only synthetic integration. Never uses SSO or ambient credentials.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
const sharp = createRequire(
  new URL('../../media-processor/package.json', import.meta.url),
)('sharp');
import { processImage } from '../../media-processor/src/process-image.mjs';
const require = createRequire(import.meta.url);
const {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
} = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  ScanCommand,
  DeleteCommand,
  TransactWriteCommand,
} = require('@aws-sdk/lib-dynamodb');
const { processMedia } = require('../dist/src/media-orchestration');
const { MediaRepository } = require('../dist/src/media-repository');
const { mediaKeys, outputKey, MEDIA } = require('../dist/src/media-contract');
const { integrityReadyKey, slugKey } = require('../dist/src/product-integrity');
const { catalogKeys } = require('../dist/src/keys');
const { generateUlid } = require('../dist/src/ulid');
const { DynamoCatalogRepository } = require('../dist/src/repository');
const { product } = require('../dist/test/fixtures');
const raw = new DynamoDBClient({
  endpoint: 'http://127.0.0.1:18765',
  region: 'us-east-2',
  credentials: { accessKeyId: 'LOCALONLY', secretAccessKey: 'LOCALONLY' },
  maxAttempts: 1,
});
raw.middlewareStack.add(
  (next) => async (args) => {
    assert.equal(args.request.hostname, '127.0.0.1');
    assert.equal(args.request.port, 18765);
    assert.equal(args.request.protocol, 'http:');
    return next(args);
  },
  { step: 'finalizeRequest', name: 'loopbackOnly', priority: 'high' },
);
const client = DynamoDBDocumentClient.from(raw),
  tables = [];
const owner = 'synthetic-admin',
  request = { contentType: 'image/png', bytes: 1000, sha256: 'a'.repeat(64) };
const rejected = (p, code) => assert.rejects(p, (e) => e.code === code);
let passed = 0;
const get = async (s, k) =>
  (
    await client.send(
      new GetCommand({ TableName: s.table, Key: k, ConsistentRead: true }),
    )
  ).Item;
const put = (s, item) =>
  client.send(new PutCommand({ TableName: s.table, Item: item }));
async function setup() {
  const table = 'bb-local-media-' + randomUUID();
  await raw.send(
    new CreateTableCommand({
      TableName: table,
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  );
  tables.push(table);
  let now = 100000;
  const s = { table, clock: () => now, advance: (n) => (now += n) };
  s.repo = new MediaRepository(client, table, s.clock);
  await put(s, { ...product, ...catalogKeys.product(product.productId) });
  await put(s, {
    ...slugKey(product.slug),
    canonicalSlug: product.slug,
    productId: product.productId,
  });
  await put(s, { ...integrityReadyKey, version: 1, state: 'READY' });
  return s;
}
const create = (s) =>
  s.repo.createUpload(product.productId, owner, randomUUID(), request);
const result = (i, a) => ({
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
    key: outputKey(i, a, 480, format),
  })),
});
async function processing(s) {
  const i = await create(s);
  await s.repo.queue(product.productId, owner, i.uploadId);
  const a = randomUUID();
  return { i: await s.repo.claim(product.productId, owner, i.uploadId, a), a };
}
async function ready(s) {
  const { i, a } = await processing(s);
  return (
    await s.repo.complete(product.productId, owner, i.uploadId, a, result(i, a))
  ).result;
}
const replace = (s, revision, assets) =>
  s.repo.replaceManifest(product.productId, {
    expectedRevision: revision,
    images: assets.map((a) => ({
      mediaId: a.mediaId,
      alt: 'Synthetic cookie',
    })),
  });
async function check(name, fn) {
  const s = await setup();
  await fn(s);
  passed++;
  console.log('PASS ' + name);
}
// Pause only completion transactions after repository eligibility checks. The
// actual conditional transaction still executes against loopback DynamoDB Local.
function delayedCompletion(s) {
  let entered, release;
  const submitted = new Promise((resolve) => (entered = resolve));
  const gate = new Promise((resolve) => (release = resolve));
  const delayed = {
    send: async (command) => {
      if (command instanceof TransactWriteCommand) {
        entered();
        await gate;
      }
      return client.send(command);
    },
  };
  return {
    repo: new MediaRepository(delayed, s.table, s.clock),
    submitted,
    release: () => release(),
  };
}
try {
  await check('initial manifest creation and stale revisions', async (s) => {
    assert.equal((await replace(s, 0, [])).revision, 1);
    await rejected(replace(s, 0, []), 'MEDIA_REVISION_CONFLICT');
    assert.equal((await replace(s, 1, [])).revision, 2);
  });
  await check(
    'concurrent manifest edits have exactly one winner',
    async (s) => {
      await replace(s, 0, []);
      const outcomes = await Promise.allSettled([
        replace(s, 1, []),
        replace(s, 1, []),
      ]);
      assert.equal(outcomes.filter((x) => x.status === 'fulfilled').length, 1);
      assert.equal((await s.repo.manifest(product.productId)).revision, 2);
    },
  );
  await check('READY attachment and ordered primary selection', async (s) => {
    const a = await ready(s),
      b = await ready(s);
    await replace(s, 0, [a, b]);
    const changed = await replace(s, 1, [b, a]);
    assert.equal(changed.images[0].mediaId, b.mediaId);
    assert.equal(
      (await s.repo.asset(product.productId, a.mediaId)).state,
      'ATTACHED',
    );
  });
  await check('alt edits preserve asset revision and ownership', async (s) => {
    const a = await ready(s);
    await replace(s, 0, [a]);
    const before = await s.repo.asset(product.productId, a.mediaId);
    await s.repo.replaceManifest(product.productId, {
      expectedRevision: 1,
      images: [{ mediaId: a.mediaId, alt: 'Updated alternative' }],
    });
    assert.deepEqual(await s.repo.asset(product.productId, a.mediaId), before);
  });
  await check('cross-Product attachment rejected', async (s) => {
    await rejected(
      replace(s, 0, [{ mediaId: generateUlid() }]),
      'ASSET_NOT_FOUND',
    );
  });
  await check('six unique images and bounded alt text', async (s) => {
    const id = generateUlid();
    for (const images of [
      Array.from({ length: 7 }, () => ({ mediaId: generateUlid(), alt: 'x' })),
      [
        { mediaId: id, alt: 'x' },
        { mediaId: id, alt: 'x' },
      ],
      [{ mediaId: id, alt: ' ' }],
      [{ mediaId: id, alt: 'x'.repeat(161) }],
    ])
      await assert.rejects(
        s.repo.replaceManifest(product.productId, {
          expectedRevision: 0,
          images,
        }),
      );
    assert.equal(await s.repo.manifest(product.productId), undefined);
  });
  await check(
    'replacement atomically retires old and attaches new',
    async (s) => {
      const a = await ready(s),
        b = await ready(s);
      await replace(s, 0, [a]);
      await replace(s, 1, [b]);
      assert.equal(
        (await s.repo.asset(product.productId, a.mediaId)).state,
        'RETIRED',
      );
      assert.equal(
        (await s.repo.asset(product.productId, b.mediaId)).state,
        'ATTACHED',
      );
      await rejected(replace(s, 2, [a]), 'ASSET_STATE_CONFLICT');
    },
  );
  await check(
    'identical concurrent intent replay uses one original identity',
    async (s) => {
      const key = randomUUID(),
        out = await Promise.all([
          s.repo.createUpload(product.productId, owner, key, request),
          s.repo.createUpload(product.productId, owner, key, request),
        ]);
      assert.deepEqual(out[0], out[1]);
    },
  );
  await check('hash conflict and administrator isolation', async (s) => {
    const key = randomUUID(),
      i = await s.repo.createUpload(product.productId, owner, key, request);
    await rejected(
      s.repo.createUpload(product.productId, owner, key, {
        ...request,
        bytes: 999,
      }),
      'IDEMPOTENCY_CONFLICT',
    );
    await rejected(
      s.repo.upload(product.productId, 'other', i.uploadId),
      'UPLOAD_NOT_FOUND',
    );
  });
  await check('expired upload never renews and persists EXPIRED', async (s) => {
    const key = randomUUID(),
      i = await s.repo.createUpload(product.productId, owner, key, request);
    s.advance(MEDIA.completionMs);
    await rejected(
      s.repo.createUpload(product.productId, owner, key, request),
      'UPLOAD_EXPIRED',
    );
    assert.equal(
      (await s.repo.expire(product.productId, owner, i.uploadId)).state,
      'EXPIRED',
    );
    await rejected(
      s.repo.queue(product.productId, owner, i.uploadId),
      'UPLOAD_EXPIRED',
    );
  });
  await check('concurrent processors cannot both acquire leases', async (s) => {
    const i = await create(s);
    await s.repo.queue(product.productId, owner, i.uploadId);
    const out = await Promise.allSettled([
      s.repo.claim(product.productId, owner, i.uploadId, randomUUID()),
      s.repo.claim(product.productId, owner, i.uploadId, randomUUID()),
    ]);
    assert.equal(out.filter((x) => x.status === 'fulfilled').length, 1);
  });
  await check('expired lease recovery fences stale processor', async (s) => {
    const { i, a } = await processing(s);
    s.advance(MEDIA.leaseMs);
    const b = randomUUID();
    await s.repo.claim(product.productId, owner, i.uploadId, b);
    await rejected(
      s.repo.complete(product.productId, owner, i.uploadId, a, result(i, a)),
      'PROCESSING_CONFLICT',
    );
    await s.repo.complete(
      product.productId,
      owner,
      i.uploadId,
      b,
      result(i, b),
    );
  });
  await check(
    'duplicate successful delivery replays original result',
    async (s) => {
      const { i, a } = await processing(s),
        first = await s.repo.complete(
          product.productId,
          owner,
          i.uploadId,
          a,
          result(i, a),
        );
      assert.deepEqual(
        await s.repo.complete(
          product.productId,
          owner,
          i.uploadId,
          a,
          result(i, a),
        ),
        first,
      );
      assert.equal(
        (await s.repo.claim(product.productId, owner, i.uploadId, randomUUID()))
          .state,
        'READY',
      );
    },
  );
  await check('failed invalid-media processing is terminal', async (s) => {
    const { i, a } = await processing(s);
    await s.repo.failProcessing(
      product.productId,
      owner,
      i.uploadId,
      a,
      'INVALID_MEDIA',
    );
    await rejected(
      s.repo.complete(product.productId, owner, i.uploadId, a, result(i, a)),
      'PROCESSING_CONFLICT',
    );
    assert.equal(await s.repo.asset(product.productId, i.mediaId), undefined);
  });
  await check(
    'compaction preserves identity and rejects resurrection',
    async (s) => {
      const key = randomUUID(),
        i = await s.repo.createUpload(product.productId, owner, key, request);
      await s.repo.queue(product.productId, owner, i.uploadId);
      const a = randomUUID();
      await s.repo.claim(product.productId, owner, i.uploadId, a);
      await s.repo.complete(
        product.productId,
        owner,
        i.uploadId,
        a,
        result(i, a),
      );
      s.advance(MEDIA.receiptMs);
      assert.equal(
        (await s.repo.compact(product.productId, owner, i.uploadId)).state,
        'TOMBSTONE',
      );
      await rejected(
        s.repo.createUpload(product.productId, owner, key, request),
        'UPLOAD_RESULT_EXPIRED',
      );
      await rejected(
        s.repo.createUpload(product.productId, owner, key, {
          ...request,
          bytes: 999,
        }),
        'IDEMPOTENCY_CONFLICT',
      );
    },
  );
  await check(
    'readiness missing blocks every initial business write',
    async (s) => {
      await client.send(
        new DeleteCommand({ TableName: s.table, Key: integrityReadyKey }),
      );
      await rejected(create(s), 'PRODUCT_WRITES_NOT_READY');
      await rejected(replace(s, 0, []), 'PRODUCT_WRITES_NOT_READY');
      assert.equal(await s.repo.manifest(product.productId), undefined);
    },
  );
  await check('missing Product or slug ownership fails closed', async (s) => {
    await client.send(
      new DeleteCommand({ TableName: s.table, Key: slugKey(product.slug) }),
    );
    await rejected(create(s), 'PRODUCT_INTEGRITY_CONFLICT');
    await client.send(
      new DeleteCommand({
        TableName: s.table,
        Key: catalogKeys.product(product.productId),
      }),
    );
    await rejected(create(s), 'PRODUCT_NOT_FOUND');
  });
  await check(
    'transaction rollback when asset changes after read',
    async (s) => {
      const a = await ready(s),
        b = await ready(s);
      await replace(s, 0, [a]);
      const before = await s.repo.manifest(product.productId);
      let inject = true;
      const wrapped = {
        send: async (c) => {
          if (c instanceof TransactWriteCommand && inject) {
            inject = false;
            const v = await get(
              s,
              mediaKeys.asset(product.productId, b.mediaId),
            );
            await put(s, { ...v, revision: v.revision + 1, state: 'DELETING' });
          }
          return client.send(c);
        },
      };
      const repo = new MediaRepository(wrapped, s.table, s.clock);
      await assert.rejects(
        repo.replaceManifest(product.productId, {
          expectedRevision: 1,
          images: [{ mediaId: b.mediaId, alt: 'x' }],
        }),
      );
      assert.deepEqual(await s.repo.manifest(product.productId), before);
      assert.equal(
        (await s.repo.asset(product.productId, a.mediaId)).state,
        'ATTACHED',
      );
    },
  );
  await check('Product revision race rolls back media write', async (s) => {
    const wrapped = {
      send: async (c) => {
        if (c instanceof TransactWriteCommand)
          await put(s, {
            ...product,
            ...catalogKeys.product(product.productId),
            updatedAt: '2026-10-15T00:00:00.000Z',
          });
        return client.send(c);
      },
    };
    await rejected(
      new MediaRepository(wrapped, s.table, s.clock).replaceManifest(
        product.productId,
        { expectedRevision: 0, images: [] },
      ),
      'PRODUCT_CONFLICT',
    );
    assert.equal(await s.repo.manifest(product.productId), undefined);
  });
  await check(
    'deletion fence respects references, grace and later attachment',
    async (s) => {
      const a = await ready(s);
      await replace(s, 0, [a]);
      s.advance(MEDIA.graceMs);
      await rejected(
        s.repo.fenceDeletion(product.productId, a.mediaId),
        'DELETION_NOT_ELIGIBLE',
      );
      await replace(s, 1, []);
      await rejected(
        s.repo.fenceDeletion(product.productId, a.mediaId),
        'DELETION_NOT_ELIGIBLE',
      );
      s.advance(MEDIA.graceMs);
      assert.equal(
        (await s.repo.fenceDeletion(product.productId, a.mediaId)).state,
        'DELETING',
      );
      await rejected(replace(s, 2, [a]), 'ASSET_STATE_CONFLICT');
    },
  );
  await check(
    'internal records excluded and unrelated records untouched',
    async (s) => {
      const sentinel = {
          PK: 'DROP#SYNTHETIC',
          SK: 'INVENTORY#SYNTHETIC',
          total: 20,
        },
        payment = { PK: 'ORDER#SYNTHETIC', SK: 'PAYMENT', state: 'UNCHANGED' };
      await put(s, sentinel);
      await put(s, payment);
      const before = await get(s, catalogKeys.product(product.productId));
      const a = await ready(s);
      await replace(s, 0, [a]);
      const repo = new DynamoCatalogRepository(client, s.table);
      const listing = await repo.listProducts();
      assert.equal(listing.products.length, 1);
      assert.equal(listing.products[0].productId, product.productId);
      assert.deepEqual(
        await get(s, catalogKeys.product(product.productId)),
        before,
      );
      assert.deepEqual(
        await get(s, { PK: sentinel.PK, SK: sentinel.SK }),
        sentinel,
      );
      assert.deepEqual(
        await get(s, { PK: payment.PK, SK: payment.SK }),
        payment,
      );
    },
  );

  await check(
    'dispatch reservations bound concurrent and interrupted redispatch',
    async (s) => {
      const i = await create(s);
      const outcomes = await Promise.allSettled([
        s.repo.reserveDispatch(product.productId, owner, i.uploadId),
        s.repo.reserveDispatch(product.productId, owner, i.uploadId),
      ]);
      assert.equal(
        outcomes.filter((x) => x.status === 'fulfilled' && x.value.dispatch)
          .length,
        1,
      );
      assert.equal(
        (await s.repo.reserveDispatch(product.productId, owner, i.uploadId))
          .dispatch,
        false,
      );
      s.advance(30000);
      assert.equal(
        (await s.repo.reserveDispatch(product.productId, owner, i.uploadId))
          .dispatch,
        true,
      );
      await s.repo.claim(product.productId, owner, i.uploadId, randomUUID());
      s.advance(MEDIA.leaseMs);
      assert.equal(
        (await s.repo.reserveDispatch(product.productId, owner, i.uploadId))
          .dispatch,
        true,
      );
    },
  );
  const source = await sharp({
    create: { width: 640, height: 480, channels: 3, background: '#aa7744' },
  })
    .png()
    .toBuffer();
  const imageRequest = {
    contentType: 'image/png',
    bytes: source.length,
    sha256: createHash('sha256').update(source).digest('hex'),
  };
  const prepare = async (s, request = imageRequest) => {
    const i = await s.repo.createUpload(
      product.productId,
      owner,
      randomUUID(),
      request,
    );
    await s.repo.reserveDispatch(product.productId, owner, i.uploadId);
    return i;
  };
  const envelope = (i) => ({
    version: 1,
    productId: i.productId,
    subject: owner,
    uploadId: i.uploadId,
  });
  await check(
    'actual isolated Sharp core produces READY exactly once without publication',
    async (s) => {
      const i = await prepare(s),
        objects = new Map();
      const storage = {
        source: async () => source,
        output: async (i, a, v) => {
          const key = outputKey(i, a, v.size, v.format);
          assert.ok(!objects.has(key));
          objects.set(key, v.data);
          return key;
        },
      };
      assert.equal(
        (await processMedia(envelope(i), s.repo, storage, processImage)).state,
        'READY',
      );
      assert.equal(objects.size, 4);
      assert.equal(
        (await s.repo.asset(product.productId, i.mediaId)).state,
        'READY',
      );
      assert.equal(await s.repo.manifest(product.productId), undefined);
      assert.equal(
        (await processMedia(envelope(i), s.repo, storage, processImage)).state,
        'READY',
      );
      assert.equal(objects.size, 4);
    },
  );
  await check(
    'actual image checksum failure becomes terminal unpublished FAILED',
    async (s) => {
      const i = await prepare(s, { ...imageRequest, sha256: '0'.repeat(64) });
      const storage = {
        source: async () => source,
        output: async () => {
          throw new Error('Must not write');
        },
      };
      assert.equal(
        (await processMedia(envelope(i), s.repo, storage, processImage)).state,
        'FAILED',
      );
      assert.equal(await s.repo.asset(product.productId, i.mediaId), undefined);
    },
  );
  await check(
    'partial output failure recovers with a new fenced attempt and immutable keys',
    async (s) => {
      const i = await prepare(s),
        objects = new Map();
      let fail = true;
      const storage = {
        source: async () => source,
        output: async (i, a, v) => {
          const key = outputKey(i, a, v.size, v.format);
          if (fail && objects.size === 1)
            throw new Error('Synthetic storage outage');
          assert.ok(!objects.has(key));
          objects.set(key, v.data);
          return key;
        },
      };
      await rejected(
        processMedia(envelope(i), s.repo, storage, processImage),
        'MEDIA_PROCESSOR_UNAVAILABLE',
      );
      const before = await s.repo.upload(product.productId, owner, i.uploadId);
      assert.equal(before.state, 'PROCESSING');
      assert.equal(await s.repo.asset(product.productId, i.mediaId), undefined);
      s.advance(MEDIA.leaseMs);
      fail = false;
      assert.equal(
        (await processMedia(envelope(i), s.repo, storage, processImage)).state,
        'READY',
      );
      const after = await s.repo.upload(product.productId, owner, i.uploadId);
      assert.equal(after.attempts, 2);
      assert.notEqual(after.leaseToken, before.leaseToken);
      assert.equal(objects.size, 5);
    },
  );
  await check(
    'A: completion rejects exact lease boundary before submission',
    async (s) => {
      const { i, a } = await processing(s);
      s.advance(MEDIA.leaseMs);
      await rejected(
        s.repo.complete(product.productId, owner, i.uploadId, a, result(i, a)),
        'PROCESSING_CONFLICT',
      );
      assert.equal(await s.repo.asset(product.productId, i.mediaId), undefined);
    },
  );
  await check(
    'B: eligible submission may commit after lease expiry without takeover',
    async (s) => {
      const { i, a } = await processing(s),
        d = delayedCompletion(s);
      s.advance(MEDIA.leaseMs - 1);
      const pending = d.repo.complete(
        product.productId,
        owner,
        i.uploadId,
        a,
        result(i, a),
      );
      await d.submitted;
      s.advance(2);
      d.release();
      assert.equal((await pending).state, 'READY');
      assert.ok(s.clock() > i.leaseUntil);
    },
  );
  await check(
    'C: takeover at lease boundary fences submitted old completion',
    async (s) => {
      const { i, a } = await processing(s),
        d = delayedCompletion(s);
      const pending = d.repo.complete(
        product.productId,
        owner,
        i.uploadId,
        a,
        result(i, a),
      );
      const rejection = rejected(pending, 'PROCESSING_CONFLICT');
      await d.submitted;
      s.advance(MEDIA.leaseMs);
      const b = randomUUID();
      const current = await s.repo.claim(
        product.productId,
        owner,
        i.uploadId,
        b,
      );
      assert.ok(current.revision > i.revision);
      d.release();
      await rejection;
      assert.equal(await s.repo.asset(product.productId, i.mediaId), undefined);
      assert.equal(
        (
          await s.repo.complete(
            product.productId,
            owner,
            i.uploadId,
            b,
            result(i, b),
          )
        ).state,
        'READY',
      );
    },
  );
  for (const terminal of ['FAILED', 'EXPIRED']) {
    await check(
      'D: durable ' + terminal + ' fences delayed completion',
      async (s) => {
        const { i, a } = await processing(s),
          d = delayedCompletion(s);
        const pending = d.repo.complete(
          product.productId,
          owner,
          i.uploadId,
          a,
          result(i, a),
        );
        const rejection = rejected(pending, 'PROCESSING_CONFLICT');
        await d.submitted;
        if (terminal === 'FAILED')
          await s.repo.failProcessing(
            product.productId,
            owner,
            i.uploadId,
            a,
            'INVALID_MEDIA',
          );
        else {
          s.advance(MEDIA.completionMs);
          await s.repo.expire(product.productId, owner, i.uploadId);
        }
        d.release();
        await rejection;
        assert.equal(
          (await s.repo.upload(product.productId, owner, i.uploadId)).state,
          terminal,
        );
        assert.equal(
          await s.repo.asset(product.productId, i.mediaId),
          undefined,
        );
      },
    );
  }
  await check(
    'E: overlapping completions reconcile one authoritative receipt and asset',
    async (s) => {
      const { i, a } = await processing(s),
        d = delayedCompletion(s);
      const pending = d.repo.complete(
        product.productId,
        owner,
        i.uploadId,
        a,
        result(i, a),
      );
      await d.submitted;
      s.advance(1); // Completion timestamps differ; preserve the winning original receipt.
      const winner = await s.repo.complete(
        product.productId,
        owner,
        i.uploadId,
        a,
        result(i, a),
      );
      d.release();
      assert.deepEqual(await pending, winner);
      assert.deepEqual(
        await s.repo.asset(product.productId, i.mediaId),
        winner.result,
      );
      assert.equal(winner.revision, i.revision + 1);
    },
  );
  await check(
    'F: READY remains unattached; completion does not publish a manifest',
    async (s) => {
      const asset = await ready(s);
      assert.equal(asset.state, 'READY');
      assert.equal(await s.repo.manifest(product.productId), undefined);
      await replace(s, 0, [asset]);
      assert.equal(
        (await s.repo.asset(product.productId, asset.mediaId)).state,
        'ATTACHED',
      );
      // Public image delivery is absent; attachment alone is not visibility approval.
    },
  );
  await check(
    'READY discovery is bounded, paginated, Product scoped and independent of age',
    async (s) => {
      const assets = [];
      for (let n = 0; n < 15; n++) assets.push(await ready(s));
      const before = await s.repo.readyAssets(product.productId);
      assert.equal(before.assets.length, 12);
      assert.ok(before.nextCursor);
      const second = await s.repo.readyAssets(
        product.productId,
        before.nextCursor,
      );
      assert.equal(second.assets.length, 3);
      assert.equal(
        new Set([...before.assets, ...second.assets].map((a) => a.mediaId))
          .size,
        15,
      );
      s.advance(MEDIA.graceMs + 1);
      assert.equal(
        (await s.repo.readyAssets(product.productId)).assets.length,
        12,
      );
      await replace(s, 0, [assets[0]]);
      let page,
        cursor,
        all = [];
      do {
        page = await s.repo.readyAssets(product.productId, cursor);
        all.push(...page.assets);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      assert.equal(all.length, 14);
      assert.ok(!all.some((a) => a.mediaId === assets[0].mediaId));
      await replace(s, 1, []);
      await s.repo.fenceDeletion(product.productId, assets[1].mediaId);
      await put(s, {
        ...assets[2],
        state: 'DELETED',
        revision: 2,
        ...mediaKeys.asset(product.productId, assets[2].mediaId),
      });
      all = [];
      cursor = undefined;
      do {
        page = await s.repo.readyAssets(product.productId, cursor);
        all.push(...page.assets);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      assert.equal(all.length, 12);
      for (const a of assets.slice(0, 3))
        await rejected(replace(s, 2, [a]), 'ASSET_STATE_CONFLICT');
      const foreign = generateUlid();
      assert.deepEqual((await s.repo.readyAssets(foreign)).assets, []);
      await rejected(
        s.repo.readyAssets(foreign, before.nextCursor),
        'INVALID_MEDIA_CURSOR',
      );
      // A fresh repository represents a fresh authorized browser session, with no browser record.
      assert.equal(
        (
          await new MediaRepository(client, s.table, s.clock).readyAssets(
            product.productId,
          )
        ).assets.length <= 12,
        true,
      );
    },
  );
  await check(
    'cleanup commits after reads but before attachment transaction: attachment loses',
    async (s) => {
      const a = await ready(s);
      s.advance(MEDIA.graceMs);
      const d = delayedCompletion(s);
      const pending = d.repo.replaceManifest(product.productId, {
        expectedRevision: 0,
        images: [{ mediaId: a.mediaId, alt: 'Synthetic' }],
      });
      await d.submitted;
      await s.repo.fenceDeletion(product.productId, a.mediaId);
      d.release();
      await rejected(pending, 'MEDIA_REVISION_CONFLICT');
      assert.equal(
        (await s.repo.asset(product.productId, a.mediaId)).state,
        'DELETING',
      );
      assert.equal(await s.repo.manifest(product.productId), undefined);
    },
  );
  await check(
    'attachment after seven days commits before cleanup transaction: cleanup loses',
    async (s) => {
      const a = await ready(s);
      s.advance(MEDIA.graceMs);
      const d = delayedCompletion(s);
      const pending = d.repo.fenceDeletion(product.productId, a.mediaId);
      await d.submitted;
      await replace(s, 0, [a]);
      d.release();
      await rejected(pending, 'DELETION_CONFLICT');
      assert.equal(
        (await s.repo.asset(product.productId, a.mediaId)).state,
        'ATTACHED',
      );
      assert.deepEqual(
        (await s.repo.readyAssets(product.productId)).assets,
        [],
      );
      await rejected(
        s.repo.fenceDeletion(product.productId, a.mediaId),
        'DELETION_NOT_ELIGIBLE',
      );
    },
  );
  if (process.argv.includes('--processor-runtime')) {
    const {
      createProcessor,
    } = require('../../media-processor/out/host/index.cjs');
    await check(
      'packaged processor reaches durable READY and replays without attachment',
      async (s) => {
        const i = await prepare(s),
          objects = new Map();
        const worker = createProcessor(s.repo, {
          source: async () => source,
          output: async (intent, attempt, variant) => {
            const key = outputKey(
              intent,
              attempt,
              variant.size,
              variant.format,
            );
            assert.ok(!objects.has(key));
            objects.set(key, variant.data);
            return key;
          },
        });
        assert.equal((await worker(envelope(i))).state, 'READY');
        assert.equal(
          (await s.repo.upload(product.productId, owner, i.uploadId)).state,
          'READY',
        );
        assert.equal(
          (await s.repo.asset(product.productId, i.mediaId)).state,
          'READY',
        );
        assert.equal(await s.repo.manifest(product.productId), undefined);
        assert.equal(objects.size, 4);
        assert.equal((await worker(envelope(i))).state, 'READY');
        assert.equal(objects.size, 4);
        assert.deepEqual(await get(s, catalogKeys.product(product.productId)), {
          ...product,
          ...catalogKeys.product(product.productId),
        });
      },
    );
  }
  console.log(`${passed} media DynamoDB Local integration groups passed`);
} finally {
  for (const TableName of tables)
    await raw.send(new DeleteTableCommand({ TableName }));
  raw.destroy();
}
