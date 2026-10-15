// Disposable loopback-only fixtures shared by acceptance and its local preview.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
} = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');
const { orderSchema, orderKey } = require('../dist/src/payment-domain');
const {
  orderIndexKeys,
  referenceKey,
  newOrderReference,
} = require('../dist/src/order-reference');
const { AdminOrders } = require('../dist/src/admin-orders');
export async function fixtures() {
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
    table = 'bb-orders-local-' + randomUUID();
  await raw.send(
    new CreateTableCommand({
      TableName: table,
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        'PK',
        'SK',
        'GSI1PK',
        'GSI1SK',
        'GSI2PK',
        'GSI2SK',
      ].map((AttributeName) => ({ AttributeName, AttributeType: 'S' })),
      GlobalSecondaryIndexes: ['GSI1', 'GSI2'].map((i) => ({
        IndexName: i,
        KeySchema: [
          { AttributeName: i + 'PK', KeyType: 'HASH' },
          { AttributeName: i + 'SK', KeyType: 'RANGE' },
        ],
        Projection: {
          ProjectionType: 'INCLUDE',
          NonKeyAttributes: ['orderId', 'status', 'dropId'],
        },
      })),
    }),
  );
  const id = (n) => '01K' + String(n).padStart(23, '0');
  const drops = [
    {
      dropId: id(1),
      name: 'Synthetic autumn Drop',
      opensAt: '2026-10-18T18:00:00.000Z',
      status: 'OPEN',
    },
    {
      dropId: id(2),
      name: 'Synthetic winter Drop',
      opensAt: '2026-10-25T18:00:00.000Z',
      status: 'DRAFT',
    },
  ];
  const orders = [];
  for (let n = 0; n < 25; n++) {
    const base = {
      orderId: id(100 + n),
      dropId: drops[n === 24 ? 1 : 0].dropId,
      cartId: id(200 + n),
      paymentAttemptId: id(300 + n),
      displayOrderNumber: newOrderReference(),
      status: n % 2 ? 'PAID' : 'PAYMENT_PENDING',
      paymentStatus: n % 2 ? 'CAPTURED' : 'CREATED',
      items: [
        {
          productId: id(500),
          name: 'Historical chocolate cookie',
          quantity: 2,
          unitPriceCents: 425,
          cookieUnits: 1,
        },
      ],
      subtotalCents: 850,
      taxCents: 70,
      feeCents: 25,
      totalCents: 945,
      currency: 'usd',
      customer: {
        name: 'Synthetic customer ' + n,
        email: 'synthetic' + n + '@example.test',
        phone: '+15555550123',
        smsTransactionalConsent: false,
      },
      pickup: {
        dropId: drops[n === 24 ? 1 : 0].dropId,
        date: n % 2 ? '2026-10-22' : '2026-10-23',
        startTime: '16:00',
        endTime: '19:00',
        timezone: 'America/Denver',
        active: true,
        location: 'Synthetic bakery',
        instructions: 'Local fixture only',
      },
      createdAt: new Date(Date.UTC(2026, 9, 18, 18, n)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 9, 18, 18, n)).toISOString(),
    };
    const order = orderSchema.parse({ ...base, ...orderIndexKeys(base) });
    orders.push(order);
    await client.send(
      new PutCommand({
        TableName: table,
        Item: { ...order, ...orderKey(order.orderId) },
      }),
    );
    await client.send(
      new PutCommand({
        TableName: table,
        Item: {
          ...referenceKey(order.displayOrderNumber),
          orderId: order.orderId,
        },
      }),
    );
  }
  return {
    client,
    table,
    orders,
    drops,
    repository: new AdminOrders(client, table),
    close: async () => {
      await raw.send(new DeleteTableCommand({ TableName: table }));
      raw.destroy();
    },
  };
}
