// Dormant adapter: no client construction or credential discovery on import.
// The generic publisher remains mock-only; only the fixed 1N-D entrypoint opts in.
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const {
  BUCKET,
  ACCOUNT,
  KMS,
  materializeIdentityPolicy,
} = require('./publish-api-artifact.cjs');
const validVersion = (v) =>
  typeof v === 'string' &&
  v !== 'null' &&
  v.length > 0 &&
  v.isWellFormed() &&
  Buffer.byteLength(v) <= 1024;
function check(value, code) {
  if (!value) throw Error(code);
}
function createAdapter(
  { key, sha256, bytes, credentials, requestHandler } = {},
  validateKey = materializeIdentityPolicy,
  validateSession = () => {},
) {
  validateKey(key, sha256, bytes);
  validateSession();
  check(
    /^[a-f0-9]{64}$/.test(sha256) && key.endsWith('/' + sha256 + '.zip'),
    'INVALID_HASH',
  );
  check(
    Number.isSafeInteger(bytes) && bytes > 0 && bytes <= 50 * 1024 * 1024,
    'INVALID_SIZE',
  );
  check(
    credentials &&
      typeof credentials !== 'function' &&
      ['accessKeyId', 'secretAccessKey', 'sessionToken'].every(
        (k) => typeof credentials[k] === 'string' && credentials[k].length > 0,
      ),
    'EXPLICIT_SESSION_CREDENTIALS_REQUIRED',
  );
  check(
    requestHandler && typeof requestHandler.handle === 'function',
    'EXPLICIT_TRANSPORT_REQUIRED',
  );
  // Reuse the repository's pinned SDK, without a second dependency graph.
  const sdk = require('../../backend/node_modules/@aws-sdk/client-s3');
  const client = new sdk.S3Client({
    region: 'us-east-2',
    credentials: { ...credentials },
    endpoint: 'https://s3.us-east-2.amazonaws.com',
    requestHandler: {
      async handle(request, options) {
        const result = await requestHandler.handle(request, options);
        const source = result.response.body;
        const limit =
          request.method === 'GET' && request.query?.versionId
            ? bytes
            : 2 * 1024 * 1024;
        if (source && typeof source[Symbol.asyncIterator] === 'function') {
          result.response.body = Readable.from(
            (async function* () {
              let size = 0;
              const timer = setTimeout(
                () => source.destroy?.(new Error('RESPONSE_TIMEOUT')),
                30000,
              );
              try {
                for await (const chunk of source) {
                  size += chunk.length;
                  check(size <= limit, 'RESPONSE_TOO_LARGE');
                  yield chunk;
                }
              } finally {
                clearTimeout(timer);
                source.destroy?.();
              }
            })(),
          );
        } else {
          check(
            source == null || source.byteLength <= limit,
            'RESPONSE_TOO_LARGE',
          );
        }
        return result;
      },
      destroy() {
        requestHandler.destroy?.();
      },
    },
    maxAttempts: 1,
    followRegionRedirects: false,
  });
  const base = { Bucket: BUCKET, Key: key, ExpectedBucketOwner: ACCOUNT };
  function identity(r) {
    check(
      r &&
        r.Bucket === BUCKET &&
        r.Key === key &&
        r.ExpectedBucketOwner === ACCOUNT,
      'REQUEST_IDENTITY_MISMATCH',
    );
  }
  async function send(command) {
    validateSession();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      return await client.send(command, { abortSignal: controller.signal });
    } catch (e) {
      const status = e?.$metadata?.httpStatusCode;
      const code =
        status === 412
          ? 'PRECONDITION_FAILED'
          : status === 409
            ? 'CONFLICT_RECONCILIATION_REQUIRED'
            : status === 403
              ? 'AUTHORIZATION_FAILED'
              : 'AWS_REQUEST_UNCERTAIN';
      const error = new Error(code);
      if (status === 409 || status === 412 || status === 403)
        error.statusCode = status;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    kind: 'aws-dormant',
    async put(r) {
      identity(r);
      const allowed = [
        ...Object.keys(base),
        'Body',
        'IfNoneMatch',
        'ChecksumSHA256',
        'ServerSideEncryption',
        'SSEKMSKeyId',
        'BucketKeyEnabled',
        'Metadata',
      ];
      check(
        Object.keys(r).every((k) => allowed.includes(k)),
        'UNAPPROVED_PUT_FIELD',
      );
      const captured = Buffer.from(r.Body || []);
      check(
        captured.length === bytes &&
          createHash('sha256').update(captured).digest('hex') === sha256,
        'BODY_MISMATCH',
      );
      check(
        r.IfNoneMatch === '*' &&
          r.ChecksumSHA256 === Buffer.from(sha256, 'hex').toString('base64') &&
          r.ServerSideEncryption === 'aws:kms' &&
          r.SSEKMSKeyId === KMS &&
          r.BucketKeyEnabled === false,
        'PUT_CONTRACT_MISMATCH',
      );
      const operation = key.split('/')[1];
      check(
        r.Metadata &&
          Object.keys(r.Metadata).sort().join() === 'operation,source' &&
          r.Metadata.operation === operation &&
          /^[a-f0-9]{40}$/.test(r.Metadata.source),
        'METADATA_MISMATCH',
      );
      const out = await send(
        new sdk.PutObjectCommand({
          ...base,
          Body: captured,
          IfNoneMatch: '*',
          ChecksumSHA256: r.ChecksumSHA256,
          ServerSideEncryption: 'aws:kms',
          SSEKMSKeyId: KMS,
          BucketKeyEnabled: false,
          Metadata: { ...r.Metadata },
        }),
      );
      check(validVersion(out.VersionId), 'VERSION_REQUIRED');
      return { VersionId: out.VersionId, RequestId: out.$metadata?.requestId };
    },
    async get(r) {
      identity(r);
      check(validVersion(r.VersionId), 'VERSION_REQUIRED');
      const out = await send(
        new sdk.GetObjectCommand({ ...base, VersionId: r.VersionId }),
      );
      const chunks = [];
      let size = 0;
      const timer = setTimeout(
        () => out.Body?.destroy?.(new Error('READ_TIMEOUT')),
        30000,
      );
      try {
        check(
          out.ContentLength === bytes &&
            out.VersionId === r.VersionId &&
            !out.DeleteMarker,
          'READBACK_IDENTITY_MISMATCH',
        );
        check(
          out.ServerSideEncryption === 'aws:kms' &&
            out.SSEKMSKeyId === KMS &&
            out.BucketKeyEnabled !== true,
          'ENCRYPTION_MISMATCH',
        );
        check(
          out.Body && typeof out.Body[Symbol.asyncIterator] === 'function',
          'STREAM_REQUIRED',
        );
        for await (const chunk of out.Body) {
          size += chunk.length;
          check(size <= bytes, 'READBACK_TOO_LARGE');
          chunks.push(Buffer.from(chunk));
        }
        const body = Buffer.concat(chunks);
        check(
          size === bytes &&
            createHash('sha256').update(body).digest('hex') === sha256,
          'READBACK_MISMATCH',
        );
        return {
          Body: body,
          VersionId: out.VersionId,
          Metadata: out.Metadata,
          ServerSideEncryption: out.ServerSideEncryption,
          SSEKMSKeyId: out.SSEKMSKeyId,
          BucketKeyEnabled: out.BucketKeyEnabled,
        };
      } catch {
        throw Error('READBACK_UNVERIFIED');
      } finally {
        clearTimeout(timer);
        out.Body?.destroy?.();
      }
    },
    async head(r) {
      identity(r);
      const out = await send(new sdk.HeadObjectCommand(base));
      check(
        validVersion(out.VersionId) && !out.DeleteMarker,
        'CURRENT_VERSION_INVALID',
      );
      return { VersionId: out.VersionId, DeleteMarker: out.DeleteMarker };
    },
    async history(r) {
      identity(r);
      const versions = [],
        deleteMarkers = [],
        seen = new Set();
      let KeyMarker, VersionIdMarker;
      for (let page = 0; page < 100; page++) {
        const out = await send(
          new sdk.ListObjectVersionsCommand({
            Bucket: BUCKET,
            Prefix: key,
            ExpectedBucketOwner: ACCOUNT,
            MaxKeys: 100,
            KeyMarker,
            VersionIdMarker,
          }),
        );
        check(
          typeof out.IsTruncated === 'boolean',
          'HISTORY_COMPLETENESS_REQUIRED',
        );
        for (const v of out.Versions || [])
          if (v.Key === key) {
            check(validVersion(v.VersionId), 'VERSION_REQUIRED');
            versions.push({
              Key: v.Key,
              VersionId: v.VersionId,
              IsLatest: v.IsLatest,
            });
          }
        for (const v of out.DeleteMarkers || [])
          if (v.Key === key) {
            check(validVersion(v.VersionId), 'VERSION_REQUIRED');
            deleteMarkers.push({
              Key: v.Key,
              VersionId: v.VersionId,
              IsLatest: v.IsLatest,
            });
          }
        if (!out.IsTruncated)
          return { complete: true, versions, deleteMarkers };
        check(
          typeof out.NextKeyMarker === 'string' &&
            out.NextKeyMarker.startsWith(key) &&
            validVersion(out.NextVersionIdMarker),
          'INVALID_PAGINATION',
        );
        const token = JSON.stringify([
          out.NextKeyMarker,
          out.NextVersionIdMarker,
        ]);
        check(!seen.has(token), 'PAGINATION_LOOP');
        seen.add(token);
        KeyMarker = out.NextKeyMarker;
        VersionIdMarker = out.NextVersionIdMarker;
      }
      throw Error('HISTORY_LIMIT_EXCEEDED');
    },
    destroy() {
      client.destroy();
    },
  };
}
function createS3Adapter(args) {
  return createAdapter(args);
}
function createMediaS3Adapter(args) {
  const descriptors = require('../config/frozen-media-artifacts.json');
  const expected = Object.values(descriptors).find(
    (d) => d.proposedKey === args?.key,
  );
  check(expected, 'UNAPPROVED_MEDIA_KEY');
  // Capture a fixed expiry; caller mutation cannot extend the session.
  const expires = args.credentials?.expiration?.getTime?.();
  const started = Date.now();
  const validateSession = () =>
    check(
      Number.isFinite(expires) &&
        expires > Date.now() &&
        expires - started <= 3600000,
      'SHORT_LIVED_SESSION_REQUIRED',
    );
  const adapter = createAdapter(
    args,
    (key, sha256, bytes) => {
      check(
        key === expected.proposedKey &&
          sha256 === expected.sha256 &&
          bytes === expected.bytes,
        'FROZEN_IDENTITY_MISMATCH',
      );
    },
    validateSession,
  );
  return {
    ...adapter,
    put(request) {
      check(
        request.Metadata?.source === expected.sourceCommit,
        'FROZEN_SOURCE_MISMATCH',
      );
      return adapter.put(request);
    },
  };
}
module.exports = { createS3Adapter, createMediaS3Adapter };
