'use strict';
// One owner-authorized identity. Importing this module never loads credentials.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual: equal } = require('node:util');
const api = require('./publish-api-artifact.cjs');
const { createS3Adapter } = require('./api-artifact-s3-adapter.cjs');
const root = path.resolve(__dirname, '../..');
const roleName = 'batch-and-batter-dev-api-artifact-publisher';
const policyName = 'isolated-catalog-' + api.ISOLATED_APPROVAL.operationId;
const key = `api-releases/${api.ISOLATED_APPROVAL.operationId}/${api.ISOLATED_APPROVAL.sha256}.zip`;
function check(value, code) {
  if (!value) throw Error(code);
}
function operatorRead(...args) {
  try {
    return JSON.parse(
      execFileSync(
        'aws',
        [
          '--profile',
          'batch-and-batter-dev',
          '--region',
          'us-east-2',
          ...args,
          '--output',
          'json',
        ],
        {
          encoding: 'utf8',
          timeout: 60000,
          maxBuffer: 8 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, AWS_MAX_ATTEMPTS: '1', AWS_PAGER: '' },
        },
      ),
    );
  } catch {
    throw Error('OPERATOR_READ_OR_SESSION_FAILED');
  }
}
function inspectProtection(read = operatorRead) {
  const operator = read('sts', 'get-caller-identity');
  check(
    operator.Account === api.ACCOUNT &&
      operator.Arn ===
        'arn:aws:sts::302154194958:assumed-role/AWSReservedSSO_AdministratorAccess_e072fc27fb82916d/UseffJackson',
    'OPERATOR_IDENTITY_CHANGED',
  );
  const approved = require('../config/api-artifact-publisher-policy.json');
  const role = read('iam', 'get-role', '--role-name', roleName).Role;
  check(
    equal(role.AssumeRolePolicyDocument, approved.trustPolicy),
    'TRUST_CHANGED',
  );
  const boundaryArn =
    'arn:aws:iam::302154194958:policy/' + roleName + '-boundary';
  check(
    role.PermissionsBoundary?.PermissionsBoundaryArn === boundaryArn,
    'BOUNDARY_CHANGED',
  );
  const version = read('iam', 'get-policy', '--policy-arn', boundaryArn).Policy
    .DefaultVersionId;
  const boundary = read(
    'iam',
    'get-policy-version',
    '--policy-arn',
    boundaryArn,
    '--version-id',
    version,
  ).PolicyVersion.Document;
  check(equal(boundary, approved.permissionsBoundary), 'BOUNDARY_CHANGED');
  check(
    equal(
      read('iam', 'list-role-policies', '--role-name', roleName).PolicyNames,
      [policyName],
    ) &&
      equal(
        read('iam', 'list-attached-role-policies', '--role-name', roleName)
          .AttachedPolicies,
        [],
      ),
    'ROLE_POLICIES_CHANGED',
  );
  const identityPolicy = read(
    'iam',
    'get-role-policy',
    '--role-name',
    roleName,
    '--policy-name',
    policyName,
  ).PolicyDocument;
  check(
    equal(identityPolicy, api.materializeIdentityPolicy(key)),
    'IDENTITY_POLICY_CHANGED',
  );
  const policy = JSON.parse(
    read('s3api', 'get-bucket-policy', '--bucket', api.BUCKET).Policy,
  );
  check(policy.Id === 'AccessControl', 'BUCKET_POLICY_CHANGED');
  delete policy.Id; // Known installed metadata only; compare every protection statement.
  check(
    equal(policy, require('../config/artifact-protection-policy.json')),
    'BUCKET_POLICY_CHANGED',
  );
  check(
    read('s3api', 'get-bucket-versioning', '--bucket', api.BUCKET).Status ===
      'Enabled',
    'VERSIONING_CHANGED',
  );
  const encryption = read(
    's3api',
    'get-bucket-encryption',
    '--bucket',
    api.BUCKET,
  ).ServerSideEncryptionConfiguration.Rules;
  check(
    encryption.length === 1 &&
      encryption[0].BucketKeyEnabled === false &&
      equal(encryption[0].ApplyServerSideEncryptionByDefault, {
        SSEAlgorithm: 'aws:kms',
      }),
    'ENCRYPTION_CHANGED',
  );
  const kms = read(
    'kms',
    'describe-key',
    '--key-id',
    'alias/aws/s3',
  ).KeyMetadata;
  check(
    kms.Arn === api.KMS &&
      kms.KeyManager === 'AWS' &&
      kms.KeyState === 'Enabled',
    'KMS_CHANGED',
  );
  const lifecycle = read(
    's3api',
    'get-bucket-lifecycle-configuration',
    '--bucket',
    api.BUCKET,
  ).Rules;
  check(
    equal(lifecycle, [
      {
        ID: 'CleanupOldVersions',
        Filter: { Prefix: '' },
        Status: 'Enabled',
        NoncurrentVersionExpiration: { NoncurrentDays: 30 },
      },
      {
        ID: 'AbortIncompleteMultipartUploads',
        Filter: { Prefix: '' },
        Status: 'Enabled',
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
      },
    ]),
    'RETENTION_CHANGED',
  );
  return {
    identityPolicy,
    permissionsBoundary: boundary,
    trustPolicy: role.AssumeRolePolicyDocument,
    policy,
    verifiedAt: new Date().toISOString(),
    ...api.ISOLATED_APPROVAL,
    key,
    account: api.ACCOUNT,
    region: 'us-east-2',
    bucket: api.BUCKET,
    publisherArn: api.ROLE,
    publicationAuthorized: true,
    active: true,
    versioning: 'Enabled',
    currentOnlyRetention: true,
    noncurrentDays: 30,
    abortMultipartDays: 1,
    currentExpiration: false,
    kmsKey: api.KMS,
    bucketKeyEnabled: false,
  };
}
function ownerOnlyJournal(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(directory);
  check(
    !st.isSymbolicLink() &&
      st.isDirectory() &&
      st.uid === process.getuid() &&
      (st.mode & 0o777) === 0o700 &&
      fs.realpathSync(directory) === directory,
    'OWNER_ONLY_JOURNAL_REQUIRED',
  );
  for (const name of fs.readdirSync(directory)) {
    const f = fs.lstatSync(path.join(directory, name));
    check(
      f.isFile() &&
        !f.isSymbolicLink() &&
        f.uid === process.getuid() &&
        (f.mode & 0o777) === 0o600,
      'UNSAFE_JOURNAL_ENTRY',
    );
  }
  return api.createJournal(directory);
}
async function main(args) {
  check(
    equal(args, ['--publish-approved-1n-d']),
    'EXPLICIT_APPROVAL_ARGUMENT_REQUIRED',
  );
  const input = {
    ...api.ISOLATED_APPROVAL,
    buildEvidence: JSON.parse(
      fs.readFileSync(
        path.join(root, 'backend/dist/isolated-catalog-release/evidence.json'),
        'utf8',
      ),
    ),
  };
  const bytes = api.loadCandidate(input);
  const journal = ownerOnlyJournal(
    path.join(
      os.homedir(),
      '.codex/artifact-publications/isolated-catalog-1n-d',
    ),
  );
  // Fresh operator inspection before assuming the restricted role. Never capture credentials in receipts.
  const protection = inspectProtection();
  const assumed = operatorRead(
    'sts',
    'assume-role',
    '--role-arn',
    api.ROLE,
    '--role-session-name',
    'isolated-catalog-1n-d',
    '--duration-seconds',
    '900',
  );
  const c = assumed.Credentials;
  check(
    c && Date.parse(c.Expiration) > Date.now() + 60000,
    'TEMPORARY_SESSION_REQUIRED',
  );
  const credentials = {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretAccessKey,
    sessionToken: c.SessionToken,
  };
  const {
    NodeHttpHandler,
  } = require('../../backend/node_modules/@smithy/node-http-handler');
  const {
    STSClient,
    GetCallerIdentityCommand,
  } = require('../../backend/node_modules/@aws-sdk/nested-clients/sts');
  const sts = new STSClient({
    region: 'us-east-2',
    credentials,
    maxAttempts: 1,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 5000,
      requestTimeout: 30000,
    }),
  });
  let s3;
  try {
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    check(
      identity.Account === api.ACCOUNT &&
        identity.Arn ===
          'arn:aws:sts::302154194958:assumed-role/' +
            roleName +
            '/isolated-catalog-1n-d',
      'ASSUMED_ROLE_MISMATCH',
    );
    s3 = createS3Adapter({
      key,
      sha256: input.sha256,
      bytes: input.bytes,
      credentials,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 5000,
        requestTimeout: 30000,
      }),
    });
    const dependencies = {
      mode: 'approved-1n-d',
      publisherArn: api.ROLE,
      bytes,
      journal,
      adapters: {
        kind: 'verified-publisher-role',
        s3,
        protection: { inspect: async () => protection },
        kms: {
          inspect: async () => ({
            enabled: true,
            manager: 'AWS',
            viaService: 's3.us-east-2.amazonaws.com',
            callerAccount: api.ACCOUNT,
            contextArn: `arn:aws:s3:::${api.BUCKET}/${key}`,
          }),
        },
      },
    };
    // No retry loop. A later explicit recovery invocation uses the same durable operation and cannot PUT again.
    const receipt = await api.publishApprovedIsolatedCatalog(
      input,
      dependencies,
    );
    api.isolatedArtifactParameters(receipt.key, receipt.versionId);
    console.log(
      JSON.stringify({
        state: receipt.state,
        key: receipt.key,
        versionId: receipt.versionId,
        simulated: receipt.simulated,
      }),
    );
  } finally {
    sts.destroy();
    s3?.destroy();
  }
}
module.exports = { inspectProtection, ownerOnlyJournal, main };
if (require.main === module)
  main(process.argv.slice(2)).catch(() => {
    // SDK/CLI exceptions may contain credentials or signed requests. Keep failure output constant.
    console.error(
      'PUBLICATION_STOPPED: inspect the original private receipt; never retry PUT or replace the operation.',
    );
    process.exitCode = 1;
  });
