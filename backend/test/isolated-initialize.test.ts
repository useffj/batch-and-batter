import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initializeIsolatedCatalog,
  isolatedTableArn,
} from '../src/isolated-catalog-initialize';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
const role = 'arn:aws:iam::302154194958:role/synthetic-initializer';
const policy = {
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'ExclusiveInitialization',
      Effect: 'Deny',
      Principal: '*',
      Action: [
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:DeleteItem',
        'dynamodb:BatchWriteItem',
        'dynamodb:PartiQLInsert',
        'dynamodb:PartiQLUpdate',
        'dynamodb:PartiQLDelete',
      ],
      Resource: isolatedTableArn,
      Condition: { ArnNotEquals: { 'aws:PrincipalArn': role } },
    },
  ],
};
test('initialization refuses any existing data, pagination ambiguity, changed gate and missing PartiQL protection', async () => {
  for (const scenario of ['records', 'cursor', 'changed', 'partiql']) {
    let reads = 0,
      writes = 0;
    const p = structuredClone(policy);
    if (scenario === 'partiql') p.Statement[0].Action.pop();
    const raw = {
      send: async () => ({
        Policy: JSON.stringify(p),
        RevisionId: scenario === 'changed' ? String(++reads) : 'same',
      }),
    } as unknown as Pick<DynamoDBClient, 'send'>;
    const client = {
      send: async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'PutCommand') {
          writes++;
          return {};
        }
        return {
          Items:
            scenario === 'records' ? [{ PK: 'unexpected', SK: 'record' }] : [],
          ...(scenario === 'cursor'
            ? { LastEvaluatedKey: { PK: 'x', SK: 'y' } }
            : {}),
        };
      },
    } as unknown as Pick<DynamoDBDocumentClient, 'send'>;
    await assert.rejects(initializeIsolatedCatalog(raw, client, role));
    assert.equal(writes, 0);
  }
});
