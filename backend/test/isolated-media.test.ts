import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';
import {
  IsolatedMedia,
  mediaConfiguration,
  ISOLATED_MEDIA_BUCKET,
  ISOLATED_PROCESSOR,
} from '../src/isolated-media';
import type { MediaRepository } from '../src/media-repository';
import type { MediaOrchestration } from '../src/media-orchestration';
import type { CatalogRepository } from '../src/repository';
import { mediaCatalog } from '../src/isolated-media-handler';
import type { ApiEvent } from '../src/api';
const p = '01K00000000000000000000001',
  m = '01K00000000000000000000002';
const config = {
  AWS_REGION: 'us-east-2',
  CATALOG_TABLE_NAME: 'batch-and-batter-dev-isolated-catalog',
  PAYMENT_START_ENABLED: 'false',
  MEDIA_ENABLED: 'isolated',
  MEDIA_BUCKET_NAME: ISOLATED_MEDIA_BUCKET,
  MEDIA_PROCESSOR_ARN: ISOLATED_PROCESSOR,
};
test('isolated media configuration rejects missing, shared and event-selectable destinations', () => {
  assert.equal(mediaConfiguration(config).bucket, ISOLATED_MEDIA_BUCKET);
  for (const key of Object.keys(config))
    assert.throws(() => mediaConfiguration({ ...config, [key]: 'wrong' }));
  assert.throws(() =>
    mediaConfiguration({
      ...config,
      CATALOG_TABLE_NAME: 'batch-and-batter-dev-catalog',
    }),
  );
});
test('authenticated derivative delivery enforces Product and asset state, bounds and checksum', async () => {
  const bytes = Buffer.from('synthetic WebP bytes');
  let state = 'READY',
    reads = 0,
    hash = createHash('sha256').update(bytes).digest('hex');
  const repo = {
    asset: async (productId: string, mediaId: string) => {
      assert.equal(productId, p);
      assert.equal(mediaId, m);
      return {
        state,
        result: {
          variants: [
            {
              size: 480,
              format: 'webp',
              key: 'approved/products/synthetic',
              bytes: bytes.length,
              sha256: hash,
            },
          ],
        },
      };
    },
  } as unknown as MediaRepository;
  const s3 = {
    send: async (command: { input: { Bucket: string; Key: string } }) => {
      reads++;
      assert.equal(command.input.Bucket, ISOLATED_MEDIA_BUCKET);
      assert.ok(command.input.Key.startsWith('approved/'));
      return {
        ContentType: 'image/webp',
        ContentLength: bytes.length,
        Body: Readable.from([bytes]),
      };
    },
  } as unknown as S3Client;
  const media = new IsolatedMedia(repo, {} as MediaOrchestration, s3);
  const catalog = () =>
    ({
      getProduct: async () => ({ productId: p }),
    }) as unknown as CatalogRepository;
  const event: ApiEvent = {
    routeKey: 'GET /admin/products/{productId}/media/assets/{mediaId}',
    requestContext: {
      requestId: 'local',
      http: { method: 'GET' },
      authorizer: {
        jwt: {
          claims: {
            sub: 'local',
            username: 'local',
            token_use: 'access',
            'cognito:groups': ['batch-and-batter-admins'],
          },
        },
      },
    },
    pathParameters: { productId: p, mediaId: m },
    queryStringParameters: { view: 'image' },
  };
  const router = mediaCatalog(catalog, () => media);
  const r = await router(event);
  assert.equal(r.statusCode, 200);
  assert.equal(Buffer.from(r.body, 'base64').toString(), bytes.toString());
  assert.equal(r.headers['cache-control'], 'no-store, private');
  state = 'RETIRED';
  assert.equal((await router(event)).statusCode, 404);
  assert.equal(reads, 1);
  state = 'ATTACHED';
  hash = 'a'.repeat(64);
  assert.equal((await router(event)).statusCode, 503);
  assert.equal(
    (
      await router({
        ...event,
        queryStringParameters: { view: 'image', key: 'staging/private' },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await router({
        ...event,
        requestContext: { requestId: 'local', http: { method: 'GET' } },
      })
    ).statusCode,
    401,
  );
});
