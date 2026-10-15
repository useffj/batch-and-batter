import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { acceptedArtifacts } from '../lib/artifacts';
const {
  hash,
  validateBaseline,
  validateRelease,
  proposeTemplate,
  deploymentBlockers,
} = require(resolve(__dirname, '../../../scripts/build-api-release.cjs'));
const root = resolve(__dirname, '../../../..');
const artifacts = acceptedArtifacts();
const baseline: ReturnType<typeof proposeTemplate> = {
  Parameters: {
    StripeSandboxAccountId: {
      Type: 'String',
      Default: 'acct_synthetic',
      AllowedValues: ['acct_synthetic'],
    },
    DevPaymentLedgerNamespace: {
      Type: 'String',
      Default: 'dev:acct_synthetic',
      AllowedValues: ['dev:acct_synthetic'],
    },
    DevPaymentLedgerAccountId: {
      Type: 'String',
      Default: 'acct_synthetic',
      AllowedValues: ['acct_synthetic'],
    },
    PaymentStartEnabled: {
      Type: 'String',
      Default: 'false',
      AllowedValues: ['false'],
    },
  },
  Resources: {
    ...Object.fromEntries(
      Object.entries(artifacts).map(([id, r]) => [
        id,
        {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Code: { S3Bucket: r.bucket, S3Key: r.key },
            Handler: r.handler,
            Runtime: 'nodejs24.x',
            Environment: { Variables: { PAYMENT_START_ENABLED: 'false' } },
          },
          Metadata: { 'aws:asset:path': 'synthetic-preserved' },
          DependsOn: ['ExistingPolicy'],
        },
      ]),
    ),
    AdminStorefrontAssignmentRoute: {
      Type: 'AWS::ApiGatewayV2::Route',
      Properties: {
        RouteKey: 'GET /admin/storefront/assignment',
        AuthorizationType: 'JWT',
      },
    },
    ExistingPolicy: {
      Type: 'AWS::IAM::Policy',
      Properties: { PolicyDocument: { Statement: [] } },
    },
  },
  Metadata: { purpose: 'synthetic preservation fixture' },
};
const now = Date.parse('2026-10-15T06:00:00Z');
const expected = {
  account: '302154194958',
  region: 'us-east-2',
  stackName: 'batch-and-batter-dev',
  stackId: 'synthetic-stack-id',
  lastUpdatedTime: '2026-10-13T23:11:44Z',
  templateSha256: hash(baseline),
  maximumEvidenceAgeMs: 900000,
};
const snapshot = {
  account: expected.account,
  region: expected.region,
  stackName: expected.stackName,
  stackId: expected.stackId,
  lastUpdatedTime: expected.lastUpdatedTime,
  status: 'UPDATE_COMPLETE',
  retrievedAt: new Date(now).toISOString(),
  original: baseline,
  processed: structuredClone(baseline),
  parameters: Object.entries(
    baseline.Parameters as Record<string, { Default: string }>,
  ).map(([ParameterKey, d]) => ({ ParameterKey, ParameterValue: d.Default })),
};
const evidence = JSON.parse(
  readFileSync(resolve(root, 'backend/dist/api-release/evidence.json'), 'utf8'),
);
const releaseId = '00000000-0000-4000-8000-000000000001';
const candidate = {
  logicalId: 'ApplicationApi5D63FF39',
  account: '302154194958',
  region: 'us-east-2',
  sha256: evidence.sha256,
  reviewedForLocalSynthesis: true,
  releaseId,
  destinationBucket: 'cdk-hnb659fds-assets-302154194958-us-east-2',
  destinationKey: `api-releases/${releaseId}/${evidence.sha256}.zip`,
};
test('A: no-change proposal preserves the complete template', () => {
  assert.deepEqual(validateBaseline(snapshot, expected, now), baseline);
  assert.deepEqual(proposeTemplate(baseline), baseline);
});
test('B: verified API bytes change exactly Code while preserving parameters, metadata and all workers', () => {
  const copy = structuredClone(baseline);
  const proposed = proposeTemplate(baseline, candidate);
  assert.deepEqual(baseline, copy);
  const code = proposed.Resources.ApplicationApi5D63FF39.Properties.Code;
  assert.notDeepEqual(
    code,
    baseline.Resources.ApplicationApi5D63FF39.Properties.Code,
  );
  assert.equal(validateRelease(baseline, proposed, code), true);
  proposed.Resources.ApplicationApi5D63FF39.Properties.Code =
    copy.Resources.ApplicationApi5D63FF39.Properties.Code;
  assert.deepEqual(proposed, baseline);
});
const mutations: Array<
  [string, (t: ReturnType<typeof proposeTemplate>) => void]
