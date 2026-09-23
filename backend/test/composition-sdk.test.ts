import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoCatalogRepository, CatalogWriteError } from '../src/repository';
import { drop, relation } from './fixtures';
import { catalogKeys } from '../src/keys';

test('installed SDK serializes transactions and preserves ordered cancellation reasons without any network', async () => {
  const targets: string[] = [];
  const draft = { ...drop, status: 'DRAFT', ...catalogKeys.drop(drop.dropId) };
  const client = new DynamoDBClient({
    region: 'us-east-2',
    credentials: {
      accessKeyId: 'synthetic-test-id',
      secretAccessKey: 'synthetic-test-key',
    },
    maxAttempts: 1,
    requestHandler: {
      handle: async (request: {
        headers: Record<string, string>;
        body?: unknown;
      }) => {
        const target = request.headers['x-amz-target'];
        targets.push(target);
        if (target.endsWith('.GetItem'))
          return {
            response: {
              statusCode: 200,
              headers: { 'content-type': 'application/x-amz-json-1.0' },
              body: Buffer.from(
                JSON.stringify({
                  Item: Object.fromEntries(
                    Object.entries(draft).map(([key, value]) => [
                      key,
                      typeof value === 'number'
                        ? { N: String(value) }
                        : { S: value },
                    ]),
                  ),
                }),
              ),
            },
          };
        assert.equal(target, 'DynamoDB_20120810.TransactWriteItems');
        const serialized = JSON.parse(String(request.body));
        assert.equal(serialized.TransactItems.length, 4);
        assert.deepEqual(
          serialized.TransactItems[0].Put.ExpressionAttributeValues,
          { ':draft': { S: 'DRAFT' }, ':expected': { S: draft.updatedAt } },
        );
        return {
          response: {
            statusCode: 400,
            headers: { 'content-type': 'application/x-amz-json-1.0' },
            body: Buffer.from(
              JSON.stringify({
                __type:
                  'com.amazonaws.dynamodb.v20120810#TransactionCanceledException',
                message: 'synthetic private cancellation',
                CancellationReasons: [
                  'ConditionalCheckFailed',
                  'None',
                  'None',
                  'None',
                ].map((Code) => ({ Code })),
              }),
            ),
          },
        };
      },
    },
  });
  try {
    const repository = new DynamoCatalogRepository(
      DynamoDBDocumentClient.from(client),
      'test-catalog',
    );
    await assert.rejects(
      repository.attachDropProduct(relation, 100),
      (error) =>
        error instanceof CatalogWriteError &&
        error.code === 'COMPOSITION_CONFLICT',
    );
    assert.deepEqual(targets, [
      'DynamoDB_20120810.GetItem',
      'DynamoDB_20120810.TransactWriteItems',
      'DynamoDB_20120810.GetItem',
    ]);
  } finally {
    client.destroy();
  }
});
