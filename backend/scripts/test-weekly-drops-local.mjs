// Isolated loopback-only DynamoDB acceptance. Never uses a profile or real table.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
const {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
} = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');
const { DynamoCatalogRepository } = require('../dist/src/repository');
const { catalogKeys } = require('../dist/src/keys');
const { integrityReadyKey } = require('../dist/src/product-integrity');
const { generateUlid } = require('../dist/src/ulid');
const raw = new DynamoDBClient({
  endpoint: 'http://127.0.0.1:18765',
  region: 'us-east-2',
  credentials: { accessKeyId: 'LOCALONLY', secretAccessKey: 'LOCALONLY' },
  maxAttempts: 1,
});
raw.middlewareStack.add(
  (next) => async (args) => {
    assert.equal(args.request.hostname, '127.0.0.1');
    assert.equal(args.request.port, 18765);
    return next(args);
  },
  { step: 'finalizeRequest', name: 'loopbackOnly' },
);
const client = DynamoDBDocumentClient.from(raw),
  table = 'bb-weekly-local-' + randomUUID(),
  repo = new DynamoCatalogRepository(client, table);
let created = false;
try {
  await raw.send(
    new CreateTableCommand({
      TableName: table,
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  );
  created = true;
  const stamp = '2026-10-15T12:00:00.000Z',
    dropId = generateUlid(),
    ids = [generateUlid(), generateUlid(), generateUlid()];
  for (const [i, id] of ids.entries())
    await client.send(
      new PutCommand({
        TableName: table,
        Item: {
          ...catalogKeys.product(id),
          productId: id,
          name: 'Synthetic cookie ' + i,
          slug: 'synthetic-' + i,
          description: 'Local only',
          ingredients: [],
          allergens: [],
          active: true,
          createdAt: stamp,
          updatedAt: stamp,
        },
      }),
    );
  const drop = {
    dropId,
    name: 'Synthetic weekly Drop',
    description: 'Local acceptance',
    status: 'DRAFT',
    opensAt: '2026-10-18T18:00:00.000Z',
    quantityLimit: 12,
    timezone: 'America/Denver',
    pickupLocation: 'Synthetic bakery',
    pickupInstructions: 'Local only',
    createdAt: stamp,
    updatedAt: stamp,
  };
  await repo.createDraftDrop(drop);
  const input = {
    revision: stamp,
    drop,
    products: ids.map((productId, i) => ({
      productId,
      priceCents: 400 + i * 25,
      inventoryTotal: 20 + i,
    })),
    pickups: ['22', '23', '24'].map((day) => ({
      dropId,
      date: '2026-10-' + day,
      startTime: '16:00',
      endTime: '19:00',
      timezone: 'America/Denver',
      active: true,
    })),
  };
  await assert.rejects(repo.saveWeeklyDraft(input));
  assert.equal((await repo.getDropProducts(dropId)).length, 0);
  await client.send(
    new PutCommand({
      TableName: table,
      Item: { ...integrityReadyKey, version: 1, state: 'READY' },
    }),
  );
  let saved = await repo.saveWeeklyDraft(input);
  assert.notEqual(saved.updatedAt, stamp);
  const reopened = new DynamoCatalogRepository(client, table);
  assert.equal((await reopened.getDropProducts(dropId)).length, 3);
  assert.deepEqual(
    (await reopened.getDropInventory(dropId)).map((x) => x.total).sort(),
    [20, 21, 22],
  );
  assert.equal((await reopened.getPickupDates(dropId)).length, 3);
  await assert.rejects(repo.saveWeeklyDraft(input));
  saved = await repo.saveWeeklyDraft({
    ...input,
    revision: saved.updatedAt,
    drop: { ...saved, name: 'Edited synthetic Drop' },
    products: input.products.map((p) => ({
      ...p,
      priceCents: p.priceCents + 1,
    })),
  });
  assert.equal((await repo.getDrop(dropId)).name, 'Edited synthetic Drop');
  await client.send(
    new UpdateCommand({
      TableName: table,
      Key: catalogKeys.product(ids[0]),
      UpdateExpression: 'SET active=:no',
      ExpressionAttributeValues: { ':no': false },
    }),
  );
  await assert.rejects(
    repo.saveWeeklyDraft({ ...input, drop: saved, revision: saved.updatedAt }),
  );
  await client.send(
    new UpdateCommand({
      TableName: table,
      Key: catalogKeys.product(ids[0]),
      UpdateExpression: 'SET active=:yes',
      ExpressionAttributeValues: { ':yes': true },
    }),
  );
  const revision = saved.updatedAt;
  const results = await Promise.allSettled([
    repo.saveWeeklyDraft({ ...input, drop: saved, revision }),
    repo.saveWeeklyDraft({ ...input, drop: saved, revision }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  saved = await repo.getDrop(dropId);
  await client.send(
    new UpdateCommand({
      TableName: table,
      Key: catalogKeys.inventory(dropId, ids[0]),
      UpdateExpression: 'SET reserved=:one',
      ExpressionAttributeValues: { ':one': 1 },
    }),
  );
  await assert.rejects(
    repo.saveWeeklyDraft({ ...input, drop: saved, revision: saved.updatedAt }),
    /INVENTORY_NOT_EDITABLE/,
  );
  assert.equal(
    (await repo.getDropInventory(dropId)).find((x) => x.productId === ids[0])
      .reserved,
    1,
  );
  await client.send(
    new UpdateCommand({
      TableName: table,
      Key: catalogKeys.inventory(dropId, ids[0]),
      UpdateExpression: 'SET reserved=:zero, sold=:one',
      ExpressionAttributeValues: { ':zero': 0, ':one': 1 },
    }),
  );
  await assert.rejects(
    repo.saveWeeklyDraft({ ...input, drop: saved, revision: saved.updatedAt }),
    /INVENTORY_NOT_EDITABLE/,
  );
  assert.equal(
    (await repo.getDropInventory(dropId)).find((x) => x.productId === ids[0])
      .sold,
    1,
  );
  console.log(
    'PASS: readiness gate, atomic 3-cookie save, reload, stale conflict, edit, concurrent-save conflict, reservation/sale preservation, inactive Product rejection',
  );
} finally {
  if (created) await raw.send(new DeleteTableCommand({ TableName: table }));
  raw.destroy();
}