> = [
  [
    'C: worker Code',
    (t) =>
      (t.Resources.PaymentWorkerA754B793.Properties.Code.S3Key = 'wrong.zip'),
  ],
  [
    'D: payment parameter',
    (t) => t.Parameters.PaymentStartEnabled.AllowedValues.push('true'),
  ],
  [
    'E: extra route',
    (t) => (t.Resources.ExtraRoute = { Type: 'AWS::ApiGatewayV2::Route' }),
  ],
  [
    'F: removed assignment',
    (t) => delete t.Resources.AdminStorefrontAssignmentRoute,
  ],
  [
    'G: IAM policy',
    (t) =>
      t.Resources.ExistingPolicy.Properties.PolicyDocument.Statement.push({
        Effect: 'Allow',
        Action: '*',
        Resource: '*',
      }),
  ],
  [
    'H: Lambda metadata',
    (t) => (t.Resources.PaymentWorkerA754B793.Metadata = {}),
  ],
  [
    'worker environment',
    (t) => (t.Resources.PaymentWorkerA754B793.Properties.Environment = {}),
  ],
  [
    'API runtime',
    (t) => (t.Resources.ApplicationApi5D63FF39.Properties.Runtime = 'other'),
  ],
  [
    'resource dependencies',
    (t) => (t.Resources.ApplicationApi5D63FF39.DependsOn = []),
  ],
  ['top-level metadata', (t) => (t.Metadata = {})],
];
for (const [name, mutate] of mutations)
  test(name + ' is rejected', () => {
    const proposed = proposeTemplate(baseline, candidate);
    const code = structuredClone(
      proposed.Resources.ApplicationApi5D63FF39.Properties.Code,
    );
    mutate(proposed);
    assert.throws(() => validateRelease(baseline, proposed, code));
  });
test('I: invalid candidate hash and unsafe destinations fail closed', () => {
  for (const patch of [
    { sha256: '0'.repeat(64) },
    { destinationKey: artifacts.ApplicationApi5D63FF39.key },
    { destinationBucket: 'other' },
    { releaseId: 'not-uuid' },
    { path: '/tmp/other.zip' },
    { reviewedForLocalSynthesis: false },
    { logicalId: 'PaymentWorkerA754B793' },
  ])
    assert.throws(() => proposeTemplate(baseline, { ...candidate, ...patch }));
});
test('J: stale, changed, incomplete or wrong-environment evidence is rejected', () => {
  for (const patch of [
    { retrievedAt: new Date(now - 900001).toISOString() },
    { retrievedAt: 'invalid' },
    { retrievedAt: new Date(now + 1).toISOString() },
    { stackId: 'other' },
    { region: 'us-east-1' },
    { lastUpdatedTime: 'changed' },
    { status: 'UPDATE_IN_PROGRESS' },
    { original: {} },
    { processed: {} },
    { parameters: [] },
  ])
    assert.throws(() =>
      validateBaseline({ ...snapshot, ...patch }, expected, now),
    );
  const changed = structuredClone(snapshot);
  changed.parameters.find(
    (p) => p.ParameterKey === 'PaymentStartEnabled',
  )!.ParameterValue = 'true';
  assert.throws(() => validateBaseline(changed, expected, now));
});
test('K: missing rollback artifact rejects eligibility; no flags can enable deployment', () => {
  assert.ok(
    deploymentBlockers().includes('ROLLBACK_ARTIFACT_UNVERIFIED_OR_MISSING'),
  );
  assert.ok(
    deploymentBlockers({ rollbackArtifactVerified: false }).includes(
      'ROLLBACK_ARTIFACT_UNVERIFIED_OR_MISSING',
    ),
  );
  assert.ok(
    deploymentBlockers({ rollbackArtifactVerified: true }).includes(
      'DEPLOYMENT_EXECUTOR_NOT_IMPLEMENTED',
    ),
  );
});
test('accepted manifest/code disagreement and no-op API release are rejected', () => {
  const bad = structuredClone(baseline);
  bad.Resources.PaymentWorkerA754B793.Properties.Code.S3Key = 'different.zip';
  assert.throws(() => proposeTemplate(bad, candidate));
  assert.throws(() =>
    validateRelease(
      baseline,
      baseline,
      baseline.Resources.ApplicationApi5D63FF39.Properties.Code,
    ),
  );
});
