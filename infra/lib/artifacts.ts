import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { aws_lambda as lambda, aws_s3 as s3 } from 'aws-cdk-lib';
import { Construct } from 'constructs';

export const identities: Record<string, string> = {
  ApplicationApi5D63FF39: 'handler.handler',
  PaymentWorkerA754B793: 'payment-worker-handler.handler',
  StripeWebhook04C354F4: 'stripe-webhook-handler.handler',
  CartExpiryWorkerD6838A04: 'expiry-worker-handler.handler',
  CartExpiryReconciler320F0954: 'expiry-reconciler-handler.handler',
};
const project = resolve(__dirname, '../../../..');
export type Artifact = {
  logicalId: string;
  handler: string;
  bucket: string;
  key: string;
  sha256: string;
  observedVersion: string;
  provenance: string;
  status: string;
};
function keys(
  value: unknown,
  expected: string[],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== expected.sort().join()
  )
    throw Error('INVALID_ARTIFACT_SCHEMA');
}
export function validateManifest(value: unknown): Record<string, Artifact> {
  keys(value, ['schemaVersion', 'account', 'region', 'functions']);
  if (
    value.schemaVersion !== 1 ||
    value.account !== '302154194958' ||
    value.region !== 'us-east-2' ||
    !Array.isArray(value.functions) ||
    value.functions.length !== 5
  )
    throw Error('INVALID_ARTIFACT_MANIFEST');
  const result: Record<string, Artifact> = {};
  for (const raw of value.functions) {
    keys(raw, [
      'logicalId',
      'handler',
      'bucket',
      'key',
      'sha256',
      'observedVersion',
      'provenance',
      'status',
    ]);
    if (
      Object.values(raw).some(
        (v) => typeof v !== 'string' || !v || /[\r\n]/.test(v),
      )
    )
      throw Error('INVALID_ARTIFACT_RECORD');
    const record = raw as Artifact;
    if (
      !Object.hasOwn(identities, record.logicalId) ||
      Object.hasOwn(result, record.logicalId) ||
      identities[record.logicalId] !== record.handler ||
      record.bucket !== 'cdk-hnb659fds-assets-302154194958-us-east-2' ||
      !/^[a-f0-9]{64}$/.test(record.sha256) ||
      !/^[A-Za-z0-9/_-]+\.zip$/.test(record.key) ||
      record.key.includes('..') ||
      !record.key.endsWith(record.sha256 + '.zip') ||
      record.status !== 'accepted-deployed-reference'
    )
      throw Error('INVALID_ARTIFACT_RECORD');
    result[record.logicalId] = record;
  }
  return result;
}
export function acceptedArtifacts() {
  return validateManifest(
    JSON.parse(
      readFileSync(
        resolve(project, 'infra/config/dev-lambda-artifacts.json'),
        'utf8',
      ),
    ),
  );
}
export function acceptedCode(logicalId: string) {
  const record = acceptedArtifacts()[logicalId];
  if (!record) throw Error('UNKNOWN_LAMBDA_IDENTITY');
  return { S3Bucket: record.bucket, S3Key: record.key };
}
export function verifyApiCandidate(value: unknown) {
  keys(value, [
    'logicalId',
    'account',
    'region',
    'sha256',
    'reviewedForLocalSynthesis',
  ]);
  if (
    value.logicalId !== 'ApplicationApi5D63FF39' ||
    value.account !== '302154194958' ||
    value.region !== 'us-east-2' ||
    value.reviewedForLocalSynthesis !== true ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  )
    throw Error('INVALID_API_OVERRIDE');
  const file = resolve(project, 'backend/dist/api-release/api.zip');
  if (realpathSync(file) !== file) throw Error('INVALID_API_ARTIFACT_PATH');
  const bytes = readFileSync(file);
  const evidence = JSON.parse(
    readFileSync(
      resolve(project, 'backend/dist/api-release/evidence.json'),
      'utf8',
    ),
  );
  if (
    bytes.readUInt32LE(0) !== 0x04034b50 ||
    createHash('sha256').update(bytes).digest('hex') !== value.sha256 ||
    evidence.sha256 !== value.sha256 ||
    evidence.handler !== 'handler.handler' ||
    JSON.stringify(evidence.files) !== '["handler.js"]'
  )
    throw Error('API_ARTIFACT_HASH_OR_CONTENT_MISMATCH');
  return file;
}
export function artifactCode(
  scope: Construct,
  logicalId: string,
  handler: string,
): lambda.Code {
  const record = acceptedArtifacts()[logicalId];
  if (!record || record.handler !== handler)
    throw Error('LAMBDA_IDENTITY_MISMATCH');
  const context = scope.node.tryGetContext('apiArtifact');
  const override = typeof context === 'string' ? JSON.parse(context) : context;
  if (override !== undefined) verifyApiCandidate(override);
  if (logicalId === 'ApplicationApi5D63FF39' && override !== undefined)
    return lambda.Code.fromAsset(verifyApiCandidate(override));
  // Observed versions are provenance only: preserve deployed Code shape exactly.
  const bucket = s3.Bucket.fromBucketName(
    scope,
    logicalId + 'AcceptedArtifactBucket',
    record.bucket,
  );
  return lambda.Code.fromBucket(bucket, record.key);
}
