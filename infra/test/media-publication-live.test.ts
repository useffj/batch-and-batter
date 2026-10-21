import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
const live = require(
  resolve(__dirname, '../../../scripts/publish-media-1n-q.cjs'),
);
const media = require(
  resolve(__dirname, '../../../scripts/publish-media-artifact.cjs'),
);
const api = require(
  resolve(__dirname, '../../../scripts/publish-api-artifact.cjs'),
);
const policy = require(
  resolve(__dirname, '../../../scripts/media-publication-policy.cjs'),
);
const historical = require(
  resolve(__dirname, '../../../config/api-artifact-publisher-policy.json'),
);
const baseline = require(
  resolve(__dirname, '../../../config/media-publication-baseline.json'),
);
const session = () => ({
  accessKeyId: 'synthetic',
  secretAccessKey: 'synthetic',
  sessionToken: 'synthetic',
  expiration: new Date(Date.now() + 600000),
});
function read(...args: string[]) {
  const op = args.slice(0, 2).join(' ');
  const name = args[args.indexOf('--role-name') + 1];
  const old =
    name === 'batch-and-batter-dev-api-artifact-publisher' ||
    args.some((a) =>
      a.includes(
        ':policy/batch-and-batter-dev-api-artifact-publisher-boundary',
      ),
    );
  const approved = old ? historical : policy.proposal();
  const h = api.ISOLATED_APPROVAL;
  switch (op) {
    case 'sts get-caller-identity':
      return {
        Account: api.ACCOUNT,
        Arn: 'arn:aws:sts::302154194958:assumed-role/AWSReservedSSO_AdministratorAccess_e072fc27fb82916d/UseffJackson',
      };
    case 'iam get-role':
      return {
        Role: {
          AssumeRolePolicyDocument: approved.trustPolicy,
          PermissionsBoundary: {
            PermissionsBoundaryArn: `arn:aws:iam::302154194958:policy/${name}-boundary`,
          },
        },
      };
    case 'iam get-policy':
      return { Policy: { DefaultVersionId: 'v1' } };
    case 'iam get-policy-version':
      return { PolicyVersion: { Document: approved.permissionsBoundary } };
    case 'iam list-role-policies':
      return {
        PolicyNames: [
          old ? `isolated-catalog-${h.operationId}` : 'frozen-media-1n-n',
        ],
      };
    case 'iam list-attached-role-policies':
      return { AttachedPolicies: [] };
    case 'iam get-role-policy':
      return {
        PolicyDocument: old
          ? api.materializeIdentityPolicy(
              `api-releases/${h.operationId}/${h.sha256}.zip`,
            )
          : approved.identityPolicy,
      };
    case 's3api get-bucket-policy':
      return { Policy: JSON.stringify(policy.proposal().bucketPolicy) };
    case 's3api get-bucket-versioning':
      return baseline.versioning;
    case 's3api get-bucket-encryption':
      return baseline.encryption;
    case 's3api get-bucket-lifecycle-configuration':
      return baseline.lifecycle;
    case 's3api get-public-access-block':
      return baseline.publicAccess;
    case 'kms describe-key':
      return {
        KeyMetadata: { Arn: api.KMS, KeyManager: 'AWS', KeyState: 'Enabled' },
      };
    case 'kms get-key-policy':
      return { Policy: JSON.stringify(baseline.kmsPolicy) };
    default:
      throw Error('unexpected mock read');
  }
}
test('1N-Q accepts only the fixed CLI and approval', () => {
  live.validateArgs(['--publish-approved-1n-q', 'owner:1N-Q']);
  for (const args of [
    [],
    ['--publish-approved-1n-q'],
    ['--publish-approved-1n-q', 'owner:other'],
    ['--publish-approved-1n-q', 'owner:1N-Q', '--key', 'other'],
  ])
    assert.throws(() => live.validateArgs(args), /EXPLICIT_APPROVAL/);
  assert.throws(() => live.inputFor('api'), /UNSUPPORTED/);
});
test('1N-Q requires unexpired explicit temporary credentials', () => {
  live.validateCredentials(session());
  for (const c of [
    null,
    {},
    { ...session(), sessionToken: '' },
    { ...session(), expiration: new Date(0) },
    { ...session(), expiration: new Date(Date.now() + 3600000) },
  ])
    assert.throws(() => live.validateCredentials(c), /SESSION/);
});
test('1N-Q verifies exact assumed role without credentials in command arguments', () => {
  const c = session();
  const execute = (
    _command: string,
    args: string[],
    options: { env: Record<string, string> },
  ) => {
    assert.ok(!args.includes(c.secretAccessKey));
    assert.equal(options.env.AWS_MAX_ATTEMPTS, '1');
    assert.equal(options.env.AWS_SHARED_CREDENTIALS_FILE, '/dev/null');
    return JSON.stringify({
      Account: api.ACCOUNT,
      Arn: 'arn:aws:sts::302154194958:assumed-role/batch-and-batter-dev-media-artifact-publisher/media-1n-q',
    });
  };
  live.verifyTemporaryIdentity(c, execute);
  assert.throws(
    () =>
      live.verifyTemporaryIdentity(c, () =>
        JSON.stringify({ Account: api.ACCOUNT, Arn: 'wrong-role' }),
      ),
    /ASSUMED_ROLE_MISMATCH/,
  );
});
test('1N-Q verifies new and historical policies, KMS, retention and encryption', () => {
  const p = live.inspectProtection(read);
  assert.equal(p.publisherArn, policy.roleArn);
  for (const op of [
    'iam get-role',
    'iam get-policy-version',
    'iam get-role-policy',
    'iam list-attached-role-policies',
    's3api get-bucket-policy',
    's3api get-bucket-encryption',
    's3api get-bucket-lifecycle-configuration',
    'kms describe-key',
    'kms get-key-policy',
  ]) {
    assert.throws(() =>
      live.inspectProtection((...args: string[]) =>
        args.slice(0, 2).join(' ') === op ? {} : read(...args),
      ),
    );
  }
});
test('1N-Q rejects wrong approval, role, key, source and byte identities before any PUT', async () => {
  const i = live.inputFor('isolated-media-api');
  const d = {
    mode: 'approved-1n-q',
    publisherArn: policy.roleArn,
    credentials: session(),
    bytes: Buffer.alloc(1),
  };
  for (const wrong of [
    { ...i, approvalReference: 'other' },
    { ...i, key: 'wrong' },
    { ...i, sourceCommit: 'a'.repeat(40) },
    { ...i, sha256: 'b'.repeat(64) },
  ])
    await assert.rejects(live.publishOne(wrong, d), /EXACT_AUTHORIZATION/);
  await assert.rejects(
    live.publishOne(i, { ...d, publisherArn: api.ROLE }),
    /EXACT_AUTHORIZATION/,
  );
  await assert.rejects(
    live.publishOne(i, { ...d, credentials: {} }),
    /SESSION/,
  );
  await assert.rejects(live.publishOne(i, d), /FROZEN_BYTES_MISMATCH/);
  await assert.rejects(media.publish(i, d), /LIVE_PUBLISHING_DISABLED/);
});
test('1N-Q transport permits only one PUT, even after an uncertain transport failure', async () => {
  let calls = 0;
  const t = live.oneAttemptTransport({
    handle: async () => {
      calls++;
      throw Error('synthetic uncertainty');
    },
    destroy: () => {},
  });
  await assert.rejects(t.handle({ method: 'PUT' }, {}));
  assert.equal(t.putAttempts, 1);
  assert.throws(() => t.handle({ method: 'PUT' }, {}), /SECOND_PUT_BLOCKED/);
  assert.throws(
    () => t.handle({ method: 'DELETE' }, {}),
    /UNEXPECTED_HTTP_METHOD/,
  );
  assert.equal(calls, 1);
});
