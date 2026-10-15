import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, type ApiEvent } from '../src/api';
import { mediaRoutes, type MediaApiRepository } from '../src/admin-media';
import { MediaConflict, createIntent } from '../src/media-contract';
import { fakeRepository, product, otherProductId } from './fixtures';
const claims = {
  token_use: 'access',
  sub: 'synthetic-admin',
  username: 'synthetic-admin',
  'cognito:groups': ['batch-and-batter-admins'],
};
const key = '11111111-1111-4111-8111-111111111111';
const upload = {
  contentType: 'image/png',
  bytes: 1000,
  sha256: 'a'.repeat(64),
};
const pending = {
  ...createIntent(
    product.productId,
    claims.sub,
    key,
    otherProductId,
    upload,
    Date.now(),
  ),
  attemptIds: [],
};
function event(index = 0, body?: unknown): ApiEvent {
  return {
    routeKey: mediaRoutes[index],
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    pathParameters: {
      productId: product.productId,
      uploadId: pending.uploadId,
      mediaId: otherProductId,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    requestContext: {
      requestId: 'media-test',
      http: { method: mediaRoutes[index].split(' ')[0] },
      authorizer: { jwt: { claims } },
    },
  };
}
function repo(overrides: Partial<MediaApiRepository> = {}): MediaApiRepository {
  return {
    manifest: async () => undefined,
    readyAssets: async () => ({ assets: [], nextCursor: null }),
    asset: async () => undefined,
    upload: async () => undefined,
    replaceManifest: async () => {
      throw new Error('Unexpected write');
    },
    ...overrides,
  };
}
const handler = (m = repo(), exists = true) =>
  createHandler(
    () =>
      fakeRepository({
        getProduct: async () => (exists ? product : undefined),
      }),
    undefined,
    undefined,
    () => m,
  );
for (let n = 0; n < 6; n++)
  test(`${mediaRoutes[n]} requires admin access-token identity before data access`, async () => {
    for (const c of [
      undefined,
      { ...claims, token_use: 'id' },
      { ...claims, 'cognito:groups': ['customers'] },
    ]) {
      const e = event(n, {});
      e.requestContext.authorizer = c ? { jwt: { claims: c } } : undefined;
      const r = await createHandler(() => {
        throw new Error('No data access');
      })(e);
      assert.equal(r.statusCode, c ? 403 : 401);
      assert.equal(r.headers['cache-control'], 'no-store');
    }
  });
test('absent manifest is a read-only empty revision zero', async () => {
  const r = await handler()(event());
  assert.equal(r.statusCode, 200);
  assert.deepEqual(JSON.parse(r.body).manifest, {
    version: 1,
    productId: product.productId,
    revision: 0,
    images: [],
  });
});
test('missing Product is not a successful empty gallery', async () => {
  assert.equal((await handler(repo(), false)(event())).statusCode, 404);
});
test('database failure is unavailable rather than empty success', async () => {
  const r = await handler(
    repo({
      manifest: async () => {
        throw new Error('private AWS details');
      },
    }),
  )(event());
  assert.equal(r.statusCode, 503);
  assert.doesNotMatch(r.body, /private AWS/);
});
test('asset retrieval scopes Product and media identity', async () => {
  let called = false;
  const r = await handler(
    repo({
      asset: async (p, id) => {
        called = true;
        assert.equal(p, product.productId);
        assert.equal(id, otherProductId);
        return undefined;
      },
    }),
  )(event(4));
  assert.ok(called);
  assert.equal(r.statusCode, 404);
});
test('upload status scopes originating administrator', async () => {
  const r = await handler(
    repo({
      upload: async (p, subject, id) => {
        assert.equal(subject, claims.sub);
        assert.equal(p, product.productId);
        assert.equal(id, pending.uploadId);
        return pending;
      },
    }),
  )(event(2));
  assert.equal(r.statusCode, 200);
  assert.doesNotMatch(r.body, /requestHash|subject|leaseToken|sha256/);
});
test('cross-administrator recovery reports not found', async () => {
  const r = await handler(
    repo({
      upload: async () => {
        throw new MediaConflict('UPLOAD_NOT_FOUND');
      },
    }),
  )(event(2));
  assert.equal(r.statusCode, 404);
});
test('new upload fails closed without reserving an intent', async () => {
  const r = await handler()(event(1, upload));
  assert.equal(r.statusCode, 503);
  assert.equal(JSON.parse(r.body).code, 'MEDIA_UPLOAD_UNAVAILABLE');
  assert.doesNotMatch(r.body, /presigned|authorization|READY/);
});
test('idempotency conflict survives missing storage integration', async () => {
  const r = await handler(
    repo({ upload: async () => ({ ...pending, requestHash: 'f'.repeat(64) }) }),
  )(event(1, upload));
  assert.equal(r.statusCode, 409);
  assert.equal(JSON.parse(r.body).code, 'IDEMPOTENCY_CONFLICT');
});
test('completion requests cannot queue or certify processing without dispatch', async () => {
  const r = await handler(repo({ upload: async () => pending }))(event(3, {}));
  assert.equal(r.statusCode, 503);
  assert.equal(JSON.parse(r.body).code, 'MEDIA_PROCESSOR_UNAVAILABLE');
});
test('browser processor claims and unknown fields are rejected', async () => {
  for (const input of [
    { result: { state: 'READY' } },
    { attemptId: key },
    { subject: 'other' },
    { key: 'arbitrary' },
  ])
    assert.equal((await handler()(event(3, input))).statusCode, 400);
  for (const input of [
    { ...upload, subject: 'other' },
    { ...upload, key: 'arbitrary' },
  ])
    assert.equal((await handler()(event(1, input))).statusCode, 400);
});
test('expired intent and tombstone map to gone', async () => {
  for (const i of [
    { ...pending, expiresAt: 1 },
    {
      version: 1 as const,
      uploadId: pending.uploadId,
      productId: product.productId,
      subject: claims.sub,
      requestHash: pending.requestHash,
      revision: 2,
      state: 'TOMBSTONE' as const,
    },
  ]) {
    const r = await handler(repo({ upload: async () => i }))(event(2));
    assert.equal(r.statusCode, 410);
  }
});
test('manifest revision, readiness and ownership errors retain safe contracts', async () => {
  for (const [code, status] of [
    ['MEDIA_REVISION_CONFLICT', 409],
    ['PRODUCT_WRITES_NOT_READY', 503],
    ['ASSET_NOT_FOUND', 404],
  ] as const) {
    const r = await handler(
      repo({
        replaceManifest: async () => {
          throw new MediaConflict(code);
        },
      }),
    )(event(5, { expectedRevision: 1, images: [] }));
    assert.equal(r.statusCode, status);
    assert.equal(JSON.parse(r.body).code, code);
  }
});
test('gallery ordering and alt pass through approved revision operation', async () => {
  const images = [
    { mediaId: otherProductId, alt: ' Primary ' },
    { mediaId: product.productId, alt: 'Second' },
  ];
  const r = await handler(
    repo({
      replaceManifest: async (p, input) => {
        assert.equal(p, product.productId);
        assert.deepEqual(input, {
          expectedRevision: 1,
          images: [{ ...images[0], alt: 'Primary' }, images[1]],
        });
        return { version: 1, productId: p, revision: 2, images };
      },
    }),
  )(event(5, { expectedRevision: 1, images }));
  assert.equal(r.statusCode, 200);
  assert.equal(JSON.parse(r.body).manifest.images[0].mediaId, otherProductId);
});
test('invalid metadata sizes, duplicate ordering and alt cannot reach persistence', async () => {
  for (const images of [
    [{ mediaId: otherProductId, alt: '' }],
    Array(7).fill({ mediaId: otherProductId, alt: 'x' }),
    Array(2).fill({ mediaId: otherProductId, alt: 'x' }),
  ])
    assert.equal(
      (await handler()(event(5, { expectedRevision: 0, images }))).statusCode,
      400,
    );
  const e = event(5);
  e.body = 'x'.repeat(16385);
  assert.equal((await handler()(e)).statusCode, 413);
});
test('internal processor completion routes do not exist', async () => {
  const e = event(3, {});
  e.routeKey = 'POST /admin/products/{productId}/media/processor/complete';
  assert.equal((await handler()(e)).statusCode, 404);
});
test('invalid upload ID and non-JSON content reject without persistence', async () => {
  const e = event(2);
  e.pathParameters!.uploadId = '../unsafe';
  assert.equal((await handler()(e)).statusCode, 400);
  const f = event(1, upload);
  f.headers!['content-type'] = 'image/png';
  assert.equal((await handler()(f)).statusCode, 400);
});

test('Product database failure is sanitized as unavailable', async () => {
  const h = createHandler(
    () =>
      fakeRepository({
        getProduct: async () => {
          throw new Error('private backend detail');
        },
      }),
    undefined,
    undefined,
    () => repo(),
  );
  const r = await h(event());
  assert.equal(r.statusCode, 503);
  assert.doesNotMatch(r.body, /private backend/);
});
test('completed receipt recovery never exposes processor internals or creates another result', async () => {
  const attemptId = key;
  const asset = {
    version: 1 as const,
    productId: product.productId,
    mediaId: otherProductId,
    uploadId: pending.uploadId,
    revision: 1,
    state: 'READY' as const,
    readyAt: Date.now(),
    attemptId,
    result: {
      processingVersion: 1 as const,
      width: 480,
      height: 480,
      variants: [],
    },
  };
  const ready = { ...pending, state: 'READY' as const, result: asset };
  for (const n of [1, 2, 3]) {
    const r = await handler(repo({ upload: async () => ready }))(
      event(n, n === 1 ? upload : n === 3 ? {} : undefined),
    );
    assert.equal(r.statusCode, 200);
    assert.equal(JSON.parse(r.body).upload.result.mediaId, otherProductId);
    assert.doesNotMatch(r.body, /attemptId|requestHash|leaseToken|subject/);
  }
});

test('explicitly injected storage service is reached only after administrator validation', async () => {
  const { MediaOrchestration } = await import('../src/media-orchestration');
  const { MediaRepository } = await import('../src/media-repository');
  let calls = 0;
  const persistence = {
    createUpload: async () => pending,
    assertWritable: async () => {},
  } as unknown as InstanceType<typeof MediaRepository>;
  const services = new MediaOrchestration(
    persistence,
    {
      preflight: async () => {
        calls++;
      },
      authorize: async () => ({
        url: 'https://synthetic.invalid',
        fields: { test: 'synthetic-only' },
        expiresAt: pending.authorizationExpiresAt,
      }),
    },
    {
      invoke: async () => {
        throw new Error('Not invoked');
      },
    },
  );
  const h = createHandler(
    () => fakeRepository({ getProduct: async () => product }),
    undefined,
    undefined,
    () => repo(),
    () => services,
  );
  const unauthorized = event(1, upload);
  unauthorized.requestContext.authorizer = undefined;
  assert.equal((await h(unauthorized)).statusCode, 401);
  assert.equal(calls, 0);
  const response = await h(event(1, upload));
  assert.equal(response.statusCode, 200);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(response.body).upload.state, 'PENDING');
});
test('accepted dispatch returns 202 QUEUED rather than READY', async () => {
  const { MediaOrchestration } = await import('../src/media-orchestration');
  const { MediaRepository } = await import('../src/media-repository');
  let dispatch = 0;
  const persistence = {
    reserveDispatch: async () => ({
      intent: { ...pending, state: 'QUEUED' },
      dispatch: true,
    }),
  } as unknown as InstanceType<typeof MediaRepository>;
  const services = new MediaOrchestration(
    persistence,
    {
      preflight: async () => {},
      authorize: async () => {
        throw new Error();
      },
    },
    {
      invoke: async () => {
        dispatch++;
      },
    },
  );
  const h = createHandler(
    () => fakeRepository({ getProduct: async () => product }),
    undefined,
    undefined,
    () => repo({ upload: async () => pending }),
    () => services,
  );
  const r = await h(event(3, {}));
  assert.equal(r.statusCode, 202);
  assert.equal(JSON.parse(r.body).upload.state, 'QUEUED');
  assert.equal(dispatch, 1);
});

test('READY discovery uses existing admin/product boundary and rejects foreign cursors', async () => {
  const e = event();
  e.queryStringParameters = { view: 'ready' };
  const r = await handler()(e);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(JSON.parse(r.body), { assets: [], nextCursor: null });
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal((await handler(repo(), false)(e)).statusCode, 404);
  e.queryStringParameters.after = otherProductId + '.' + otherProductId;
  assert.equal((await handler()(e)).statusCode, 400);
  e.queryStringParameters = { view: 'ready' };
  e.requestContext.authorizer = undefined;
  assert.equal((await handler()(e)).statusCode, 401);
});
