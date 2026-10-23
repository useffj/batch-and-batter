import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { DevelopmentStack } from '../lib/development-stack';
const { sharedCommerceResources, compareTemplates } = require(
  resolve(__dirname, '../../../scripts/compare-templates.cjs'),
);
const {
  proposeTemplate,
  validateRelease,
  validateBaseline,
  buildRelease,
  describeRelease,
  hash,
} = require(resolve(__dirname, '../../../scripts/build-api-release.cjs'));
const synthesized = Template.fromStack(
  new DevelopmentStack(
    new App({ context: { 'aws:cdk:enable-path-metadata': true } }),
    'batch-and-batter-dev',
    {
      environment: 'dev',
      env: { account: '302154194958', region: 'us-east-2' },
    },
  ),
).toJSON();
const additions = sharedCommerceResources();
const policyId = 'ApplicationRoleDefaultPolicy2A2BCE7E';
const api = 'ApplicationApi5D63FF39';
const route = 'HttpApiGETadminproductsF96C398C';
const integration = 'HttpApiGETadminproductsAdminCatalogIntegrationEB82D66E';
const permission =
  'HttpApiGETadminproductsAdminCatalogIntegrationPermission019DC0D5';
// Synthetic baseline: never represented as installed or authenticated evidence.
const baseline = structuredClone(synthesized);
for (const id of Object.keys(additions)) delete baseline.Resources[id];
const catalog = (t: any) =>
  t.Resources[policyId].Properties.PolicyDocument.Statement.find(
    (s: any) => s.Resource?.['Fn::GetAtt']?.[0] === 'CatalogTableF8EA09BD',
  );
catalog(baseline).Action = catalog(baseline).Action.filter(
  (a: string) => a !== 'dynamodb:Scan',
);
const proposed = () => proposeTemplate(baseline, undefined, 'shared-commerce');
test('fixed twelve-resource contract equals CDK output and Catalog-only Scan', () => {
  assert.equal(Object.keys(additions).length, 12);
  for (const [id, resource] of Object.entries(additions))
    assert.deepEqual(resource, synthesized.Resources[id]);
  assert.deepEqual(proposed(), synthesized);
  validateRelease(baseline, proposed(), undefined, 'shared-commerce');
  const scans = synthesized.Resources[
    policyId
  ].Properties.PolicyDocument.Statement.filter((s: any) =>
    [s.Action].flat().includes('dynamodb:Scan'),
  );
  assert.equal(scans.length, 1);
  assert.deepEqual(scans[0].Resource, {
    'Fn::GetAtt': ['CatalogTableF8EA09BD', 'Arn'],
  });
});
test('all five accepted artifacts, financial parameters and other resources preserved', () => {
  const p = proposed();
  assert.deepEqual(p.Parameters, baseline.Parameters);
  assert.equal(p.Parameters.PaymentStartEnabled.Default, 'false');
  let functions = 0;
  for (const [id, resource] of Object.entries(baseline.Resources) as [
    string,
    any,
  ][]) {
    if (id !== policyId) assert.deepEqual(p.Resources[id], resource);
    if (resource.Type === 'AWS::Lambda::Function') functions++;
  }
  assert.equal(functions, 5);
});
const mutations: Record<string, (t: any) => void> = {
  'extra route': (t) => {
    t.Resources.Extra = structuredClone(t.Resources[route]);
  },
  'missing route': (t) => {
    delete t.Resources[route];
  },
  'wrong method': (t) => {
    t.Resources[route].Properties.RouteKey = 'POST /admin/products';
  },
  'anonymous access': (t) => {
    t.Resources[route].Properties.AuthorizationType = 'NONE';
  },
  'missing authorizer': (t) => {
    delete t.Resources[route].Properties.AuthorizerId;
  },
  'wrong authorizer': (t) => {
    t.Resources[route].Properties.AuthorizerId.Ref = 'Other';
  },
  'wrong API': (t) => {
    t.Resources[route].Properties.ApiId.Ref = 'Other';
  },
  'wrong integration': (t) => {
    t.Resources[integration].Properties.IntegrationUri['Fn::GetAtt'][0] =
      'StripeWebhook04C354F4';
  },
  'wrong target': (t) => {
    t.Resources[route].Properties.Target = 'integrations/other';
  },
  'missing permission': (t) => {
    delete t.Resources[permission];
  },
  'wildcard invocation': (t) => {
    t.Resources[permission].Properties.SourceArn = '*';
  },
  'wrong principal': (t) => {
    t.Resources[permission].Properties.Principal = '*';
  },
  'Commerce Scan': (t) => {
    catalog(t).Resource['Fn::GetAtt'][0] = 'CommerceTable6CC80189';
  },
  'Operations Scan': (t) => {
    catalog(t).Resource['Fn::GetAtt'][0] = 'OperationsTable90528792';
  },
  'wildcard IAM': (t) => {
    catalog(t).Resource = '*';
  },
  'extra IAM': (t) => {
    catalog(t).Action.push('dynamodb:*');
  },
  'missing Scan': (t) => {
    catalog(t).Action = catalog(t).Action.filter(
      (a: string) => a !== 'dynamodb:Scan',
    );
  },
  'wrong role': (t) => {
    t.Resources[policyId].Properties.Roles = [{ Ref: 'Other' }];
  },
  'payment parameter': (t) => {
    t.Parameters.PaymentStartEnabled.Default = 'true';
  },
  'financial parameter': (t) => {
    t.Parameters.DevPaymentLedgerNamespace.Default = 'other';
  },
  'worker Code': (t) => {
    t.Resources.PaymentWorkerA754B793.Properties.Code.S3Key = 'other.zip';
  },
  'API Code': (t) => {
    t.Resources[api].Properties.Code.S3Key = 'other.zip';
  },
  environment: (t) => {
    t.Resources[api].Properties.Environment.Variables.PAYMENT_START_ENABLED =
      'true';
  },
  runtime: (t) => {
    t.Resources[api].Properties.Runtime = 'nodejs22.x';
  },
  handler: (t) => {
    t.Resources[api].Properties.Handler = 'other.handler';
  },
  index: (t) => {
    t.Resources.CatalogTableF8EA09BD.Properties.GlobalSecondaryIndexes = [];
  },
  retention: (t) => {
    t.Resources.CatalogTableF8EA09BD.DeletionPolicy = 'Retain';
  },
  replacement: (t) => {
    t.Resources.CatalogTableF8EA09BD.UpdateReplacePolicy = 'Retain';
  },
  queue: (t) => {
    t.Resources.PaymentQueue638550D9.Properties.VisibilityTimeout = 1;
  },
  media: (t) => {
    t.Resources.Media = { Type: 'AWS::S3::Bucket' };
  },
  scheduler: (t) => {
    t.Resources.Schedule = { Type: 'AWS::Scheduler::Schedule' };
  },
  notification: (t) => {
    t.Resources.Notification = { Type: 'AWS::SNS::Topic' };
  },
  metadata: (t) => {
    t.Metadata = { unapproved: true };
  },
};
for (const [name, mutate] of Object.entries(mutations))
  test(`rejects ${name}`, () => {
    const t = proposed();
    mutate(t);
    assert.throws(
      () => validateRelease(baseline, t, undefined, 'shared-commerce'),
      /UNAPPROVED_TEMPLATE_CHANGE/,
    );
  });
