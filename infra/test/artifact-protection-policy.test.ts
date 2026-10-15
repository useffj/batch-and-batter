import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
const bucket = require(
  resolve(__dirname, '../../../config/artifact-protection-policy.json'),
);
const role = require(
  resolve(__dirname, '../../../config/api-artifact-publisher-policy.json'),
);
const manifest = require(
  resolve(__dirname, '../../../config/dev-lambda-artifacts.json'),
);
const { materializeIdentityPolicy } = require(
  resolve(__dirname, '../../../scripts/publish-api-artifact.cjs'),
);
type Statement = {
  Effect: string;
  Action: string | string[];
  Resource: string | string[];
  Condition?: Record<string, Record<string, string>>;
};
type Policy = { Statement: Statement[] };
const arr = (v: string | string[]) => (Array.isArray(v) ? v : [v]);
const matches = (pattern: string, value: string) =>
  new RegExp(
    '^' +
      pattern
        .split('*')
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*') +
      '$',
  ).test(value);
// Deliberately limited evaluator of these proposal operators, NOT IAM simulation.
function effect(
  p: Policy,
  action: string,
  resource: string,
  context: Record<string, string>,
) {
  let allowed = false;
  for (const s of p.Statement) {
    if (
      !arr(s.Action).some((a) => matches(a, action)) ||
      !arr(s.Resource).some((r) => matches(r, resource))
    )
      continue;
    const applies = Object.entries(s.Condition ?? {}).every(([op, terms]) =>
      Object.entries(terms).every(([k, v]) => {
        if (op === 'Null') return String(context[k] === undefined) === v;
        if (op === 'StringNotEquals' || op === 'ArnNotEquals')
          return context[k] !== v;
        if (op === 'StringEquals' || op === 'ArnEquals' || op === 'Bool')
          return context[k] === v;
        if (op === 'StringLike')
          return context[k] !== undefined && matches(v, context[k]);
        throw Error('UNSUPPORTED_EVALUATOR_OPERATOR');
      }),
    );
    if (applies && s.Effect === 'Deny') return 'Deny';
    if (applies && s.Effect === 'Allow') allowed = true;
  }
  return allowed ? 'Allow' : 'ImplicitDeny';
}
const b = 'arn:aws:s3:::cdk-hnb659fds-assets-302154194958-us-east-2';
const key =
  'api-releases/12345678-1234-4234-8234-123456789abc/' +
  'a'.repeat(64) +
  '.zip';
const object = b + '/' + key;
const context = {
  'aws:SecureTransport': 'true',
  'aws:PrincipalArn': role.roleArn,
  's3:if-none-match': '*',
};
const identity = materializeIdentityPolicy(key);
const allowed = (
  action: string,
  resource: string,
  c: Record<string, string> = context,
) =>
  effect(bucket, action, resource, c) !== 'Deny' &&
  effect(identity, action, resource, c) === 'Allow' &&
  effect(role.permissionsBoundary, action, resource, c) === 'Allow';
