import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GetCommand,
  PutCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { CatalogWriteError, DynamoCatalogRepository } from '../src/repository';
import { catalogKeys } from '../src/keys';
import { product, drop, otherProductId } from './fixtures';

const draft = { ...drop, status: 'DRAFT' as const };
const nextTime = '2026-09-22T12:00:00.001Z';
const nextProduct = { ...product, name: 'Changed', updatedAt: nextTime };
const nextDrop = { ...draft, name: 'Changed', updatedAt: nextTime };
const conditionalFailure = () =>
  Object.assign(new Error('private SDK detail'), {
    name: 'ConditionalCheckFailedException',
  });
function setup(responses: (Record<string, unknown> | Error)[]) {
  const commands: (PutCommand | GetCommand)[] = [];
  const client = {
    send: async (command: PutCommand | GetCommand) => {
      assert.ok(command instanceof PutCommand || command instanceof GetCommand);
      commands.push(command);
      assert.ok(responses.length, 'Unexpected database call');
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
  } as unknown as Pick<DynamoDBDocumentClient, 'send'>;
  return {
    repository: new DynamoCatalogRepository(client, 'test-catalog'),
    commands,
  };
}
test('creations use only conditional PutItem at Drop META keys', async () => {
  const { repository, commands } = setup([{}]);
  await repository.createDraftDrop(draft);
  assert.deepEqual(
    commands.map((command) => command.input),
    [
      {
        TableName: 'test-catalog',
        Item: { ...draft, ...catalogKeys.drop(draft.dropId) },
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    ],
  );
  assert.ok(commands.every((command) => command instanceof PutCommand));
});
test('replacement guards existence, previous version, creation timestamp and DRAFT status at write time', async () => {
  const { repository, commands } = setup([{}]);
  await repository.replaceDraftDrop(nextDrop, draft);
  assert.deepEqual(
    commands.map((command) => command.input),
    [
      {
        TableName: 'test-catalog',
        Item: { ...nextDrop, ...catalogKeys.drop(draft.dropId) },
        ConditionExpression:
          'attribute_exists(PK) AND #created = :created AND #updated = :updated AND #status = :draft',
        ExpressionAttributeNames: {
          '#created': 'createdAt',
          '#updated': 'updatedAt',
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':created': draft.createdAt,
          ':updated': draft.updatedAt,
          ':draft': 'DRAFT',
        },
      },
    ],
  );
});
test('conditional create failures become conflicts with no fallback writes', async () => {
  for (const kind of ['drop'] as string[]) {
    const { repository, commands } = setup([conditionalFailure()]);
    await assert.rejects(
      kind === 'product'
        ? repository.createProduct(product)
        : repository.createDraftDrop(draft),
      (error: unknown) =>
        error instanceof CatalogWriteError &&
        error.code ===
          (kind === 'product' ? 'PRODUCT_CONFLICT' : 'DROP_CONFLICT'),
    );
    assert.equal(commands.length, 1);
  }
});
test('conditional replace failures distinguish deletion, concurrent edit and concurrent publication', async () => {
  for (const [kind, current, code] of [
    ['drop', undefined, 'DROP_NOT_FOUND'],
    ['drop', nextDrop, 'DROP_CONFLICT'],
    ...(
      [
        'SCHEDULED',
        'OPEN',
        'PAUSED',
        'SOLD_OUT',
        'CLOSED',
        'COMPLETED',
      ] as const
    ).map(
      (status) => ['drop', { ...draft, status }, 'DROP_NOT_EDITABLE'] as const,
    ),
  ] as const) {
    const key = catalogKeys.drop(drop.dropId);
    const { repository, commands } = setup([
      conditionalFailure(),
      current ? { Item: { ...current, ...key } } : {},
    ]);
    await assert.rejects(
      repository.replaceDraftDrop(nextDrop, draft),
      (error: unknown) =>
        error instanceof CatalogWriteError && error.code === code,
    );
    assert.equal(commands.length, 2);
    assert.ok(commands[0] instanceof PutCommand);
    assert.ok(commands[1] instanceof GetCommand);
    assert.deepEqual(commands[1].input, {
      TableName: 'test-catalog',
      Key: key,
      ConsistentRead: true,
    });
  }
});
test('repository independently rejects invalid records, non-DRAFT state and changed immutable fields', async () => {
  const { repository, commands } = setup([]);
  for (const operation of [
    () => repository.createProduct({ ...product, slug: 'invalid slug' }),
    () => repository.createDraftDrop(drop),
    () => repository.replaceDraftDrop(drop, draft),
    () => repository.replaceDraftDrop(nextDrop, drop),
    () =>
      repository.replaceProduct(
        { ...nextProduct, productId: otherProductId },
        product,
      ),
    () =>
      repository.replaceDraftDrop(
        { ...nextDrop, dropId: otherProductId },
        draft,
      ),
    () =>
      repository.replaceProduct(
        { ...nextProduct, createdAt: nextTime },
        product,
      ),
    () =>
      repository.replaceDraftDrop({ ...nextDrop, createdAt: nextTime }, draft),
    () => repository.replaceProduct(product, product),
    () => repository.replaceDraftDrop(draft, draft),
    () => repository.createDraftDrop({ ...draft, quantityLimit: 0 }),
  ])
    await assert.rejects(operation());
  assert.equal(commands.length, 0);
});
test('unexpected SDK failures are propagated without retries or conversion into conflicts', async () => {
  const failure = new Error('private SDK failure');
  for (const operation of ['createDraftDrop', 'replaceDraftDrop'] as const) {
    const { repository, commands } = setup([failure]);
    const promise =
      operation === 'createDraftDrop'
        ? repository.createDraftDrop(draft)
        : repository.replaceDraftDrop(nextDrop, draft);
    await assert.rejects(promise, (error) => error === failure);
    assert.equal(commands.length, 1);
  }
});
