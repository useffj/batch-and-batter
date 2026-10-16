import {
  GetResourcePolicyCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  ScanCommand,
  PutCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { ISOLATED_TABLE } from './isolated-catalog';
import { integrityReadyKey } from './product-integrity';
export const isolatedTableArn = `arn:aws:dynamodb:us-east-2:302154194958:table/${ISOLATED_TABLE}`;
const writes = [
  'dynamodb:PutItem',
  'dynamodb:UpdateItem',
  'dynamodb:DeleteItem',
  'dynamodb:BatchWriteItem',
  'dynamodb:PartiQLInsert',
  'dynamodb:PartiQLUpdate',
  'dynamodb:PartiQLDelete',
];
// No executable AWS launcher is installed. The future operator must hold the
// exclusive initializer role, with all other writers quarantined by this deny.
export async function initializeIsolatedCatalog(
  raw: Pick<DynamoDBClient, 'send'>,
  client: Pick<DynamoDBDocumentClient, 'send'>,
  initializerRoleArn: string,
) {
  if (
    !/^arn:aws:iam::302154194958:role\/[A-Za-z0-9+=,.@_/-]+$/.test(
      initializerRoleArn,
    )
  )
    throw Error('INVALID_INITIALIZER');
  const readGate = async () => {
    const result = await raw.send(
      new GetResourcePolicyCommand({ ResourceArn: isolatedTableArn }),
    );
    const policy = JSON.parse(result.Policy ?? '{}');
    const statement = policy.Statement;
    if (
      policy.Version !== '2012-10-17' ||
      !Array.isArray(statement) ||
      statement.length !== 1
    )
      throw Error('EXCLUSIVE_WRITER_GATE_REQUIRED');
    const s = statement[0];
    if (
      s.Sid !== 'ExclusiveInitialization' ||
      s.Effect !== 'Deny' ||
      s.Principal !== '*' ||
      s.Resource !== isolatedTableArn ||
      JSON.stringify(s.Condition) !==
        JSON.stringify({
          ArnNotEquals: { 'aws:PrincipalArn': initializerRoleArn },
        }) ||
      !Array.isArray(s.Action) ||
      s.Action.length !== writes.length ||
      !writes.every((a) => s.Action.includes(a))
    )
      throw Error('EXCLUSIVE_WRITER_GATE_REQUIRED');
    if (!result.RevisionId) throw Error('POLICY_REVISION_REQUIRED');
    return result.RevisionId;
  };
  const revision = await readGate();
  const page = await client.send(
    new ScanCommand({
      TableName: ISOLATED_TABLE,
      ConsistentRead: true,
      Limit: 1,
    }),
  );
  if (!Array.isArray(page.Items) || page.Items.length || page.LastEvaluatedKey)
    throw Error('EMPTY_CATALOG_REQUIRED');
  if ((await readGate()) !== revision) throw Error('WRITER_GATE_CHANGED');
  await client.send(
    new PutCommand({
      TableName: ISOLATED_TABLE,
      Item: { ...integrityReadyKey, version: 1, state: 'READY' },
      ConditionExpression: 'attribute_not_exists(PK)',
    }),
  );
}
