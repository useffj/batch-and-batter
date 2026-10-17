import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { S3MediaStorage, LambdaMediaDispatch } from '../src/media-storage';
import { createIntent, MediaConflict, MEDIA } from '../src/media-contract';
import { MediaOrchestration } from '../src/media-orchestration';
import type { MediaRepository } from '../src/media-repository';
const productId = '01K00000000000000000000001';
const cfg = {
  enabled: true,
  region: 'us-east-2',
  bucket: 'batch-and-batter-dev-product-media-302154194958-us-east-2',
  processorArn:
    'arn:aws:lambda:us-east-2:302154194958:function:batch-and-batter-dev-media-processor',
};
const request = {
  contentType: 'image/png',
  bytes: 1000,
  sha256: 'ab'.repeat(32),
};
const intent = () => ({
  ...createIntent(
    productId,
    'synthetic-admin',
    '11111111-1111-4111-8111-111111111111',
    productId,
    request,
    Date.now(),
  ),
  attemptIds: [],
});
const client = () =>
  new S3Client({
    region: 'us-east-2',
    credentials: {
      accessKeyId: 'LOCALONLY',
      secretAccessKey: 'LOCALONLY',
      sessionToken: 'LOCALONLY',
      expiration: new Date(Date.now() + 3600000),
    },
    requestHandler: {
      handle: async () => {
        throw new Error('Network forbidden');
      },
    },
    maxAttempts: 1,
  });
