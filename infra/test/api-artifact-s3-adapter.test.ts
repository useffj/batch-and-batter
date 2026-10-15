import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(__dirname, '../../../');
const { createS3Adapter } = require(
  resolve(root, 'scripts/api-artifact-s3-adapter.cjs'),
);
const { BUCKET, ACCOUNT, KMS } = require(
  resolve(root, 'scripts/publish-api-artifact.cjs'),
);
const body = Buffer.from('synthetic artifact bytes');
const sha256 = createHash('sha256').update(body).digest('hex');
const operation = '12345678-1234-4234-8234-123456789abc';
const key = `api-releases/${operation}/${sha256}.zip`;
const base = { Bucket: BUCKET, Key: key, ExpectedBucketOwner: ACCOUNT };
const put = {
  ...base,
  Body: body,
  IfNoneMatch: '*',
  ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),
  ServerSideEncryption: 'aws:kms',
  SSEKMSKeyId: KMS,
  BucketKeyEnabled: false,
  Metadata: { operation, source: 'a'.repeat(40) },
};
function fixture(
  status = 200,
  headers: Record<string, string> = { 'x-amz-version-id': 'version-1' },
  response = '',
) {
  const calls: any[] = [];
  const handler = {
    handle: async (request: any) => {
      calls.push(request);
      return {
        response: {
          statusCode: status,
          headers,
          body: Readable.from([Buffer.from(response)]),
        },
      };
    },
  };
  const adapter = createS3Adapter({
    key,
    sha256,
    bytes: body.length,
    credentials: {
      accessKeyId: 'synthetic',
      secretAccessKey: 'synthetic',
      sessionToken: 'synthetic',
    },
    requestHandler: handler,
  });
  return { adapter, calls };
}
test('SDK serializes one conditional encrypted PUT with exact identity', async () => {
  const { adapter, calls } = fixture();
  assert.equal((await adapter.put(put)).VersionId, 'version-1');
  assert.equal(calls.length, 1);
  const r = calls[0];
  assert.equal(r.method, 'PUT');
  assert.equal(r.path, '/' + key);
  assert.equal(r.headers['if-none-match'], '*');
  assert.equal(r.headers['x-amz-checksum-sha256'], put.ChecksumSHA256);
  assert.equal(r.headers['x-amz-expected-bucket-owner'], ACCOUNT);
  assert.equal(r.headers['x-amz-server-side-encryption-aws-kms-key-id'], KMS);
  assert.equal(
    r.headers['x-amz-server-side-encryption-bucket-key-enabled'],
    'false',
  );
  assert.equal(r.headers['x-amz-acl'], undefined);
  assert.equal(r.headers['x-amz-tagging'], undefined);
  adapter.destroy();
});
for (const status of [409, 412, 403, 500])
  test(`SDK ${status} is sanitized and never retried`, async () => {
    const { adapter, calls } = fixture(
      status,
      {},
      '<Error><Code>AccessDenied</Code><Message>private-secret</Message></Error>',
    );
    await assert.rejects(adapter.put(put), (e: any) => {
      assert(!e.message.includes('private-secret'));
      if (status < 500) assert.equal(e.statusCode, status);
      return true;
    });
    assert.equal(calls.length, 1);
    adapter.destroy();
  });
for (const version of ['', 'null', 'x'.repeat(1025)])
  test(`invalid returned version length ${version.length} stays unverified`, async () => {
    const { adapter, calls } = fixture(200, { 'x-amz-version-id': version });
    await assert.rejects(adapter.put(put), /VERSION_REQUIRED/);
    assert.equal(calls.length, 1);
    adapter.destroy();
  });
test('opaque 1024 byte VersionId is preserved', async () => {
  const version = 'x'.repeat(1024),
    { adapter } = fixture(200, { 'x-amz-version-id': version });
  assert.equal((await adapter.put(put)).VersionId, version);
  adapter.destroy();
});
for (const corrupt of [false, true])
  test(`exact-version streamed readback verifies SHA (corrupt=${corrupt})`, async () => {
    const { adapter, calls } = fixture(
      200,
      {
        'x-amz-version-id': 'version-1',
        'content-length': String(body.length),
        'x-amz-server-side-encryption': 'aws:kms',
        'x-amz-server-side-encryption-aws-kms-key-id': KMS,
      },
      corrupt ? 'x'.repeat(body.length) : body.toString(),
    );
    if (corrupt)
      await assert.rejects(
        adapter.get({ ...base, VersionId: 'version-1' }),
        /READBACK_UNVERIFIED/,
      );
    else
      assert.deepEqual(
        (await adapter.get({ ...base, VersionId: 'version-1' })).Body,
        body,
      );
    assert.equal(calls[0].query.versionId, 'version-1');
    adapter.destroy();
  });
