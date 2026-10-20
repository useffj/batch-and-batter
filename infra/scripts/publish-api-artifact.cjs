'use strict';
// Local contract only: no SDK, credential provider, HTTP client or live adapter.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const BUCKET = 'cdk-hnb659fds-assets-302154194958-us-east-2';
const ACCOUNT = '302154194958';
const KMS =
  'arn:aws:kms:us-east-2:302154194958:key/c4361324-2444-4484-82ef-f98ba10b5ad3';
const ROLE =
  'arn:aws:iam::302154194958:role/batch-and-batter-dev-api-artifact-publisher';
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function requireThat(value, code) {
  if (!value) throw Error(code);
}
function text(value) {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)
  );
}
// S3 VersionIds are opaque UTF-8 text, not approval labels. Never transform them.
function validVersionId(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value !== 'null' &&
    value.isWellFormed() &&
    Buffer.byteLength(value, 'utf8') <= 1024
  );
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function validateZip(bytes) {
  requireThat(bytes.length >= 120, 'INVALID_ZIP');
  const end = bytes.length - 22;
  requireThat(
    bytes.readUInt32LE(end) === 0x06054b50 &&
      bytes.readUInt16LE(end + 4) === 0 &&
      bytes.readUInt16LE(end + 6) === 0 &&
      bytes.readUInt16LE(end + 8) === 1 &&
      bytes.readUInt16LE(end + 10) === 1 &&
      bytes.readUInt16LE(end + 20) === 0,
    'INVALID_ZIP',
  );
  const central = bytes.readUInt32LE(end + 16);
  requireThat(
    central >= 40 &&
      central + 56 === end &&
      bytes.readUInt32LE(end + 12) === 56,
    'INVALID_ZIP',
  );
  requireThat(
    bytes.readUInt32LE(0) === 0x04034b50 &&
      bytes.readUInt16LE(6) === 0 &&
      bytes.readUInt16LE(8) === 0 &&
      bytes.readUInt16LE(26) === 10 &&
      bytes.readUInt16LE(28) === 0 &&
      bytes.subarray(30, 40).toString() === 'handler.js',
    'INVALID_ZIP',
  );
  const size = bytes.readUInt32LE(18);
  requireThat(
    crc32(bytes.subarray(40, central)) === bytes.readUInt32LE(14),
    'INVALID_ZIP_CRC',
  );
  requireThat(
    size > 0 && size === bytes.readUInt32LE(22) && 40 + size === central,
    'INVALID_ZIP',
  );
  requireThat(
    bytes.readUInt32LE(central) === 0x02014b50 &&
      bytes.readUInt16LE(central + 8) === 0 &&
      bytes.readUInt16LE(central + 10) === 0 &&
      bytes.readUInt32LE(central + 16) === bytes.readUInt32LE(14) &&
      bytes.readUInt32LE(central + 20) === size &&
      bytes.readUInt32LE(central + 24) === size &&
      bytes.readUInt16LE(central + 28) === 10 &&
      bytes.readUInt16LE(central + 30) === 0 &&
      bytes.readUInt16LE(central + 32) === 0 &&
      bytes.readUInt16LE(central + 34) === 0 &&
      bytes.readUInt32LE(central + 42) === 0 &&
      bytes.subarray(central + 46, end).toString() === 'handler.js',
    'INVALID_ZIP',
  );
}
const ARTIFACT_PATHS = Object.freeze({
  api: 'backend/dist/api-release/api.zip',
  'isolated-catalog': 'backend/dist/isolated-catalog-release/api.zip',
});
function artifactType(input) {
  // Omission preserves the original ordinary-API receipt contract. It can never
  // select an isolated artifact. New approvals should always name the type.
  const type = input.artifactType === undefined ? 'api' : input.artifactType;
  requireThat(
    typeof type === 'string' && Object.hasOwn(ARTIFACT_PATHS, type),
    'UNSUPPORTED_ARTIFACT_TYPE',
  );
  requireThat(
    !['path', 'zipPath', 'artifactPath'].some((key) =>
      Object.hasOwn(input, key),
    ),
    'UNEXPECTED_ARTIFACT_PATH',
  );
  return type;
}
function isolatedArtifactParameters(key, versionId) {
  materializeIdentityPolicy(key); // Existing exact UUID/hash key grammar.
  requireThat(validVersionId(versionId), 'INVALID_ARTIFACT_VERSION');
  return { ArtifactKey: key, ArtifactVersion: versionId };
}
function validateInput(input, bytes) {
  const type = artifactType(input);
  requireThat(UUID.test(input.operationId), 'INVALID_OPERATION');
  requireThat(
    text(input.artifactId) && text(input.approvalReference),
    'APPROVAL_REQUIRED',
  );
  requireThat(/^[a-f0-9]{40}$/.test(input.sourceCommit), 'INVALID_SOURCE');
  requireThat(
    /^[a-f0-9]{64}$/.test(input.sha256) && hash(bytes) === input.sha256,
    'SOURCE_HASH_MISMATCH',
  );
  requireThat(
    Number.isSafeInteger(input.bytes) &&
      input.bytes > 0 &&
      input.bytes <= 50 * 1024 * 1024 &&
      bytes.length === input.bytes,
    'SOURCE_SIZE_MISMATCH',
  );
  const b = input.buildEvidence;
  requireThat(
    b &&
      isDeepStrictEqual(Object.keys(b).sort(), [
        'bytes',
        'files',
        'handler',
        'lockSha256',
        'node',
        'sha256',
      ]),
    'INVALID_BUILD_EVIDENCE',
  );
  requireThat(
    b &&
      b.handler === 'handler.handler' &&
      isDeepStrictEqual(b.files, ['handler.js']) &&
      b.sha256 === input.sha256 &&
      b.bytes === input.bytes &&
      /^[a-f0-9]{64}$/.test(b.lockSha256) &&
      /^v24\./.test(b.node),
    'INVALID_BUILD_EVIDENCE',
  );
  validateZip(bytes);
  return {
    ...(input.artifactType === undefined ? {} : { artifactType: type }),
    operationId: input.operationId,
    artifactId: input.artifactId,
    approvalReference: input.approvalReference,
    sourceCommit: input.sourceCommit,
    sha256: input.sha256,
    bytes: input.bytes,
    buildEvidence: structuredClone(b),
  };
}
function loadCandidate(input, root = path.resolve(__dirname, '../..')) {
  const file = path.join(
    fs.realpathSync(root),
    ARTIFACT_PATHS[artifactType(input)],
  );
  requireThat(fs.realpathSync(file) === file, 'UNEXPECTED_ARTIFACT_PATH');
  const bytes = fs.readFileSync(file);
  const evidenceFile = path.join(path.dirname(file), 'evidence.json');
  requireThat(
    fs.realpathSync(evidenceFile) === evidenceFile,
    'UNEXPECTED_ARTIFACT_PATH',
  );
  const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
  requireThat(
    isDeepStrictEqual(evidence, input.buildEvidence),
    'BUILD_EVIDENCE_CHANGED',
  );
  validateInput(input, bytes);
  return bytes;
}
// fsync the file AND directory. A stale lock is never automatically broken.
function createJournal(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  function syncDir() {
    const fd = fs.openSync(directory, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  function filename(id) {
    requireThat(UUID.test(id), 'INVALID_OPERATION');
    return path.join(directory, id + '.json');
  }
  return {
    acquire(id) {
      const lock = filename(id) + '.lock';
      const fd = fs.openSync(lock, 'wx', 0o600);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      syncDir();
      return () => {
        fs.unlinkSync(lock);
        syncDir();
      };
    },
    load(id) {
      try {
        const data = fs.readFileSync(filename(id));
        requireThat(data.length < 16384, 'RECEIPT_TOO_LARGE');
        return JSON.parse(data);
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
    },
    save(record) {
      const target = filename(record.operationId);
      const tmp = target + '.' + randomUUID() + '.tmp';
      record.updatedAt = new Date().toISOString();
      const data = JSON.stringify(record);
      requireThat(Buffer.byteLength(data) < 16384, 'RECEIPT_TOO_LARGE');
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, data);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, target);
      syncDir();
    },
  };
}
async function verifyConfiguration(adapters, key, identity) {
  const c = await adapters.protection.inspect(key);
  const policy = require('../config/artifact-protection-policy.json');
  const rolePolicy = require('../config/api-artifact-publisher-policy.json');
  requireThat(
    c &&
      isDeepStrictEqual(c.identityPolicy, materializeIdentityPolicy(key)) &&
      isDeepStrictEqual(
        c.permissionsBoundary,
        rolePolicy.permissionsBoundary,
      ) &&
      isDeepStrictEqual(c.trustPolicy, rolePolicy.trustPolicy),
    'PUBLISHER_BOUNDARY_REQUIRED',
  );
  requireThat(
    c &&
      c.approvalReference === identity.approvalReference &&
      c.sha256 === identity.sha256 &&
      c.sourceCommit === identity.sourceCommit &&
      c.key === key &&
      Number.isFinite(Date.parse(c.verifiedAt)) &&
      Date.now() - Date.parse(c.verifiedAt) >= 0 &&
      Date.now() - Date.parse(c.verifiedAt) < 15 * 60 * 1000,
    'FRESH_APPROVAL_EVIDENCE_REQUIRED',
  );
  requireThat(
    c &&
      c.account === ACCOUNT &&
      c.region === 'us-east-2' &&
      c.bucket === BUCKET &&
      c.publisherArn === ROLE,
    'UNAUTHORIZED_PUBLISHER',
  );
  requireThat(
    c.publicationAuthorized === true &&
      c.active === true &&
      isDeepStrictEqual(c.policy, policy),
    'PROTECTION_REQUIRED',
  );
  requireThat(
    c.versioning === 'Enabled' &&
      c.currentOnlyRetention === true &&
      c.noncurrentDays === 30 &&
      c.abortMultipartDays === 1 &&
      c.currentExpiration === false,
    'RETENTION_INVALID',
  );
  requireThat(
    c.kmsKey === KMS && c.bucketKeyEnabled === false,
    'KMS_CONFIGURATION_INVALID',
  );
  const k = await adapters.kms.inspect(KMS);
  requireThat(
    k &&
      k.enabled === true &&
      k.manager === 'AWS' &&
      k.viaService === 's3.us-east-2.amazonaws.com' &&
      k.callerAccount === ACCOUNT &&
      k.contextArn === `arn:aws:s3:::${BUCKET}/${key}`,
    'KMS_CONFIGURATION_INVALID',
  );
}
function newOperationId() {
  return randomUUID();
}
function materializeIdentityPolicy(key) {
  requireThat(
    /^api-releases\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[a-f0-9]{64}\.zip$/.test(
      key,
    ),
    'INVALID_CANDIDATE_KEY',
  );
  return JSON.parse(
    JSON.stringify(
      require('../config/api-artifact-publisher-policy.json')
        .identityPolicyTemplate,
    ).replaceAll('${APPROVED_CANDIDATE_KEY}', key),
  );
}
async function publish(input, dependencies) {
  requireThat(
    dependencies && dependencies.mode === 'mock-only',
    'LIVE_PUBLISHING_DISABLED',
  );
  const { journal, adapters } = dependencies;
  // Caller supplies test adapters. This module cannot instantiate any AWS client.
  requireThat(adapters?.kind === 'mock' && journal, 'MOCK_ADAPTERS_REQUIRED');
  return runPublication(input, dependencies, true);
}
const ISOLATED_APPROVAL = Object.freeze({
  artifactType: 'isolated-catalog',
  artifactId: 'isolated-catalog-1n-d',
  approvalReference: 'owner:1N-D',
  operationId: '5f10ad5a-beb2-405b-bc9f-2a6135f62b38',
  sourceCommit: '85f44867a6c724158fb02bb6923cc48e330a9342',
  sha256: '69e6ec8aeb468e1023b203d0a23e8f33ebfe3ca522c861593570b98e81c78fcb',
  bytes: 2107927,
});
async function publishApprovedIsolatedCatalog(input, dependencies) {
  requireThat(
    dependencies?.mode === 'approved-1n-d' &&
      dependencies.adapters?.kind === 'verified-publisher-role' &&
      dependencies.adapters.s3?.kind === 'aws-dormant' &&
      dependencies.publisherArn === ROLE,
    'EXPLICIT_PUBLISHER_ROLE_REQUIRED',
  );
  requireThat(
    Object.entries(ISOLATED_APPROVAL).every(
      ([key, value]) => input?.[key] === value,
    ) &&
      Object.keys(input).every(
        (key) =>
          key === 'buildEvidence' || Object.hasOwn(ISOLATED_APPROVAL, key),
      ),
    'APPROVED_ARTIFACT_REQUIRED',
  );
  requireThat(
    input.buildEvidence?.lockSha256 ===
      '76ee0b2d071b95814fd726ce113bb14c235e8547be101741f9bbd76898e829ca' &&
      input.buildEvidence?.node === 'v24.19.0',
    'APPROVED_BUILD_REQUIRED',
  );
  return runPublication(input, dependencies, false);
}
async function runPublication(input, dependencies, simulated) {
  return require('./artifact-publication-core.cjs').runPublication(
    input,
    dependencies,
    simulated,
    {
      validateInput,
      loadCandidate,
      verifyConfiguration,
      keyFor: (value) =>
        `api-releases/${value.operationId}/${value.sha256}.zip`,
      publisherArn: ROLE,
      BUCKET,
      ACCOUNT,
      KMS,
      validVersionId,
      hash,
    },
  );
}
module.exports = {
  publishApprovedIsolatedCatalog,
  ISOLATED_APPROVAL,
  isolatedArtifactParameters,
  validVersionId,
  crc32,
  newOperationId,
  materializeIdentityPolicy,
  publish,
  createJournal,
  loadCandidate,
  validateInput,
  hash,
  BUCKET,
  ACCOUNT,
  KMS,
  ROLE,
};
if (require.main === module) {
  console.error('LIVE_PUBLISHING_DISABLED: local mock contracts only');
  process.exitCode = 1;
}
