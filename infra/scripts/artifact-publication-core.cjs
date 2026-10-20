'use strict';
// Shared journal/reconciliation state machine. No SDK or credential discovery.
const { isDeepStrictEqual } = require('node:util');
function requireThat(value, code) {
  if (!value) throw Error(code);
}
function text(value) {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)
  );
}
async function runPublication(input, dependencies, simulated, contract) {
  const {
    validateInput,
    loadCandidate,
    verifyConfiguration,
    keyFor,
    publisherArn,
    BUCKET,
    ACCOUNT,
    KMS,
    validVersionId,
    hash,
  } = contract;
  const { journal, adapters } = dependencies;
  const bytes = Buffer.from(dependencies.bytes ?? loadCandidate(input));
  const identity = validateInput(input, bytes);
  input = identity;
  const release = journal.acquire(input.operationId);
  try {
    let record = journal.load(input.operationId);
    if (record) {
      requireThat(
        record.operationId === input.operationId &&
          record.publisherArn === publisherArn,
        'INVALID_RECEIPT_IDENTITY',
      );
      requireThat(
        (record.versionId === null || validVersionId(record.versionId)) &&
          (!['WRITTEN', 'VERIFIED'].includes(record.state) ||
            validVersionId(record.versionId)),
        'INVALID_RECEIPT_VERSION',
      );
      requireThat(
        [
          'PREPARED',
          'ATTEMPTED',
          'WRITTEN',
          'VERIFIED',
          'UNCERTAIN',
          'COLLISION',
        ].includes(record.state) &&
          record.simulated === simulated &&
          record.deploymentAuthorized === false,
        'INVALID_RECEIPT',
      );
      requireThat(
        isDeepStrictEqual(record.identity, identity) &&
          record.key === keyFor(input) &&
          record.bucket === BUCKET,
        'OPERATION_IDENTITY_CHANGED',
      );
    } else {
      record = {
        operationId: input.operationId,
        identity,
        bucket: BUCKET,
        key: keyFor(input),
        state: 'PREPARED',
        versionId: null,
        deploymentAuthorized: false,
        simulated,
        publisherArn,
        createdAt: new Date().toISOString(),
      };
      journal.save(record);
    }
    requireThat(
      !['REJECTED', 'COLLISION'].includes(record.state),
      'OPERATION_REJECTED',
    );
    await verifyConfiguration(adapters, record.key, identity);
    const request = {
      Bucket: BUCKET,
      Key: record.key,
      ExpectedBucketOwner: ACCOUNT,
    };
    async function history() {
      // Adapter must fully paginate and return ONLY the exact requested key.
      const h = await adapters.s3.history(request);
      requireThat(
        h.complete === true &&
          Array.isArray(h.versions) &&
          Array.isArray(h.deleteMarkers),
        'HISTORY_INCOMPLETE',
      );
      requireThat(
        h.deleteMarkers.length === 0 &&
          h.versions.length <= 1 &&
          h.versions.every(
            (v) =>
              v.Key === record.key &&
              v.IsLatest === true &&
              validVersionId(v.VersionId),
          ),
        'UNSAFE_VERSION_HISTORY',
      );
      return h.versions[0];
    }
    async function reconcile(version) {
      requireThat(
        version &&
          (record.versionId === null || record.versionId === version.VersionId),
        'VERSION_MISMATCH',
      );
      const got = await adapters.s3.get({
        ...request,
        VersionId: version.VersionId,
      });
      requireThat(
        validVersionId(got.VersionId) &&
          got.VersionId === version.VersionId &&
          got.Metadata?.operation === input.operationId &&
          got.Metadata?.source === input.sourceCommit,
        'VERSION_OR_PROVENANCE_MISMATCH',
      );
      requireThat(
        got.ServerSideEncryption === 'aws:kms' &&
          got.SSEKMSKeyId === KMS &&
          got.BucketKeyEnabled !== true,
        'ENCRYPTION_MISMATCH',
      );
      requireThat(
        Buffer.isBuffer(got.Body) &&
          got.Body.length === input.bytes &&
          hash(got.Body) === input.sha256,
        'READBACK_MISMATCH',
      );
      const current = await adapters.s3.head(request);
      requireThat(
        validVersionId(current.VersionId) &&
          current.VersionId === version.VersionId &&
          !current.DeleteMarker,
        'CURRENT_VERSION_MISMATCH',
      );
      requireThat(
        (await history())?.VersionId === version.VersionId,
        'CURRENT_VERSION_MISMATCH',
      );
      record.versionId = version.VersionId;
      record.state = 'VERIFIED';
      record.deploymentAuthorized = false;
      journal.save(record);
      return structuredClone(record);
    }
    try {
      const existing = await history();
      if (existing) {
        if (record.state === 'PREPARED') {
          record.state = 'COLLISION';
          journal.save(record);
          throw Error('EXISTING_KEY_COLLISION');
        }
        return await reconcile(existing);
      }
      // Ambiguous or completed operations never automatically perform another PUT.
      requireThat(record.state === 'PREPARED', 'RECONCILIATION_REQUIRED');
      record.state = 'ATTEMPTED';
      journal.save(record);
      let result;
      try {
        result = await adapters.s3.put({
          ...request,
          Body: Buffer.from(bytes),
          IfNoneMatch: '*',
          ChecksumSHA256: Buffer.from(input.sha256, 'hex').toString('base64'),
          ServerSideEncryption: 'aws:kms',
          SSEKMSKeyId: KMS,
          BucketKeyEnabled: false,
          Metadata: {
            operation: input.operationId,
            source: input.sourceCommit,
          },
        });
      } catch (e) {
        record.state = e.statusCode === 412 ? 'COLLISION' : 'UNCERTAIN';
        journal.save(record);
        if (e.statusCode === 412) throw Error('PRECONDITION_FAILED');
        // Never propagate SDK messages, credentials, URLs or response bodies.
        throw Error(
          e.statusCode === 409
            ? 'CONFLICT_RECONCILIATION_REQUIRED'
            : 'ACKNOWLEDGEMENT_UNCERTAIN',
        );
      }
      requireThat(validVersionId(result.VersionId), 'VERSION_REQUIRED');
      record.requestId = text(result.RequestId) ? result.RequestId : null;
      record.versionId = result.VersionId;
      record.state = 'WRITTEN';
      journal.save(record);
      return await reconcile(await history());
    } catch (e) {
      // Preserve the original key/version even when read-back or identity checks fail.
      if (record.state !== 'COLLISION') {
        record.state = 'UNCERTAIN';
        journal.save(record);
      }
      throw e;
    }
  } finally {
    release();
  }
}
module.exports = { runPublication };
