// Reuses the existing loopback DynamoDB Local engine. No ambient AWS credentials.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
const {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
} = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand } = require('@aws-sdk/lib-dynamodb');
const {
  isolatedCatalog,
  ISOLATED_TABLE,
} = require('../dist/src/isolated-catalog');
const {
  initializeIsolatedCatalog,
  isolatedTableArn,
} = require('../dist/src/isolated-catalog-initialize');
const { DynamoCatalogRepository } = require('../dist/src/repository');
const { slugKey } = require('../dist/src/product-integrity');
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
    assert.equal(args.request.protocol, 'http:');
    return next(args);
  },
  { step: 'finalizeRequest', name: 'loopbackOnly' },
);
const client = DynamoDBDocumentClient.from(raw);
// DynamoDB Local does not enforce IAM. Exercise the policy validator with
// nonsecret fixture evidence; managed-AWS policy enforcement remains acceptance.
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
const gate = {
  send: async (command) => {
    assert.equal(command.input.ResourceArn, isolatedTableArn);
    return { Policy: JSON.stringify(policy), RevisionId: 'synthetic-revision' };
  },
};
let created = false;
try {
  await raw.send(
    new CreateTableCommand({
      TableName: ISOLATED_TABLE,
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
  await assert.rejects(
    initializeIsolatedCatalog(
      { send: async () => ({ Policy: '{}' }) },
      client,
      role,
    ),
    /EXCLUSIVE_WRITER/,
  );
  await initializeIsolatedCatalog(gate, client, role);
  await assert.rejects(
    initializeIsolatedCatalog(gate, client, role),
    /EMPTY_CATALOG/,
  );
  const invoke = async (route, body, pathParameters, headers = {}) => {
    const handler = isolatedCatalog(
      () => new DynamoCatalogRepository(client, ISOLATED_TABLE),
    );
    const r = await handler({
      routeKey: route,
      requestContext: {
        requestId: 'local',
        http: { method: route.split(' ')[0] },
        authorizer: {
          jwt: {
            claims: {
              sub: 'local-admin',
              username: 'local-admin',
              token_use: 'access',
              'cognito:groups': ['batch-and-batter-admins'],
            },
          },
        },
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      pathParameters,
      headers,
    });
    assert.ok(r.statusCode < 300, JSON.stringify(r));
    return JSON.parse(r.body);
  };
  const fields = {
    name: 'Synthetic DEV cookie',
    slug: 'synthetic-dev-cookie',
    description: 'Local only',
    ingredients: ['Flour'],
    allergens: ['Wheat'],
    active: true,
  };
  const { product } = await invoke('POST /admin/products', fields, undefined, {
    'idempotency-key': randomUUID(),
  });
  assert.ok(
    (
      await client.send(
        new GetCommand({
          TableName: ISOLATED_TABLE,
          Key: slugKey(fields.slug),
        }),
      )
    ).Item,
  );
  await invoke(
    'PUT /admin/products/{productId}',
    { ...fields, description: 'Saved description' },
    { productId: product.productId },
    { 'if-match': product.updatedAt },
  );
  assert.equal(
    (
      await invoke('GET /admin/products/{productId}', undefined, {
        productId: product.productId,
      })
    ).product.description,
    'Saved description',
  );
  const { drop } = await invoke('POST /admin/drops', {
    name: 'Synthetic DEV Drop',
    description: 'Draft only',
    opensAt: '2027-01-03T19:00:00.000Z',
    quantityLimit: 12,
    timezone: 'America/Denver',
    pickupLocation: 'Synthetic bakery',
    pickupInstructions: 'Local only',
  });
  await invoke(
    'PUT /admin/drops/{dropId}/draft',
    {
      revision: drop.updatedAt,
      drop,
      products: [
        { productId: product.productId, priceCents: 425, inventoryTotal: 18 },
      ],
      pickups: [
        {
          dropId: drop.dropId,
          date: '2027-01-07',
          startTime: '16:00',
          endTime: '19:00',
          timezone: 'America/Denver',
          active: true,
        },
      ],
    },
    { dropId: drop.dropId },
  );
  const preview = await invoke('GET /admin/drops/{dropId}/preview', undefined, {
    dropId: drop.dropId,
  });
  assert.equal(preview.drop.status, 'DRAFT');
  assert.equal(preview.preview, true);
  assert.equal(preview.actionsEnabled, false);
  assert.equal(preview.products[0].product.description, 'Saved description');
  assert.equal(preview.products[0].dropProduct.priceCents, 425);
  assert.equal(preview.inventory[0].total, 18);
  assert.equal(preview.inventory[0].reserved, 0);
  assert.equal(preview.pickupDates[0].startTime, '16:00');
  const handler = isolatedCatalog(
    () => new DynamoCatalogRepository(client, ISOLATED_TABLE),
  );
  for (const routeKey of [
    'POST /carts',
    'POST /carts/{cartId}/payment/start',
    'POST /waitlists',
    'GET /drops/current',
    'GET /drops/{dropId}',
  ])
    assert.equal(
      (
        await handler({
          routeKey,
          requestContext: {
            requestId: 'local',
            http: { method: routeKey.split(' ')[0] },
          },
        })
      ).statusCode,
      404,
    );
  assert.equal(
    (
      await handler({
        routeKey: 'GET /admin/products',
        requestContext: { requestId: 'local', http: { method: 'GET' } },
      })
    ).statusCode,
    401,
  );
  console.log(
    'PASS: isolated initialization, integrity, Product edit/reload, draft save/reload, read-only preview and route isolation (loopback only).',
  );
} finally {
  if (created)
    await raw.send(new DeleteTableCommand({ TableName: ISOLATED_TABLE }));
  raw.destroy();
}
