const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { compareTemplates } = require('./compare-templates.cjs');
const anchor = require('../config/api-release-baseline.json');
const API = 'ApplicationApi5D63FF39';
const bucket = 'cdk-hnb659fds-assets-302154194958-us-east-2';
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
function hash(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
function exactKeys(value, names) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== [...names].sort().join()
  )
    throw Error('INVALID_RELEASE_SCHEMA');
}
// The expected anchor is trusted reviewed configuration, not evidence supplied by the caller.
// Tests exercise this pure validator with synthetic anchors; the CLI cannot override its anchor.
function validateBaseline(snapshot, expected, now = Date.now()) {
  exactKeys(snapshot, [
    'account',
    'region',
    'stackId',
    'stackName',
    'lastUpdatedTime',
    'status',
    'retrievedAt',
    'original',
    'processed',
    'parameters',
  ]);
  for (const k of [
    'account',
    'region',
    'stackId',
    'stackName',
    'lastUpdatedTime',
  ])
    if (snapshot[k] !== expected[k]) throw Error('STALE_OR_WRONG_BASELINE');
  const age = now - Date.parse(snapshot.retrievedAt);
  if (
    !Number.isFinite(age) ||
    age < 0 ||
    age > expected.maximumEvidenceAgeMs ||
    snapshot.status !== 'UPDATE_COMPLETE'
  )
    throw Error('STALE_OR_UNSTABLE_BASELINE');
  if (
    hash(snapshot.original) !== expected.templateSha256 ||
    hash(snapshot.processed) !== expected.templateSha256
  )
    throw Error('BASELINE_TEMPLATE_CHANGED');
  const definitions = snapshot.original.Parameters;
  if (!definitions || !Array.isArray(snapshot.parameters))
    throw Error('MISSING_STACK_PARAMETERS');
  const values = new Map();
  for (const p of snapshot.parameters) {
    if (
      !p ||
      typeof p.ParameterKey !== 'string' ||
      typeof p.ParameterValue !== 'string' ||
      values.has(p.ParameterKey)
    )
      throw Error('INVALID_STACK_PARAMETERS');
    values.set(p.ParameterKey, p.ParameterValue);
  }
  if (
    values.size !== Object.keys(definitions).length ||
    Object.keys(definitions).some((k) => !values.has(k))
  )
    throw Error('INCOMPLETE_STACK_PARAMETERS');
  for (const k of [
    'StripeSandboxAccountId',
    'DevPaymentLedgerNamespace',
    'DevPaymentLedgerAccountId',
    'PaymentStartEnabled',
  ]) {
    const d = definitions[k];
    if (
      !d ||
      d.Type !== 'String' ||
      !Array.isArray(d.AllowedValues) ||
      d.AllowedValues.length !== 1 ||
      values.get(k) !== d.Default ||
      d.AllowedValues[0] !== d.Default
    )
      throw Error('PAYMENT_BINDING_NOT_PRESERVED');
  }
  if (values.get('PaymentStartEnabled') !== 'false')
    throw Error('PAYMENT_ADMISSION_NOT_DISABLED');
  return snapshot.original;
}
function artifactHelpers() {
  return require('../dist/infra/lib/artifacts.js');
}
function validateAcceptedFunctions(baseline) {
  const { acceptedArtifacts } = artifactHelpers();
  const records = acceptedArtifacts();
  const functions = Object.entries(baseline.Resources || {}).filter(
    ([, r]) => r.Type === 'AWS::Lambda::Function',
  );
  assert.deepStrictEqual(
    functions.map(([id]) => id).sort(),
    Object.keys(records).sort(),
  );
  for (const [id, r] of Object.entries(records)) {
    const props = baseline.Resources[id].Properties;
    if (props.Handler !== r.handler) throw Error('ACCEPTED_HANDLER_CHANGED');
    assert.deepStrictEqual(
      props.Code,
      { S3Bucket: r.bucket, S3Key: r.key },
      'ACCEPTED_CODE_CHANGED',
    );
  }
}
function candidateCode(candidate) {
  exactKeys(candidate, [
    'logicalId',
    'account',
    'region',
    'sha256',
    'reviewedForLocalSynthesis',
    'releaseId',
    'destinationBucket',
    'destinationKey',
  ]);
  const { releaseId, destinationBucket, destinationKey, ...selection } =
    candidate;
  if (
    typeof releaseId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      releaseId,
    ) ||
    destinationBucket !== bucket ||
    destinationKey !== `api-releases/${releaseId}/${selection.sha256}.zip`
  )
    throw Error('INVALID_CREATE_ONLY_DESTINATION');
  artifactHelpers().verifyApiCandidate(selection);
  return { S3Bucket: destinationBucket, S3Key: destinationKey };
}
function validateRelease(baseline, proposed, approvedCode) {
  validateAcceptedFunctions(baseline);
  compareTemplates(baseline, proposed, approvedCode);
  if (
    approvedCode &&
    hash(baseline.Resources[API].Properties.Code) === hash(approvedCode)
  )
    throw Error('API_CODE_CHANGE_REQUIRED');
  return true;
}
function proposeTemplate(baseline, candidate) {
  validateAcceptedFunctions(baseline);
  const proposed = structuredClone(baseline);
  const code = candidate === undefined ? undefined : candidateCode(candidate);
  if (code) proposed.Resources[API].Properties.Code = code;
  validateRelease(baseline, proposed, code);
  return proposed;
}
function deploymentBlockers(evidence = {}) {
  return [
    ...(evidence.rollbackArtifactVerified === true
      ? []
      : ['ROLLBACK_ARTIFACT_UNVERIFIED_OR_MISSING']),
    'FRESH_AUTHENTICATED_BASELINE_REQUIRED_AT_RELEASE',
    'CREATE_ONLY_PUBLICATION_AND_PUBLISHED_HASH_UNVERIFIED',
    'ACCEPTED_ARTIFACT_VERSIONS_AND_RETENTION_UNVERIFIED',
    'EXPLICIT_RELEASE_AUTHORIZATION_REQUIRED',
    'REVIEWED_CODE_ONLY_CHANGE_SET_REQUIRED',
    'POST_RELEASE_VERIFICATION_PLAN_REQUIRED',
    'DEPLOYMENT_EXECUTOR_NOT_IMPLEMENTED',
  ];
}
function buildRelease(snapshot, candidate) {
  const baseline = validateBaseline(snapshot, anchor);
  if (candidate === undefined) throw Error('EXPLICIT_CANDIDATE_REQUIRED');
  const template = proposeTemplate(baseline, candidate);
  const rollback = artifactHelpers().acceptedArtifacts()[API];
  return {
    template,
    report: {
      status: 'NOT DEPLOYABLE',
      deploymentAuthorized: false,
      stackId: anchor.stackId,
      baselineSha256: hash(baseline),
      proposedTemplateSha256: hash(template),
      candidateSha256: candidate.sha256,
      code: template.Resources[API].Properties.Code,
      allowedChange: 'Resources.ApplicationApi5D63FF39.Properties.Code',
      rollback: {
        code: baseline.Resources[API].Properties.Code,
        sha256: rollback.sha256,
        observedVersion: rollback.observedVersion,
        availability: 'UNVERIFIED',
      },
      publication: {
        existsInS3: 'UNVERIFIED',
        overwriteAllowed: false,
        requiredCondition: 'If-None-Match: *',
      },
      blockers: deploymentBlockers(),
    },
    parameters: snapshot.parameters.map((p) => ({
      ParameterKey: p.ParameterKey,
      UsePreviousValue: true,
    })),
  };
}
module.exports = {
  hash,
  validateBaseline,
  validateRelease,
  proposeTemplate,
  buildRelease,
  deploymentBlockers,
};
if (require.main === module) {
  try {
    if (process.argv.length !== 5) throw Error('INVALID_ARGUMENTS');
    const [snapshotFile, candidateFile, out] = process.argv.slice(2);
    const result = buildRelease(
      JSON.parse(fs.readFileSync(snapshotFile, 'utf8')),
      JSON.parse(fs.readFileSync(candidateFile, 'utf8')),
    );
    // Refuse existing destinations and avoid printing template or parameter values.
    fs.mkdirSync(out, { mode: 0o700 });
    for (const [name, value] of Object.entries(result))
      fs.writeFileSync(
        path.join(out, name + '.json'),
        JSON.stringify(value, null, 2) + '\n',
        { flag: 'wx', mode: 0o600 },
      );
    console.log(
      'LOCAL TEMPLATE ISOLATION VERIFIED; NOT DEPLOYABLE; deployment authorized: false.',
    );
  } catch {
    console.error('RELEASE_TEMPLATE_REJECTED; no deployment performed.');
    process.exitCode = 1;
  }
}
