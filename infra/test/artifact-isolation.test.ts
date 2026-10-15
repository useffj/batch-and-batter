import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { DevelopmentStack } from '../lib/development-stack';
import {
  acceptedArtifacts,
  acceptedCode,
  identities,
  validateManifest,
  verifyApiCandidate,
} from '../lib/artifacts';
const root = resolve(__dirname, '../../../..');
const { compareTemplates } = require(
  resolve(root, 'infra/scripts/compare-templates.cjs'),
);
const manifest = JSON.parse(
  readFileSync(resolve(root, 'infra/config/dev-lambda-artifacts.json'), 'utf8'),
);
const evidence = JSON.parse(
  readFileSync(resolve(root, 'backend/dist/api-release/evidence.json'), 'utf8'),
);
const override = {
  logicalId: 'ApplicationApi5D63FF39',
  account: '302154194958',
  region: 'us-east-2',
  sha256: evidence.sha256,
  reviewedForLocalSynthesis: true,
};
function synth(apiArtifact?: unknown) {
  return Template.fromStack(
    new DevelopmentStack(
      new App({ context: apiArtifact === undefined ? {} : { apiArtifact } }),
      'batch-and-batter-dev',
      {
        environment: 'dev',
        env: { account: '302154194958', region: 'us-east-2' },
      },
    ),
  ).toJSON();
}
const baseline = synth();
test('manifest rejects missing, duplicate, unexpected and malformed identities and metadata', () => {
  assert.equal(Object.keys(acceptedArtifacts()).length, 5);
  const mutations = [
    (m: typeof manifest) => m.functions.pop(),
    (m: typeof manifest) => (m.functions[1] = m.functions[0]),
    (m: typeof manifest) => (m.functions[0].logicalId = 'Other'),
    (m: typeof manifest) => delete m.functions[0].observedVersion,
    (m: typeof manifest) => (m.functions[0].sha256 = 'bad'),
    (m: typeof manifest) => (m.functions[0].key = '../bad.zip'),
    (m: typeof manifest) => (m.functions[0].handler = 'wrong.handler'),
    (m: typeof manifest) => (m.region = 'us-east-1'),
    (m: typeof manifest) => (m.functions[0].extra = true),
  ];
  for (const mutate of mutations) {
    const m = structuredClone(manifest);
    mutate(m);
    assert.throws(() => validateManifest(m));
  }
});
test('default selects exact accepted Code with five stable identities and payment/media off', () => {
  const functions = Object.entries(baseline.Resources).filter(
    ([, r]) => (r as { Type: string }).Type === 'AWS::Lambda::Function',
  );
  assert.deepEqual(
    functions.map(([id]) => id).sort(),
    Object.keys(identities).sort(),
  );
  for (const [id, handler] of Object.entries(identities)) {
    assert.deepEqual(baseline.Resources[id].Properties.Code, acceptedCode(id));
    assert.equal(baseline.Resources[id].Properties.Handler, handler);
    assert.equal(
      'S3ObjectVersion' in baseline.Resources[id].Properties.Code,
      false,
    );
  }
  assert.equal(baseline.Parameters.PaymentStartEnabled.Default, 'false');
  assert.equal(
    baseline.Resources.ApplicationApi5D63FF39.Properties.Environment.Variables
      .MEDIA_PROCESSOR_FUNCTION_NAME,
    undefined,
  );
  assert.equal(
    baseline.Resources.ApplicationApi5D63FF39.Properties.Environment.Variables
      .MEDIA_UPLOADS_ENABLED,
    undefined,
  );
});
test('API candidate is explicit, fixed-path and hash verified; invalid metadata fails closed', () => {
  assert.ok(
    verifyApiCandidate(override).endsWith('/backend/dist/api-release/api.zip'),
  );
  for (const value of [
    null,
    {},
    { ...override, path: '/tmp/other.zip' },
    { ...override, sha256: '0'.repeat(64) },
    { ...override, logicalId: 'PaymentWorkerA754B793' },
    { ...override, reviewedForLocalSynthesis: false },
    { ...override, region: 'us-east-1' },
  ])
    assert.throws(() => verifyApiCandidate(value));
  assert.throws(() => synth({}));
});
test('API override changes ONLY API Code across the complete template including all IAM and worker configurations', () => {
  const candidate = synth(JSON.stringify(override));
  const code = candidate.Resources.ApplicationApi5D63FF39.Properties.Code;
  assert.notDeepEqual(
    code,
    baseline.Resources.ApplicationApi5D63FF39.Properties.Code,
  );
  assert.equal(compareTemplates(baseline, candidate, code), true);
  assert.throws(() => compareTemplates(baseline, candidate));
});
test('comparison rejects worker Code, environment, IAM, route, and top-level drift', () => {
  const mutations = [
    (t: ReturnType<typeof synth>) =>
      (t.Resources.PaymentWorkerA754B793.Properties.Code.S3Key =
        'unauthorized.zip'),
    (t: ReturnType<typeof synth>) =>
      (t.Resources.PaymentWorkerA754B793.Properties.Environment = {}),
    (t: ReturnType<typeof synth>) =>
      (t.Resources.UnapprovedPolicy = { Type: 'AWS::IAM::Policy' }),
    (t: ReturnType<typeof synth>) =>
      (t.Resources.UnapprovedRoute = { Type: 'AWS::ApiGatewayV2::Route' }),
    (t: ReturnType<typeof synth>) => (t.Outputs = {}),
  ];
  for (const mutate of mutations) {
    const t = structuredClone(baseline);
    mutate(t);
    assert.throws(() => compareTemplates(baseline, t));
  }
  assert.equal(compareTemplates(baseline, structuredClone(baseline)), true);
});
test('future media additions require a separately reviewed comparison contract; not implemented scenario C', () => {
  const t = structuredClone(baseline);
  t.Resources.FutureProcessor = {
    Type: 'AWS::Lambda::Function',
    Properties: { Code: { S3Bucket: 'future', S3Key: 'separate.zip' } },
  };
  assert.throws(() => compareTemplates(baseline, t));
});
test('ordinary deployment entrypoint rejects even supplied arguments without executing a release', () => {
  for (const args of [[], ['--payment-start-enabled=true'], ['--force']]) {
    const result = spawnSync(
      process.execPath,
      [resolve(root, 'infra/scripts/deploy-dev.cjs'), ...args],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /DEPLOYMENT_BLOCKED/);
    assert.equal(result.stdout, '');
  }
});

test('offline app pins the approved region despite CDK ambient fallback', () => {
  const out = mkdtempSync(resolve(tmpdir(), 'bb-offline-target-'));
  try {
    const result = spawnSync(
      process.execPath,
      [resolve(root, 'infra/dist/infra/bin/app.js')],
      {
        cwd: out,
        env: {
          ...process.env,
          CDK_DEFAULT_ACCOUNT: '302154194958',
          CDK_DEFAULT_REGION: 'us-east-1',
          CDK_OUTDIR: out,
        },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const assembly = JSON.parse(
      readFileSync(resolve(out, 'manifest.json'), 'utf8'),
    );
    assert.equal(
      assembly.artifacts['batch-and-batter-dev'].environment,
      'aws://302154194958/us-east-2',
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