test('SDK signs exact staging key, checksum, MIME, byte range and original deadline without network', async () => {
  const c = client(),
    s = new S3MediaStorage(c, cfg),
    i = intent();
  await s.preflight();
  const signed = await s.authorize(i),
    p = JSON.parse(Buffer.from(signed.fields.Policy, 'base64').toString());
  assert.ok(Date.parse(p.expiration) <= i.authorizationExpiresAt);
  assert.ok(
    p.conditions.some(
      (v: unknown) =>
        JSON.stringify(v) ===
        JSON.stringify(['content-length-range', 1000, 1000]),
    ),
  );
  for (const field of [
    'key',
    'Content-Type',
    'x-amz-checksum-algorithm',
    'x-amz-checksum-sha256',
    'bucket',
  ])
    assert.ok(
      p.conditions.some(
        (v: Record<string, unknown>) => v[field] === signed.fields[field],
      ),
    );
  assert.equal(
    signed.fields.key,
    `staging/products/${productId}/${i.uploadId}/source`,
  );
  assert.equal(
    signed.fields['x-amz-checksum-sha256'],
    Buffer.from(request.sha256, 'hex').toString('base64'),
  );
  assert.equal(signed.fields['x-amz-checksum-algorithm'], 'SHA256');
  assert.equal(signed.fields.acl, undefined);
  c.destroy();
});
test('retry cannot extend original authorization, and expired authorization fails', async () => {
  const c = client(),
    s = new S3MediaStorage(c, cfg),
    i = { ...intent(), authorizationExpiresAt: Date.now() + 5000 };
  const a = await s.authorize(i);
  assert.ok(a.expiresAt <= i.authorizationExpiresAt);
  await assert.rejects(
    s.authorize({ ...i, authorizationExpiresAt: Date.now() - 1 }),
    /UPLOAD_AUTHORIZATION_EXPIRED/,
  );
  c.destroy();
});
test('disabled configuration and arbitrary bucket/function destinations are rejected', () => {
  for (const conf of [
    { ...cfg, enabled: false },
    { ...cfg, bucket: 'other-bucket' },
    {
      ...cfg,
      processorArn: 'arn:aws:lambda:us-east-2:999999999999:function:any',
    },
  ]) {
    const c = client();
    assert.throws(() => new S3MediaStorage(c, conf));
    c.destroy();
  }
});
test('missing temporary credentials fail signing preflight without reserving an intent', async () => {
  const c = new S3Client({
      region: 'us-east-2',
      credentials: async () => {
        throw new Error('private credential error');
      },
    }),
    s = new S3MediaStorage(c, cfg);
  let writes = 0;
  const repo = {
    createUpload: async () => {
      writes++;
      return intent();
    },
  } as unknown as MediaRepository;
  const o = new MediaOrchestration(repo, s, { invoke: async () => {} });
  await assert.rejects(
    o.upload(productId, 'synthetic-admin', 'key', request),
    /MEDIA_UPLOAD_UNAVAILABLE/,
  );
  assert.equal(writes, 0);
  c.destroy();
});
test('signing failure never reports usable success; durable identity is retained for recovery', async () => {
  const i = intent();
  let calls = 0;
  const repo = {
    createUpload: async () => {
      calls++;
      return i;
    },
    assertWritable: async () => {},
  } as unknown as MediaRepository;
  const o = new MediaOrchestration(
    repo,
    {
      preflight: async () => {},
      authorize: async () => {
        throw new MediaConflict('MEDIA_UPLOAD_UNAVAILABLE');
      },
    },
    { invoke: async () => {} },
  );
  await assert.rejects(
    o.upload(productId, 'synthetic-admin', 'key', request),
    /MEDIA_UPLOAD_UNAVAILABLE/,
  );
  assert.equal(calls, 1);
});
test('dispatch acceptance is not READY and lost acknowledgement remains recoverable', async () => {
  const queued = { ...intent(), state: 'QUEUED' as const };
  let invokes = 0;
  const repo = {
    reserveDispatch: async () => ({ intent: queued, dispatch: invokes === 0 }),
  } as unknown as MediaRepository;
  const o = new MediaOrchestration(
    repo,
    {
      preflight: async () => {},
      authorize: async () => {
        throw new Error();
      },
    },
    {
      invoke: async () => {
        invokes++;
        throw new MediaConflict('MEDIA_PROCESSOR_UNAVAILABLE');
      },
    },
  );
  await assert.rejects(
    o.requestProcessing(productId, 'synthetic-admin', queued.uploadId),
    /MEDIA_PROCESSOR_UNAVAILABLE/,
  );
  assert.equal(
    (await o.requestProcessing(productId, 'synthetic-admin', queued.uploadId))
      .state,
    'QUEUED',
  );
  assert.equal(invokes, 1);
});
test('Lambda invocation uses fixed async ARN and identity-only payload; non-202 response fails', async () => {
  for (const status of [202, 200]) {
    let called = false;
    const fake = {
      send: async (command: { input: Record<string, unknown> }) => {
        called = true;
        assert.equal(command.input.FunctionName, cfg.processorArn);
        assert.equal(command.input.InvocationType, 'Event');
        const payload = JSON.parse(
          Buffer.from(command.input.Payload as Uint8Array).toString(),
        );
        assert.deepEqual(Object.keys(payload).sort(), [
          'productId',
          'subject',
          'uploadId',
          'version',
        ]);
        return { StatusCode: status };
      },
    } as unknown as LambdaClient;
    const d = new LambdaMediaDispatch(fake, cfg);
    if (status === 202) await d.invoke(intent());
    else
      await assert.rejects(d.invoke(intent()), /MEDIA_PROCESSOR_UNAVAILABLE/);
    assert.ok(called);
  }
});
test('bounded source streaming rejects excessive bytes and closes stream', async () => {
  const stream = Readable.from([Buffer.alloc(1001)]);
  const fake = {
    send: async (c: unknown) => {
      assert.ok(c instanceof GetObjectCommand);
      return { Body: stream, ContentLength: 1000 };
    },
  } as unknown as S3Client;
  const s = new S3MediaStorage(fake, cfg);
  await assert.rejects(s.source(intent()), /INVALID_MEDIA/);
  assert.ok(stream.destroyed);
});
test('immutable output puts never overwrite an approved key', async () => {
  const fake = {
    send: async (c: PutObjectCommand) => {
      assert.ok(c instanceof PutObjectCommand);
      assert.equal(c.input.IfNoneMatch, '*');
      assert.equal(c.input.Bucket, cfg.bucket);
      assert.match(c.input.Key!, /^approved\/products\//);
    },
  } as unknown as S3Client;
  await new S3MediaStorage(fake, cfg).output(
    intent(),
    '22222222-2222-4222-8222-222222222222',
    {
      size: 480,
      format: 'webp',
      data: Buffer.alloc(1),
      sha256: 'a'.repeat(64),
    },
  );
});

test('isolated Lambda session credentials without expiry metadata remain capped at five minutes', async () => {
  const config = {
    ...cfg,
    bucket: 'batch-and-batter-dev-isolated-media-302154194958-us-east-2',
    processorArn:
      'arn:aws:lambda:us-east-2:302154194958:function:batch-and-batter-dev-isolated-media-processor',
  };
  const c = new S3Client({
    region: 'us-east-2',
    credentials: {
      accessKeyId: 'LOCALONLY',
      secretAccessKey: 'LOCALONLY',
      sessionToken: 'LOCALONLY',
    },
  });
  const s = new S3MediaStorage(c, config);
  await s.preflight();
  const signed = await s.authorize(intent());
  assert.ok(signed.expiresAt <= Date.now() + 300000);
  assert.equal(signed.fields['X-Amz-Security-Token'], 'LOCALONLY');
  await assert.rejects(
    new S3MediaStorage(c, cfg).preflight(),
    /MEDIA_UPLOAD_UNAVAILABLE/,
  );
  c.destroy();
  for (const credentials of [
    { accessKeyId: 'LOCALONLY', secretAccessKey: 'LOCALONLY' },
    {
      accessKeyId: 'LOCALONLY',
      secretAccessKey: 'LOCALONLY',
      sessionToken: 'LOCALONLY',
      expiration: new Date(0),
    },
  ]) {
    const client = new S3Client({ region: 'us-east-2', credentials });
    await assert.rejects(
      new S3MediaStorage(client, config).preflight(),
      /MEDIA_UPLOAD_UNAVAILABLE/,
    );
    client.destroy();
  }
});
