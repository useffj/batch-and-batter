import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GetCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { DynamoCatalogRepository } from '../src/repository';
import { catalogKeys } from '../src/keys';
import {
  drop,
  dropId,
  inventory,
  otherProductId,
  pickup,
  product,
  productId,
  relation,
  timestamp,
} from './fixtures';

function setup(responses: Record<string, unknown>[]) {
  const commands: (GetCommand | QueryCommand)[] = [];
  const client = {
    send: async (command: GetCommand | QueryCommand) => {
      commands.push(command);
      assert.ok(
        command instanceof GetCommand || command instanceof QueryCommand,
        'Only Get/Query permitted',
      );
      assert.ok(responses.length, 'Unexpected repository call');
      return responses.shift();
    },
  } as unknown as Pick<DynamoDBDocumentClient, 'send'>;
  return {
    repository: new DynamoCatalogRepository(client, 'test-catalog'),
    commands,
  };
}
test('point reads use exact keys, table and strong consistency; strip storage keys', async () => {
  const { repository, commands } = setup([
    { Item: { ...catalogKeys.product(productId), ...product } },
    { Item: { ...catalogKeys.drop(dropId), ...drop } },
  ]);
  assert.deepEqual(await repository.getProduct(productId), product);
  assert.deepEqual(await repository.getDrop(dropId), drop);
  assert.deepEqual(
    commands.map((command) => command.input),
    [
      {
        TableName: 'test-catalog',
        Key: { PK: `PRODUCT#${productId}`, SK: 'META' },
        ConsistentRead: true,
      },
      {
        TableName: 'test-catalog',
        Key: { PK: `DROP#${dropId}`, SK: 'META' },
        ConsistentRead: true,
      },
    ],
  );
});
test('queries consume every page, including empty intermediate pages', async () => {
  const cursor = { PK: `DROP#${dropId}`, SK: `PRODUCT#${productId}` };
  const { repository, commands } = setup([
    { Items: [], LastEvaluatedKey: cursor },
    {
      Items: [{ ...catalogKeys.dropProduct(dropId, productId), ...relation }],
      LastEvaluatedKey: { ...cursor, SK: `PRODUCT#${otherProductId}` },
    },
    {
      Items: [
        {
          ...catalogKeys.dropProduct(dropId, otherProductId),
          ...relation,
          productId: otherProductId,
        },
      ],
    },
  ]);
  assert.equal((await repository.getDropProducts(dropId)).length, 2);
  assert.equal(commands.length, 3);
  assert.deepEqual(commands[1].input, {
    TableName: 'test-catalog',
    KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
    ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
    ExpressionAttributeValues: {
      ':pk': `DROP#${dropId}`,
      ':prefix': 'PRODUCT#',
    },
    ConsistentRead: true,
    ExclusiveStartKey: cursor,
  });
});
test('inventory and pickup reads use their exact SK prefixes', async () => {
  const { repository, commands } = setup([
    { Items: [{ ...catalogKeys.inventory(dropId, productId), ...inventory }] },
    { Items: [{ ...catalogKeys.pickup(dropId, pickup.date), ...pickup }] },
  ]);
  assert.deepEqual(await repository.getDropInventory(dropId), [inventory]);
  assert.deepEqual(await repository.getPickupDates(dropId), [pickup]);
  assert.deepEqual(
    commands.map(
      (command) =>
        (command as QueryCommand).input.ExpressionAttributeValues?.[':prefix'],
    ),
    ['INVENTORY#', 'PICKUP#'],
  );
});
test('current lookup uses configuration and metadata Gets without Scan', async () => {
  const { repository, commands } = setup([
    {
      Item: {
        ...catalogKeys.storefront,
        storefrontDropId: dropId,
        updatedAt: timestamp,
      },
    },
    { Item: { ...catalogKeys.drop(dropId), ...drop } },
  ]);
  assert.deepEqual(await repository.getStorefrontDrop(), drop);
  assert.deepEqual((commands[0] as GetCommand).input.Key, {
    PK: 'STORE#CONFIG',
    SK: 'STOREFRONT',
  });
  assert.ok(commands.every((command) => command instanceof GetCommand));
});
test('missing config, unset pointer and dangling pointer all resolve to no Drop', async () => {
  for (const responses of [
    [{}],
    [{ Item: { ...catalogKeys.storefront, updatedAt: timestamp } }],
    [
      {
        Item: {
          ...catalogKeys.storefront,
          storefrontDropId: dropId,
          updatedAt: timestamp,
        },
      },
      {},
    ],
  ]) {
    const { repository } = setup(responses);
    assert.equal(await repository.getStorefrontDrop(), undefined);
  }
});
test('repository rejects invalid records, mismatched identities and invalid query relationships', async () => {
  for (const Item of [
    {
      ...catalogKeys.product(productId),
      ...product,
      productId: otherProductId,
    },
    { ...catalogKeys.product(productId), ...product, PK: 'PRODUCT#wrong' },
    { ...catalogKeys.product(productId), ...product, slug: 'invalid slug' },
  ])
    await assert.rejects(setup([{ Item }]).repository.getProduct(productId));
  await assert.rejects(
    setup([
      {
        Item: { ...catalogKeys.drop(dropId), ...drop, dropId: otherProductId },
      },
    ]).repository.getDrop(dropId),
  );
  await assert.rejects(
    setup([
      {
        Items: [
          {
            ...catalogKeys.inventory(dropId, productId),
            ...inventory,
            reserved: 100,
          },
        ],
      },
    ]).repository.getDropInventory(dropId),
  );
  await assert.rejects(
    setup([
      {
        Items: [
          {
            ...catalogKeys.dropProduct(dropId, productId),
            ...relation,
            dropId: otherProductId,
          },
        ],
      },
    ]).repository.getDropProducts(dropId),
  );
  await assert.rejects(
    setup([
      {
        Items: [
          {
            ...catalogKeys.dropProduct(dropId, productId),
            ...relation,
            productId: otherProductId,
          },
        ],
      },
    ]).repository.getDropProducts(dropId),
  );
});
test('invalid IDs fail before issuing any database command', async () => {
  const { repository, commands } = setup([]);
  await assert.rejects(repository.getDrop('invalid'));
  assert.equal(commands.length, 0);
});
