'use strict';
// Proposal only. Never installs policy or broadens the historical role.
const old = require('./publish-api-artifact.cjs');
const frozen = require('../config/frozen-media-artifacts.json');
const roleArn =
  'arn:aws:iam::302154194958:role/batch-and-batter-dev-media-artifact-publisher';
function proposal() {
  const objects = Object.values(frozen).map(
    (a) => `arn:aws:s3:::${old.BUCKET}/${a.proposedKey}`,
  );
  const trustPolicy = structuredClone(
    require('../config/api-artifact-publisher-policy.json').trustPolicy,
  );
  const statements = Object.values(frozen).flatMap((a) =>
    old
      .materializeIdentityPolicy(
        `api-releases/${a.operationId}/${a.sha256}.zip`,
      )
      .Statement.map((s) =>
        JSON.parse(
          JSON.stringify(s).replaceAll(
            `api-releases/${a.operationId}/${a.sha256}.zip`,
            a.proposedKey,
          ),
        ),
      ),
  );
  const identityPolicy = { Version: '2012-10-17', Statement: statements };
  const bucketPolicy = structuredClone(
    require('../config/artifact-protection-policy.json'),
  );
  bucketPolicy.Id = 'AccessControl';
  // Preserve the old principal's scope. The new principal exception is paired
  // with an explicit NotResource deny restricting it to these two exact keys.
  bucketPolicy.Statement.find(
    (s) => s.Sid === 'DedicatedPublisherOnly',
  ).Condition.ArnNotEquals['aws:PrincipalArn'] = [old.ROLE, roleArn];
  bucketPolicy.Statement.push({
    Sid: 'MediaPublisherExactKeysOnly',
    Effect: 'Deny',
    Principal: '*',
    Action: 's3:PutObject',
    NotResource: objects,
    Condition: { ArnEquals: { 'aws:PrincipalArn': roleArn } },
  });
  for (const sid of [
    'ProtectPublishedArtifacts',
    'ConditionalHeaderRequired',
    'ConditionalCreateOnly',
    'CopyPathsBlocked',
  ]) {
    const s = structuredClone(
      bucketPolicy.Statement.find((s) => s.Sid === sid),
    );
    s.Sid = 'Media' + sid;
    s.Resource = objects;
    bucketPolicy.Statement.push(s);
  }
  bucketPolicy.Statement.push({
    Sid: 'MediaDedicatedPublisherOnly',
    Effect: 'Deny',
    Principal: '*',
    Action: 's3:PutObject',
    Resource: objects,
    Condition: { ArnNotEquals: { 'aws:PrincipalArn': roleArn } },
  });
  for (const [key, value] of [
    ['s3:x-amz-server-side-encryption', 'aws:kms'],
    ['s3:x-amz-server-side-encryption-aws-kms-key-id', old.KMS],
  ]) {
    bucketPolicy.Statement.push({
      Sid: key.endsWith('key-id') ? 'MediaKmsKeyRequired' : 'MediaKmsRequired',
      Effect: 'Deny',
      Principal: '*',
      Action: 's3:PutObject',
      Resource: objects,
      Condition: { StringNotEquals: { [key]: value } },
    });
  }
  return {
    roleArn,
    trustPolicy,
    identityPolicy,
    permissionsBoundary: structuredClone(identityPolicy),
    bucketPolicy,
  };
}
module.exports = { proposal, roleArn };
