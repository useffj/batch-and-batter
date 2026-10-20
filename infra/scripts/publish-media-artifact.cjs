'use strict';
// Dormant, exact frozen release only. Import has no AWS/network side effects.
const { isDeepStrictEqual } = require('node:util');
const { inflateRawSync } = require('node:zlib');
const legacy = require('./publish-api-artifact.cjs');
const { proposal, roleArn } = require('./media-publication-policy.cjs');
const { runPublication } = require('./artifact-publication-core.cjs');
const descriptors = require('../config/frozen-media-artifacts.json');
const check = (v, code) => {
  if (!v) throw Error(code);
};
function descriptor(type) {
  check(
    typeof type === 'string' && Object.hasOwn(descriptors, type),
    'UNSUPPORTED_ARTIFACT_TYPE',
  );
  return structuredClone(descriptors[type]);
}
function inspectZip(bytes) {
  check(
    Buffer.isBuffer(bytes) &&
      bytes.length >= 22 &&
      bytes.length <= 50 * 1024 * 1024,
    'INVALID_ZIP',
  );
  const end = bytes.length - 22;
  check(
    bytes.readUInt32LE(end) === 0x06054b50 &&
      bytes.readUInt16LE(end + 20) === 0 &&
      bytes.readUInt32LE(end + 4) === 0,
    'INVALID_ZIP',
  );
  const count = bytes.readUInt16LE(end + 10);
  check(
    count > 0 && count <= 512 && bytes.readUInt16LE(end + 8) === count,
    'INVALID_ZIP',
  );
  let offset = bytes.readUInt32LE(end + 16),
    localEnd = 0,
    total = 0;
  check(offset + bytes.readUInt32LE(end + 12) === end, 'INVALID_ZIP');
  const files = {};
  for (let i = 0; i < count; i++) {
    check(
      offset + 46 <= end && bytes.readUInt32LE(offset) === 0x02014b50,
      'INVALID_ZIP',
    );
    const method = bytes.readUInt16LE(offset + 10),
      packed = bytes.readUInt32LE(offset + 20),
      size = bytes.readUInt32LE(offset + 24);
    const len = bytes.readUInt16LE(offset + 28),
      extra = bytes.readUInt16LE(offset + 30),
      comment = bytes.readUInt16LE(offset + 32),
      local = bytes.readUInt32LE(offset + 42);
    check(offset + 46 + len + extra + comment <= end, 'INVALID_ZIP');
    const raw = bytes.subarray(offset + 46, offset + 46 + len),
      name = raw.toString('utf8');
    check(
      raw.equals(Buffer.from(name)) &&
        /^[A-Za-z0-9@_.+/-]+$/.test(name) &&
        !name.startsWith('/') &&
        !name.split('/').some((p) => p === '..' || p === '' || p === '.') &&
        !Object.hasOwn(files, name),
      'UNSAFE_ZIP_PATH',
    );
    check(
      ((bytes.readUInt32LE(offset + 38) >>> 16) & 0o170000) !== 0o120000 &&
        bytes.readUInt16LE(offset + 8) === 0 &&
        bytes.readUInt16LE(offset + 34) === 0 &&
        [0, 8].includes(method),
      'INVALID_ZIP',
    );
    total += size;
    check(total <= 250 * 1024 * 1024, 'ZIP_TOO_LARGE');
    check(
      local === localEnd &&
        local + 30 <= offset &&
        bytes.readUInt32LE(local) === 0x04034b50,
      'INVALID_ZIP',
    );
    const start =
      local +
      30 +
      bytes.readUInt16LE(local + 26) +
      bytes.readUInt16LE(local + 28);
    check(
      start + packed <= bytes.readUInt32LE(end + 16) &&
        bytes.readUInt16LE(local + 6) === 0 &&
        bytes.readUInt16LE(local + 8) === method &&
        bytes.readUInt32LE(local + 18) === packed &&
        bytes.readUInt32LE(local + 22) === size &&
        bytes.subarray(local + 30, local + 30 + len).equals(raw),
      'INVALID_ZIP',
    );
    const input = bytes.subarray(start, start + packed);
    const data =
      method === 0
        ? input
        : inflateRawSync(input, { maxOutputLength: Math.max(size, 1) });
    check(
      data.length === size &&
        legacy.crc32(data) === bytes.readUInt32LE(offset + 16) &&
        bytes.readUInt32LE(local + 14) === bytes.readUInt32LE(offset + 16),
      'INVALID_ZIP_CRC',
    );
    files[name] = { bytes: size, sha256: legacy.hash(data) };
    localEnd = start + packed;
    offset += 46 + len + extra + comment;
  }
  check(
    offset === end && localEnd === bytes.readUInt32LE(end + 16),
    'INVALID_ZIP',
  );
  return files;
}
function validateInput(input, bytes) {
  const d = descriptor(input.artifactType);
  check(
    isDeepStrictEqual(
      Object.keys(input).sort(),
      [
        'approvalReference',
        'artifactType',
        'bytes',
        'key',
        'operationId',
        'sha256',
        'sourceCommit',
        'sourceTree',
      ].sort(),
    ),
    'UNEXPECTED_INPUT',
  );
  for (const key of [
    'bytes',
    'operationId',
    'sha256',
    'sourceCommit',
    'sourceTree',
  ])
    check(input[key] === d[key], 'FROZEN_IDENTITY_MISMATCH');
  check(input.key === d.proposedKey, 'UNSUPPORTED_KEY');
  check(
    typeof input.approvalReference === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(input.approvalReference),
    'APPROVAL_REQUIRED',
  );
  check(
    bytes.length === d.bytes && legacy.hash(bytes) === d.sha256,
    'FROZEN_BYTES_MISMATCH',
  );
  const files = inspectZip(bytes);
  check(isDeepStrictEqual(files, d.files), 'FROZEN_INVENTORY_MISMATCH');
  if (d.type === 'isolated-media-api')
    check(
      Object.keys(files).length === 1 && Object.hasOwn(files, 'handler.js'),
      'API_FORMAT_REQUIRED',
    );
  else
    check(
      Object.hasOwn(files, 'index.cjs') &&
        Object.hasOwn(
          files,
          'node_modules/@img/sharp-linux-x64/lib/sharp-linux-x64-0.35.5.node',
        ) &&
        Object.hasOwn(
          files,
          'node_modules/@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8.18.7',
        ) &&
        !Object.keys(files).some((n) =>
          /darwin|\/typescript\/|\/esbuild\//.test(n),
        ),
      'NATIVE_PROCESSOR_REQUIRED',
    );
  return structuredClone(input);
}
async function verifyConfiguration(adapters, key, identity) {
  const c = await adapters.protection.inspect(key),
    p = proposal();
  check(
    c &&
      c.account === legacy.ACCOUNT &&
      c.region === 'us-east-2' &&
      c.bucket === legacy.BUCKET &&
      c.publisherArn === roleArn,
    'UNAUTHORIZED_PUBLISHER',
  );
  for (const field of [
    'trustPolicy',
    'identityPolicy',
    'permissionsBoundary',
    'bucketPolicy',
  ])
    check(isDeepStrictEqual(c[field], p[field]), 'PROTECTION_POLICY_MISMATCH');
  check(
    c.publicationAuthorized === true &&
      c.active === true &&
      c.key === key &&
      c.sourceCommit === identity.sourceCommit &&
      c.sha256 === identity.sha256 &&
      c.approvalReference === identity.approvalReference,
    'EXPLICIT_APPROVAL_REQUIRED',
  );
  const age = Date.now() - Date.parse(c.verifiedAt);
  check(
    Number.isFinite(age) && age >= 0 && age < 900000,
    'FRESH_PREFLIGHT_REQUIRED',
  );
  check(
    c.versioning === 'Enabled' &&
      c.currentOnlyRetention === true &&
      c.noncurrentDays === 30 &&
      c.abortMultipartDays === 1 &&
      c.currentExpiration === false,
    'RETENTION_INVALID',
  );
  check(
    c.kmsKey === legacy.KMS && c.bucketKeyEnabled === false,
    'KMS_CONFIGURATION_INVALID',
  );
  const k = await adapters.kms.inspect(legacy.KMS);
  check(
    k &&
      k.enabled === true &&
      k.manager === 'AWS' &&
      k.viaService === 's3.us-east-2.amazonaws.com' &&
      k.callerAccount === legacy.ACCOUNT &&
      k.contextArn === `arn:aws:s3:::${legacy.BUCKET}/${key}`,
    'KMS_CONFIGURATION_INVALID',
  );
}
async function publish(input, dependencies) {
  // No live entrypoint is authorized or supplied in 1N-O.
  check(
    dependencies?.mode === 'mock-only' &&
      dependencies.adapters?.kind === 'mock',
    'LIVE_PUBLISHING_DISABLED',
  );
  check(Buffer.isBuffer(dependencies.bytes), 'EXPLICIT_FROZEN_BYTES_REQUIRED');
  return runPublication(input, dependencies, true, {
    validateInput,
    loadCandidate: () => {
      throw Error('EXPLICIT_FROZEN_BYTES_REQUIRED');
    },
    verifyConfiguration,
    keyFor: (i) => i.key,
    publisherArn: roleArn,
    ...Object.fromEntries(
      ['BUCKET', 'ACCOUNT', 'KMS', 'validVersionId', 'hash'].map((k) => [
        k,
        legacy[k],
      ]),
    ),
  });
}
module.exports = {
  descriptor,
  inspectZip,
  validateInput,
  verifyConfiguration,
  publish,
  createJournal: legacy.createJournal,
};
if (require.main === module) {
  console.error('LIVE_PUBLISHING_DISABLED');
  process.exitCode = 1;
}