test('API-only comparison stays exact; arbitrary modes and unverified candidates rejected', () => {
  compareTemplates(baseline, baseline);
  assert.throws(() => compareTemplates(baseline, proposed()));
  assert.throws(() => proposeTemplate(baseline, undefined, { allowed: '*' }));
  assert.throws(() =>
    proposeTemplate(
      baseline,
      { reviewedForLocalSynthesis: true },
      'shared-commerce',
    ),
  );
  const code = { S3Bucket: 'synthetic', S3Key: 'reviewed.zip' };
  const t = proposed();
  t.Resources[api].Properties.Code = code;
  validateRelease(baseline, t, code, 'shared-commerce');
  const apiOnly = structuredClone(baseline);
  apiOnly.Resources[api].Properties.Code = code;
  validateRelease(baseline, apiOnly, code);
});
test('trusted build anchor cannot be bypassed', () => {
  assert.throws(() => buildRelease({}, undefined, 'shared-commerce'));
  assert.throws(() => buildRelease({}, undefined, { bypass: true }));
});
test('report remains non-deployable, with no candidate and all blockers', () => {
  const report = describeRelease(
    { parameters: [] },
    baseline,
    proposed(),
    undefined,
    'shared-commerce',
  ).report;
  assert.equal(
    report.status,
    'NOT DEPLOYABLE — SEPARATE AUTHORIZATION REQUIRED',
  );
  assert.equal(report.deploymentAuthorized, false);
  assert.equal(report.candidateSha256, null);
  assert.equal(report.publication.overwriteAllowed, false);
  for (const blocker of [
    'DEPLOYMENT_EXECUTOR_NOT_IMPLEMENTED',
    'EXPLICIT_RELEASE_AUTHORIZATION_REQUIRED',
    'FRESH_AUTHENTICATED_BASELINE_REQUIRED_AT_RELEASE',
    'ROLLBACK_ARTIFACT_UNVERIFIED_OR_MISSING',
    'REVIEWED_BOUNDED_SHARED_COMMERCE_CHANGE_SET_REQUIRED',
  ])
    assert.ok(report.blockers.includes(blocker));
});
test('stale and mismatched evidence fail closed', () => {
  const expected = {
    account: 'synthetic',
    region: 'us-east-2',
    stackId: 'synthetic',
    stackName: 'synthetic',
    lastUpdatedTime: 'synthetic',
    templateSha256: hash(baseline),
    maximumEvidenceAgeMs: 900000,
  };
  const snapshot: any = {
    ...expected,
    status: 'UPDATE_COMPLETE',
    retrievedAt: new Date(1000000).toISOString(),
    original: baseline,
    processed: baseline,
    parameters: [],
  };
  delete snapshot.templateSha256;
  delete snapshot.maximumEvidenceAgeMs;
  assert.throws(() => validateBaseline(snapshot, expected, 2000000), /STALE/);
  assert.throws(
    () =>
      validateBaseline(
        { ...snapshot, original: proposed() },
        expected,
        1000000,
      ),
    /BASELINE_TEMPLATE_CHANGED/,
  );
});
test('ordinary full-stack deployment stays blocked without any executor', () => {
  const { assertReleaseAuthorized } = require(
    resolve(__dirname, '../../../scripts/deploy-dev.cjs'),
  );
  assert.throws(
    () =>
      assertReleaseAuthorized({
        authorized: true,
        rollbackArtifactVerified: true,
      }),
    /DEPLOYMENT_BLOCKED.*DEPLOYMENT_EXECUTOR_NOT_IMPLEMENTED/,
  );
});