test('accepted exact resources and every mutation denied including bootstrap principal', () => {
  const expected = [
    ...new Set(
      manifest.functions.map(
        (f: { bucket: string; key: string }) =>
          `arn:aws:s3:::${f.bucket}/${f.key}`,
      ),
    ),
  ];
  assert.deepEqual(
    bucket.Statement.find(
      (s: { Sid: string }) => s.Sid === 'ProtectAcceptedArtifacts',
    ).Resource,
    expected,
  );
  for (const resource of expected)
    for (const action of [
      'PutObject',
      'DeleteObject',
      'DeleteObjectVersion',
      'PutObjectTagging',
      'DeleteObjectTagging',
      'PutObjectVersionTagging',
      'DeleteObjectVersionTagging',
      'PutObjectAcl',
      'PutObjectVersionAcl',
    ]) {
      for (const principal of [
        role.roleArn,
        'arn:aws:iam::302154194958:role/cdk-hnb659fds-file-publishing-role-302154194958-us-east-2',
      ])
        assert.equal(
          effect(bucket, 's3:' + action, String(resource), {
            ...context,
            'aws:PrincipalArn': principal,
          }),
          'Deny',
        );
    }
});
test('candidate conditional allow, wrong principals and invalid headers denied', () => {
  assert.equal(allowed('s3:PutObject', object), true);
  for (const principal of [
    'wrong',
    'arn:aws:iam::302154194958:role/cdk-hnb659fds-file-publishing-role-302154194958-us-east-2',
  ])
    assert.equal(
      effect(bucket, 's3:PutObject', object, {
        ...context,
        'aws:PrincipalArn': principal,
      }),
      'Deny',
    );
  const missing: Record<string, string> = { ...context };
  delete missing['s3:if-none-match'];
  assert.equal(effect(bucket, 's3:PutObject', object, missing), 'Deny');
  for (const header of ['', 'etag', '**'])
    assert.equal(
      effect(bucket, 's3:PutObject', object, {
        ...context,
        's3:if-none-match': header,
      }),
      'Deny',
    );
  // Copy/multipart initiation without the required destination header fails closed.
  assert.equal(
    effect(bucket, 's3:PutObject', object, {
      ...missing,
      's3:x-amz-copy-source': 'source',
    }),
    'Deny',
  );
});
test('candidate delete, tagging and ACL mutations denied; unrelated CDK assets untouched', () => {
  for (const a of [
    'DeleteObject',
    'DeleteObjectVersion',
    'PutObjectTagging',
    'DeleteObjectTagging',
    'PutObjectVersionTagging',
    'DeleteObjectVersionTagging',
    'PutObjectAcl',
    'PutObjectVersionAcl',
  ])
    assert.equal(effect(bucket, 's3:' + a, object, context), 'Deny');
  for (const a of ['PutObject', 'DeleteObject', 'DeleteObjectVersion'])
    assert.equal(
      effect(bucket, 's3:' + a, b + '/unrelated-cdk.zip', context),
      'ImplicitDeny',
    );
  assert.equal(
    effect(bucket, 's3:GetObject', object, {
      ...context,
      'aws:SecureTransport': 'false',
    }),
    'Deny',
  );
});
test('publisher cannot alter configuration, secrets or other candidate keys', () => {
  for (const a of [
    's3:PutBucketPolicy',
    's3:DeleteBucketPolicy',
    's3:PutLifecycleConfiguration',
    's3:PutBucketVersioning',
    'iam:PutRolePolicy',
    'lambda:UpdateFunctionCode',
    'cloudformation:UpdateStack',
    'ssm:GetParameter',
    'secretsmanager:GetSecretValue',
  ])
    assert.equal(allowed(a, b), false);
  assert.equal(
    allowed('s3:PutObject', object.replace('12345678', '22345678')),
    false,
  );
  assert.equal(allowed('s3:GetObjectVersion', object), true);
  assert.equal(
    allowed('s3:ListBucketVersions', b, { ...context, 's3:prefix': key }),
    true,
  );
  assert.equal(
    allowed('s3:ListBucketVersions', b, { ...context, 's3:prefix': '' }),
    false,
  );
});
test('KMS is exact-key, S3-only, account and object-context limited', () => {
  const kms =
    'arn:aws:kms:us-east-2:302154194958:key/c4361324-2444-4484-82ef-f98ba10b5ad3';
  const c = {
    ...context,
    'kms:ViaService': 's3.us-east-2.amazonaws.com',
    'kms:CallerAccount': '302154194958',
    'kms:EncryptionContext:aws:s3:arn': object,
  };
  for (const action of ['kms:GenerateDataKey', 'kms:Decrypt']) {
    assert.equal(allowed(action, kms, c), true);
    for (const field of [
      'kms:ViaService',
      'kms:CallerAccount',
      'kms:EncryptionContext:aws:s3:arn',
    ])
      assert.equal(allowed(action, kms, { ...c, [field]: 'wrong' }), false);
    assert.equal(allowed(action, kms + 'wrong', c), false);
    assert.equal(
      allowed(action, kms, { ...c, 'kms:EncryptionContext:aws:s3:arn': b }),
      false,
    );
  }
  assert.equal(allowed('kms:Encrypt', kms, c), false);
});
test('trust is exact operator and templates cannot admit wildcard keys', () => {
  assert.deepEqual(role.trustPolicy.Statement, [
    {
      Effect: 'Allow',
      Principal: {
        AWS: 'arn:aws:iam::302154194958:role/aws-reserved/sso.amazonaws.com/us-east-2/AWSReservedSSO_AdministratorAccess_e072fc27fb82916d',
      },
      Action: 'sts:AssumeRole',
    },
  ]);
  for (const key of [
    'api-releases/*',
    'other.zip',
    '${APPROVED_CANDIDATE_KEY}',
    'api-releases/../../key',
  ])
    assert.throws(() => materializeIdentityPolicy(key));
  assert.equal(role.awsProtectionActive, false);
});

test('copy source is denied even with the correct conditional header', () => {
  assert.equal(
    effect(bucket, 's3:PutObject', object, {
      ...context,
      's3:x-amz-copy-source': 'source/key',
    }),
    'Deny',
  );
});
