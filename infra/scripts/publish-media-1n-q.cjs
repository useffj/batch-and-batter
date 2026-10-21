'use strict';
// Fixed owner:1N-Q execution. No credentials or AWS activity on import.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual: equal } = require('node:util');
const api = require('./publish-api-artifact.cjs');
const media = require('./publish-media-artifact.cjs');
const { runPublication } = require('./artifact-publication-core.cjs');
const { createMediaS3Adapter } = require('./api-artifact-s3-adapter.cjs');
const { proposal, roleArn } = require('./media-publication-policy.cjs');
const { ownerOnlyJournal } = require('./publish-isolated-catalog-1n-d.cjs');
const roleName = 'batch-and-batter-dev-media-artifact-publisher';
const types = ['isolated-media-api', 'isolated-media-processor'];
const approval = 'owner:1N-Q';
function check(value, code) {
  if (!value) throw Error(code);
}
function validateArgs(args) {
  check(
    equal(args, ['--publish-approved-1n-q', approval]),
    'EXPLICIT_APPROVAL_ARGUMENT_REQUIRED',
  );
}
function validateCredentials(c) {
  check(
    c &&
      ['accessKeyId', 'secretAccessKey', 'sessionToken'].every(
        (k) => typeof c[k] === 'string' && c[k].length > 0,
      ),
    'TEMPORARY_SESSION_REQUIRED',
  );
  const remaining = c.expiration?.getTime?.() - Date.now();
  check(
    Number.isFinite(remaining) && remaining > 60000 && remaining <= 900000,
    'SHORT_LIVED_SESSION_REQUIRED',
  );
}
function inputFor(type) {
  const d = media.descriptor(type);
  check(types.includes(type), 'UNSUPPORTED_ARTIFACT_TYPE');
  return {
    artifactType: type,
    bytes: d.bytes,
    operationId: d.operationId,
    sha256: d.sha256,
    sourceCommit: d.sourceCommit,
    sourceTree: d.sourceTree,
    key: d.proposedKey,
    approvalReference: approval,
  };
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
function verifyTemporaryIdentity(credentials, execute = execFileSync) {
  check(
    credentials &&
      ['accessKeyId', 'secretAccessKey', 'sessionToken'].every(
        (name) =>
          typeof credentials[name] === 'string' && credentials[name].length > 0,
      ),
    'TEMPORARY_SESSION_REQUIRED',
  );
  validateCredentials(credentials);
  let identity;
  try {
    identity = JSON.parse(
      execute(
        'aws',
        [
          'sts',
          'get-caller-identity',
          '--region',
          'us-east-2',
          '--output',
          'json',
        ],
        {
          encoding: 'utf8',
          timeout: 30000,
          maxBuffer: 16384,
          stdio: ['ignore', 'pipe', 'pipe'],
          // Child-process memory only: never arguments, shell, disk, logs or ambient credential sources.
          env: {
            PATH: process.env.PATH,
            AWS_ACCESS_KEY_ID: credentials.accessKeyId,
            AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
            AWS_SESSION_TOKEN: credentials.sessionToken,
            AWS_CONFIG_FILE: '/dev/null',
            AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
            AWS_EC2_METADATA_DISABLED: 'true',
            AWS_MAX_ATTEMPTS: '1',
            AWS_PAGER: '',
          },
        },
      ),
    );
  } catch {
    throw Error('TEMPORARY_IDENTITY_UNVERIFIED');
  }
  check(
    identity.Account === api.ACCOUNT &&
      identity.Arn ===
        'arn:aws:sts::302154194958:assumed-role/' + roleName + '/media-1n-q',
    'ASSUMED_ROLE_MISMATCH',
  );
}
function inspectProtection(read = operatorRead) {
  const operator = read('sts', 'get-caller-identity');
  check(
    operator.Account === api.ACCOUNT &&
      operator.Arn ===
        'arn:aws:sts::302154194958:assumed-role/AWSReservedSSO_AdministratorAccess_e072fc27fb82916d/UseffJackson',
    'OPERATOR_IDENTITY_CHANGED',
  );
  const approved = proposal();
  function inspectRole(name, expected, policyName) {
    const r = read('iam', 'get-role', '--role-name', name).Role;
    const arn = `arn:aws:iam::302154194958:policy/${name}-boundary`;
    check(
      equal(r.AssumeRolePolicyDocument, expected.trustPolicy) &&
        r.PermissionsBoundary?.PermissionsBoundaryArn === arn,
      'ROLE_TRUST_OR_BOUNDARY_CHANGED',
    );
    const version = read('iam', 'get-policy', '--policy-arn', arn).Policy
      .DefaultVersionId;
    check(
      equal(
        read(
          'iam',
          'get-policy-version',
          '--policy-arn',
          arn,
          '--version-id',
          version,
        ).PolicyVersion.Document,
        expected.permissionsBoundary,
      ),
      'BOUNDARY_CHANGED',
    );
    check(
      equal(
        read('iam', 'list-role-policies', '--role-name', name).PolicyNames,
        [policyName],
      ) &&
        equal(
          read('iam', 'list-attached-role-policies', '--role-name', name)
            .AttachedPolicies,
          [],
        ),
      'ROLE_POLICIES_CHANGED',
    );
    check(
      equal(
        read(
          'iam',
          'get-role-policy',
          '--role-name',
          name,
          '--policy-name',
          policyName,
        ).PolicyDocument,
        expected.identityPolicy,
      ),
      'IDENTITY_POLICY_CHANGED',
    );
  }
  inspectRole(roleName, approved, 'frozen-media-1n-n');
  const historical = require('../config/api-artifact-publisher-policy.json');
  const h = api.ISOLATED_APPROVAL;
  inspectRole(
    'batch-and-batter-dev-api-artifact-publisher',
    {
      ...historical,
      identityPolicy: api.materializeIdentityPolicy(
        `api-releases/${h.operationId}/${h.sha256}.zip`,
      ),
    },
    `isolated-catalog-${h.operationId}`,
  );
  check(
    equal(
      JSON.parse(
        read('s3api', 'get-bucket-policy', '--bucket', api.BUCKET).Policy,
      ),
      approved.bucketPolicy,
    ),
    'BUCKET_POLICY_CHANGED',
  );
  const baseline = require('../config/media-publication-baseline.json');
  for (const [field, operation] of Object.entries({
    versioning: 'get-bucket-versioning',
    encryption: 'get-bucket-encryption',
    lifecycle: 'get-bucket-lifecycle-configuration',
    publicAccess: 'get-public-access-block',
  })) {
    check(
      equal(read('s3api', operation, '--bucket', api.BUCKET), baseline[field]),
      'BUCKET_CONFIGURATION_CHANGED',
    );
  }
  const key = read(
    'kms',
    'describe-key',
    '--key-id',
    'alias/aws/s3',
  ).KeyMetadata;
  check(
    key.Arn === api.KMS &&
      key.KeyManager === 'AWS' &&
      key.KeyState === 'Enabled',
    'KMS_CHANGED',
  );
  check(
    equal(
      JSON.parse(
        read(
          'kms',
          'get-key-policy',
          '--key-id',
          api.KMS,
          '--policy-name',
          'default',
        ).Policy,
      ),
      baseline.kmsPolicy,
    ),
    'KMS_POLICY_CHANGED',
  );
  return {
    ...approved,
    verifiedAt: new Date().toISOString(),
    account: api.ACCOUNT,
    region: 'us-east-2',
    bucket: api.BUCKET,
    publisherArn: roleArn,
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
function loadFrozen() {
  const directory = path.join(
    os.homedir(),
    '.codex/artifacts/batch-and-batter/1n-n-freeze',
  );
  const paths = ['api.zip', 'processor-linux-x64.zip'];
  const st = fs.lstatSync(directory);
  check(
    st.isDirectory() &&
      !st.isSymbolicLink() &&
      st.uid === process.getuid() &&
      (st.mode & 0o077) === 0 &&
      fs.realpathSync(directory) === directory,
    'OWNER_ONLY_FROZEN_DIRECTORY_REQUIRED',
  );
  return types.map((type, index) => {
    const file = path.join(directory, paths[index]),
      stat = fs.lstatSync(file);
    check(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.uid === process.getuid() &&
        (stat.mode & 0o077) === 0,
      'OWNER_ONLY_FROZEN_FILE_REQUIRED',
    );
    const input = inputFor(type);
    check(stat.size === input.bytes, 'FROZEN_SIZE_MISMATCH');
    const bytes = fs.readFileSync(file);
    media.validateInput(input, bytes);
    return { input, bytes };
  });
}
async function publishOne(input, dependencies) {
  check(
    dependencies?.mode === 'approved-1n-q' &&
      dependencies.publisherArn === roleArn &&
      input.approvalReference === approval &&
      equal(input, inputFor(input.artifactType)),
    'EXACT_AUTHORIZATION_REQUIRED',
  );
  validateCredentials(dependencies.credentials);
  check(Buffer.isBuffer(dependencies.bytes), 'FROZEN_BYTES_REQUIRED');
  return runPublication(input, dependencies, false, {
    validateInput: media.validateInput,
    loadCandidate: () => {
      throw Error('FROZEN_BYTES_REQUIRED');
    },
    verifyConfiguration: media.verifyConfiguration,
    keyFor: (i) => i.key,
    publisherArn: roleArn,
    ...Object.fromEntries(
      ['BUCKET', 'ACCOUNT', 'KMS', 'validVersionId', 'hash'].map((k) => [
        k,
        api[k],
      ]),
    ),
  });
}
function oneAttemptTransport(handler) {
  let puts = 0;
  return {
    get putAttempts() {
      return puts;
    },
    handle(request, options) {
      check(
        ['GET', 'HEAD', 'PUT'].includes(request.method),
        'UNEXPECTED_HTTP_METHOD',
      );
      if (request.method === 'PUT') {
        check(puts === 0, 'SECOND_PUT_BLOCKED');
        puts++;
      }
      return handler.handle(request, options);
    },
    destroy() {
      handler.destroy();
    },
  };
}
async function main(args) {
  validateArgs(args);
  const candidates = loadFrozen();
  const directory = path.join(
    os.homedir(),
    '.codex/artifact-publications/media-1n-q',
  );
  const journal = ownerOnlyJournal(directory);
  const lock = path.join(directory, 'batch.lock');
  const fd = fs.openSync(lock, 'wx', 0o600);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  // A crash leaves the lock for separately authorized reconciliation, never retry.
  try {
    for (const { input } of candidates)
      check(
        journal.load(input.operationId) === null,
        'PRIOR_RECEIPT_REQUIRES_RECONCILIATION',
      );
    let protection = inspectProtection();
    const assumed = operatorRead(
      'sts',
      'assume-role',
      '--role-arn',
      roleArn,
      '--role-session-name',
      'media-1n-q',
      '--duration-seconds',
      '900',
    );
    const c = assumed.Credentials;
    const credentials = {
      accessKeyId: c?.AccessKeyId,
      secretAccessKey: c?.SecretAccessKey,
      sessionToken: c?.SessionToken,
      expiration: new Date(c?.Expiration),
    };
    validateCredentials(credentials);
    verifyTemporaryIdentity(credentials);
    const {
      NodeHttpHandler,
    } = require('../../backend/node_modules/@smithy/node-http-handler');
    const adapters = [];
    const transports = [];
    try {
      for (const { input } of candidates) {
        const transport = oneAttemptTransport(
          new NodeHttpHandler({
            connectionTimeout: 5000,
            requestTimeout: 30000,
          }),
        );
        transports.push({ key: input.key, transport });
        const s3 = createMediaS3Adapter({
          key: input.key,
          sha256: input.sha256,
          bytes: input.bytes,
          credentials,
          requestHandler: transport,
        });
        adapters.push(s3);
        const history = await s3.history({
          Bucket: api.BUCKET,
          Key: input.key,
          ExpectedBucketOwner: api.ACCOUNT,
        });
        check(
          history.complete &&
            history.versions.length === 0 &&
            history.deleteMarkers.length === 0,
          'EXISTING_HISTORY_BLOCKS_PUBLICATION',
        );
      }
      for (const [index, { input, bytes }] of candidates.entries()) {
        if (index) {
          protection = inspectProtection();
          verifyTemporaryIdentity(credentials);
        }
        const evidence = {
          ...protection,
          key: input.key,
          sourceCommit: input.sourceCommit,
          sha256: input.sha256,
          approvalReference: approval,
        };
        const receipt = await publishOne(input, {
          mode: 'approved-1n-q',
          publisherArn: roleArn,
          credentials,
          bytes,
          journal,
          adapters: {
            s3: adapters[index],
            protection: { inspect: async () => evidence },
            kms: {
              inspect: async () => ({
                enabled: true,
                manager: 'AWS',
                viaService: 's3.us-east-2.amazonaws.com',
                callerAccount: api.ACCOUNT,
                contextArn: `arn:aws:s3:::${api.BUCKET}/${input.key}`,
              }),
            },
          },
        });
        check(
          receipt.state === 'VERIFIED' && receipt.simulated === false,
          'PUBLICATION_NOT_VERIFIED',
        );
        console.log(
          JSON.stringify({
            state: receipt.state,
            key: receipt.key,
            versionId: receipt.versionId,
            sha256: input.sha256,
            bytes: input.bytes,
            simulated: false,
          }),
        );
      }
    } finally {
      for (const a of adapters) a.destroy();
      for (const { key, transport } of transports)
        console.log(
          JSON.stringify({ key, putAttempts: transport.putAttempts }),
        );
    }
  } finally {
    fs.unlinkSync(lock);
  }
}
module.exports = {
  oneAttemptTransport,
  validateArgs,
  validateCredentials,
  verifyTemporaryIdentity,
  inspectProtection,
  loadFrozen,
  inputFor,
  publishOne,
  main,
};
if (require.main === module)
  main(process.argv.slice(2)).catch(() => {
    console.error(
      'PUBLICATION_STOPPED: preserve receipts and reconcile; never retry PUT.',
    );
    process.exitCode = 1;
  });
