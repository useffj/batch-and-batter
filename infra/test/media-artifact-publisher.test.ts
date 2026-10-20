import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve, join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
const media = require(
  resolve(__dirname, '../../../scripts/publish-media-artifact.cjs'),
);
const legacy = require(
  resolve(__dirname, '../../../scripts/publish-api-artifact.cjs'),
);
const core = require(
  resolve(__dirname, '../../../scripts/artifact-publication-core.cjs'),
);
const policy = require(
  resolve(__dirname, '../../../scripts/media-publication-policy.cjs'),
);
function input(type = 'isolated-media-api') {
  const d = media.descriptor(type);
  return {
    artifactType: type,
    bytes: d.bytes,
    operationId: d.operationId,
    sha256: d.sha256,
    sourceCommit: d.sourceCommit,
    sourceTree: d.sourceTree,
    key: d.proposedKey,
    approvalReference: 'owner:mock-only',
  };
}
function configuration(i = input()) {
  return {
    ...policy.proposal(),
    account: legacy.ACCOUNT,
    region: 'us-east-2',
    bucket: legacy.BUCKET,
    publisherArn: policy.roleArn,
    publicationAuthorized: true,
    active: true,
    key: i.key,
    sourceCommit: i.sourceCommit,
    sha256: i.sha256,
    approvalReference: i.approvalReference,
    verifiedAt: new Date().toISOString(),
    versioning: 'Enabled',
    currentOnlyRetention: true,
    noncurrentDays: 30,
    abortMultipartDays: 1,
    currentExpiration: false,
    kmsKey: legacy.KMS,
    bucketKeyEnabled: false,
  };
}
test('frozen identity rejects altered source/type/hash/size/key and unapproved references', () => {
  for (const type of ['isolated-media-api', 'isolated-media-processor']) {
    const i = input(type);
    for (const field of [
      'sourceCommit',
      'sourceTree',
      'sha256',
      'operationId',
      'bytes',
    ])
      assert.throws(
        () => media.validateInput({ ...i, [field]: 'wrong' }, Buffer.alloc(0)),
        /FROZEN_IDENTITY/,
      );
    assert.throws(
      () =>
        media.validateInput(
          { ...i, key: i.key.replace('releases', 'other') },
          Buffer.alloc(0),
        ),
      /UNSUPPORTED_KEY/,
    );
    assert.throws(
      () =>
        media.validateInput({ ...i, approvalReference: '' }, Buffer.alloc(0)),
      /APPROVAL_REQUIRED/,
    );
    assert.throws(
      () => media.validateInput(i, Buffer.alloc(1)),
      /FROZEN_BYTES/,
    );
  }
  assert.throws(() => media.descriptor('__proto__'), /UNSUPPORTED/);
  assert.throws(
    () => legacy.validateInput(input(), Buffer.alloc(0)),
    /UNSUPPORTED_ARTIFACT_TYPE/,
  );
});
test('dormant media publisher rejects live adapters before any work', async () => {
  await assert.rejects(
    media.publish(input(), { mode: 'live' }),
    /LIVE_PUBLISHING_DISABLED/,
  );
});
test('strict ZIP parser rejects malformed, truncated and unsafe archives', () => {
  assert.throws(() => media.inspectZip(Buffer.alloc(22)), /INVALID_ZIP/);
  // Build a small stored archive to exercise independent structural validation.
  function zip(name: string) {
    const data = Buffer.from('fixture'),
      n = Buffer.from(name),
      l = Buffer.alloc(30),
      c = Buffer.alloc(46),
      e = Buffer.alloc(22);
    l.writeUInt32LE(0x04034b50);
    l.writeUInt32LE(legacy.crc32(data), 14);
    l.writeUInt32LE(data.length, 18);
    l.writeUInt32LE(data.length, 22);
    l.writeUInt16LE(n.length, 26);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt32LE(legacy.crc32(data), 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(n.length, 28);
    e.writeUInt32LE(0x06054b50);
    e.writeUInt16LE(1, 8);
    e.writeUInt16LE(1, 10);
    e.writeUInt32LE(c.length + n.length, 12);
    e.writeUInt32LE(l.length + n.length + data.length, 16);
    return Buffer.concat([l, n, data, c, n, e]);
  }
  assert.equal(media.inspectZip(zip('index.cjs'))['index.cjs'].bytes, 7);
  for (const n of ['../index.cjs', '/index.cjs', 'a//b'])
    assert.throws(() => media.inspectZip(zip(n)), /UNSAFE_ZIP/);
  const bad = zip('index.cjs');
  bad[40] ^= 1;
  assert.throws(() => media.inspectZip(bad), /ZIP/);
});
test('proposal preserves historical grants and limits new principal to two exact objects', () => {
  const p = policy.proposal();
  const old = require(
    resolve(__dirname, '../../../config/artifact-protection-policy.json'),
  );
  for (const s of old.Statement.filter(
    (s: { Sid: string }) => s.Sid !== 'DedicatedPublisherOnly',
  ))
    assert.deepEqual(
      p.bucketPolicy.Statement.find((x: { Sid: string }) => x.Sid === s.Sid),
      s,
    );
  const deny = p.bucketPolicy.Statement.find(
    (s: { Sid: string }) => s.Sid === 'MediaPublisherExactKeysOnly',
  );
  assert.equal(deny.NotResource.length, 2);
  assert.equal(deny.Condition.ArnEquals['aws:PrincipalArn'], p.roleArn);
  assert.deepEqual(p.permissionsBoundary, p.identityPolicy);
  for (const s of p.identityPolicy.Statement)
    assert.ok(!JSON.stringify(s.Resource).includes('*'));
  assert.notEqual(p.roleArn, legacy.ROLE);
});
test('configuration fails closed on absent IAM, boundary, KMS, approval and stale evidence', async () => {
  for (const field of [
    'identityPolicy',
    'permissionsBoundary',
    'trustPolicy',
    'bucketPolicy',
    'publicationAuthorized',
    'kmsKey',
    'verifiedAt',
  ]) {
    const c = configuration();
    (c as Record<string, unknown>)[field] = null;
    await assert.rejects(
      media.verifyConfiguration(
        { protection: { inspect: async () => c } },
        input().key,
        input(),
      ),
    );
  }
  await assert.rejects(
    media.verifyConfiguration(
      {
        protection: { inspect: async () => configuration() },
        kms: { inspect: async () => ({}) },
      },
      input().key,
      input(),
    ),
    /KMS/,
  );
});
// Exercise the same shared recovery engine with small synthetic bodies; the
// fixed media validators are checked separately against the owner-only ZIPs.
for (const type of ['isolated-media-api', 'isolated-media-processor']) {
  test(`${type}: exact-version readback, lost acknowledgement, conflicts and corrupt receipts`, async () => {
    for (const mode of [
      'success',
      'lost',
      '412',
      '409',
      'history',
      'corrupt',
      'receipt',
    ]) {
      const dir = mkdtempSync(join(tmpdir(), 'media-publisher-'));
      const i = input(type);
      const bytes = Buffer.from('synthetic');
      let puts = 0;
      let object = false;
      const journal = legacy.createJournal(dir);
      const version = 'opaque/+版本==';
      const adapters = {
        kind: 'mock',
        s3: {
          history: async () => ({
            complete: mode !== 'history',
            versions: object
              ? [{ Key: i.key, VersionId: version, IsLatest: true }]
              : [],
            deleteMarkers: [],
          }),
          put: async (r: { IfNoneMatch: string; ChecksumSHA256: string }) => {
            puts++;
            assert.equal(r.IfNoneMatch, '*');
            assert.equal(
              r.ChecksumSHA256,
              Buffer.from(i.sha256, 'hex').toString('base64'),
            );
            if (mode === '412' || mode === '409')
              throw { statusCode: Number(mode) };
            object = true;
            if (mode === 'lost') throw Error('private detail');
            return { VersionId: version };
          },
          get: async () => ({
            VersionId: version,
            Metadata: { operation: i.operationId, source: i.sourceCommit },
            ServerSideEncryption: 'aws:kms',
            SSEKMSKeyId: legacy.KMS,
            BucketKeyEnabled: false,
            Body: mode === 'corrupt' ? Buffer.alloc(0) : bytes,
          }),
          head: async () => ({ VersionId: version }),
        },
      };
      const synthetic = {
        ...i,
        bytes: bytes.length,
        sha256: legacy.hash(bytes),
      };
      const contract = {
        validateInput: () => synthetic,
        verifyConfiguration: async () => {},
        keyFor: () => i.key,
        publisherArn: policy.roleArn,
        BUCKET: legacy.BUCKET,
        ACCOUNT: legacy.ACCOUNT,
        KMS: legacy.KMS,
        validVersionId: legacy.validVersionId,
        hash: legacy.hash,
      };
      // The synthetic checksum must use the actual input identity returned by validation.
      adapters.s3.put = async (r) => {
        puts++;
        assert.equal(r.IfNoneMatch, '*');
        assert.equal(
          r.ChecksumSHA256,
          Buffer.from(synthetic.sha256, 'hex').toString('base64'),
        );
        if (mode === '412' || mode === '409')
          throw { statusCode: Number(mode) };
        object = true;
        if (mode === 'lost') throw Error('private detail');
        return { VersionId: version };
      };
      const run = () =>
        core.runPublication(
          synthetic,
          { journal, adapters, bytes },
          true,
          contract,
        );
      try {
        if (mode === 'receipt')
          writeFileSync(join(dir, i.operationId + '.json'), '{}');
        if (mode === 'success') {
          const r = await run();
          assert.equal(r.state, 'VERIFIED');
          assert.equal(r.versionId, version);
          assert.equal(r.deploymentAuthorized, false);
          await run();
          assert.equal(puts, 1);
          const receipt = journal.load(i.operationId);
          writeFileSync(
            join(dir, i.operationId + '.json'),
            JSON.stringify({ ...receipt, publisherArn: legacy.ROLE }),
          );
          await assert.rejects(run(), /INVALID_RECEIPT_IDENTITY/);
          assert.equal(puts, 1);
        } else {
          await assert.rejects(run());
          const before = puts;
          if (mode === 'lost') assert.equal((await run()).state, 'VERIFIED');
          else await assert.rejects(run());
          assert.equal(puts, before);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
}
test('dormant media transport restricts exact keys and short-lived explicit sessions', () => {
  const { createMediaS3Adapter } = require(
    resolve(__dirname, '../../../scripts/api-artifact-s3-adapter.cjs'),
  );
  const d = media.descriptor('isolated-media-processor');
  const args = {
    key: d.proposedKey,
    sha256: d.sha256,
    bytes: d.bytes,
    requestHandler: {
      handle: async () => {
        throw Error('must not run');
      },
    },
    credentials: {
      accessKeyId: 'synthetic',
      secretAccessKey: 'synthetic',
      sessionToken: 'synthetic',
      expiration: new Date(Date.now() + 60000),
    },
  };
  const adapter = createMediaS3Adapter(args);
  adapter.destroy();
  assert.throws(
    () =>
      createMediaS3Adapter({ ...args, key: 'media-releases/arbitrary.zip' }),
    /UNAPPROVED_MEDIA_KEY/,
  );
  assert.throws(
    () => createMediaS3Adapter({ ...args, bytes: 1 }),
    /FROZEN_IDENTITY_MISMATCH/,
  );
  assert.throws(
    () =>
      createMediaS3Adapter({
        ...args,
        credentials: { ...args.credentials, expiration: new Date(0) },
      }),
    /SHORT_LIVED/,
  );
  assert.throws(
    () =>
      createMediaS3Adapter({
        ...args,
        credentials: {
          ...args.credentials,
          expiration: new Date(Date.now() + 7200000),
        },
      }),
    /SHORT_LIVED/,
  );
});