test('history filters prefix siblings but retains exact-key delete markers', async () => {
  const xml = `<ListVersionsResult><IsTruncated>false</IsTruncated><Version><Key>${key}extra</Key><VersionId>other</VersionId><IsLatest>true</IsLatest></Version><DeleteMarker><Key>${key}</Key><VersionId>deleted</VersionId><IsLatest>true</IsLatest></DeleteMarker></ListVersionsResult>`;
  const { adapter, calls } = fixture(200, {}, xml);
  const result = await adapter.history(base);
  assert.equal(result.complete, true);
  assert.equal(result.versions.length, 0);
  assert.equal(result.deleteMarkers.length, 1);
  assert.equal(calls[0].query.prefix, key);
  adapter.destroy();
});
test('wrong identity and extra write fields fail before transport', async () => {
  const { adapter, calls } = fixture();
  await assert.rejects(
    adapter.put({ ...put, ACL: 'public-read' }),
    /UNAPPROVED/,
  );
  await assert.rejects(adapter.put({ ...put, Key: key + 'other' }), /IDENTITY/);
  await assert.rejects(
    adapter.put({ ...put, Body: Buffer.from('wrong') }),
    /BODY/,
  );
  assert.equal(calls.length, 0);
  adapter.destroy();
});
test('explicit credentials/transport required; import and CLI stay dormant', () => {
  assert.throws(
    () => createS3Adapter({ key, sha256, bytes: body.length }),
    /EXPLICIT_SESSION/,
  );
  const script = `const http=require('node:http'),https=require('node:https');http.request=https.request=()=>{throw Error('NETWORK_FORBIDDEN')};require(${JSON.stringify(resolve(root, 'scripts/api-artifact-s3-adapter.cjs'))});`;
  assert.equal(spawnSync(process.execPath, ['-e', script]).status, 0);
  const result = spawnSync(
    process.execPath,
    [resolve(root, 'scripts/publish-api-artifact.cjs')],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /LIVE_PUBLISHING_DISABLED/);
});
test('pagination follows original markers, detects loops, and never claims incomplete history', async () => {
  let count = 0;
  const adapter = createS3Adapter({
    key,
    sha256,
    bytes: body.length,
    credentials: {
      accessKeyId: 'synthetic',
      secretAccessKey: 'synthetic',
      sessionToken: 'synthetic',
    },
    requestHandler: {
      handle: async (r: any) => {
        count++;
        if (count > 1) assert.equal(r.query['version-id-marker'], 'v1');
        return {
          response: {
            statusCode: 200,
            headers: {},
            body: Readable.from([
              Buffer.from(
                `<ListVersionsResult><IsTruncated>true</IsTruncated><NextKeyMarker>${key}</NextKeyMarker><NextVersionIdMarker>v1</NextVersionIdMarker></ListVersionsResult>`,
              ),
            ]),
          },
        };
      },
    },
  });
  await assert.rejects(adapter.history(base), /PAGINATION_LOOP/);
  assert.equal(count, 2);
  adapter.destroy();
});
test('lost acknowledgement is sanitized without a second send', async () => {
  let calls = 0;
  const adapter = createS3Adapter({
    key,
    sha256,
    bytes: body.length,
    credentials: {
      accessKeyId: 'synthetic',
      secretAccessKey: 'synthetic',
      sessionToken: 'synthetic',
    },
    requestHandler: {
      handle: async () => {
        calls++;
        throw Error('private credential detail');
      },
    },
  });
  await assert.rejects(adapter.put(put), /^Error: AWS_REQUEST_UNCERTAIN$/);
  assert.equal(calls, 1);
  adapter.destroy();
});

test('missing history completeness cannot authorize a new key', async () => {
  const { adapter } = fixture(200, {}, '<ListVersionsResult/>');
  await assert.rejects(adapter.history(base), /HISTORY_COMPLETENESS_REQUIRED/);
  adapter.destroy();
});
