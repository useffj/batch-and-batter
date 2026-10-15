import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, type ApiEvent } from '../src/api';
import { fakeRepository } from './fixtures';
import { orderDto, AdminOrders } from '../src/admin-orders';
import { newOrderReference, orderIndexKeys } from '../src/order-reference';
import { orderSchema } from '../src/payment-domain';
for (const route of ['GET /admin/orders', 'GET /admin/orders/{orderId}'])
  test(
    route + ' rejects unauthorized access before data retrieval',
    async () => {
      const handler = createHandler(
        () => fakeRepository(),
        undefined,
        undefined,
        undefined,
        undefined,
        () => {
          throw Error('must not read');
        },
      );
      const event: ApiEvent = {
        routeKey: route,
        requestContext: { requestId: 'synthetic', http: { method: 'GET' } },
      };
      assert.equal((await handler(event)).statusCode, 401);
      event.requestContext.authorizer = {
        jwt: {
          claims: {
            token_use: 'access',
            sub: 'synthetic',
            username: 'synthetic',
            'cognito:groups': ['customer'],
          },
        },
      };
      assert.equal((await handler(event)).statusCode, 403);
    },
  );
test('orders require scoped bounded Query; no Scan or write', async () => {
  const calls: any[] = [];
  const repo = new AdminOrders(
    {
      send: async (c: any) => {
        calls.push(c);
        return { Items: [] };
      },
    } as any,
    'synthetic',
  );
  await repo.list({ dropId: '01K00000000000000000000001', status: 'PAID' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].constructor.name, 'QueryCommand');
  assert.equal(calls[0].input.Limit, 20);
  assert.equal(calls[0].input.ScanIndexForward, false);
  assert.equal(calls[0].input.IndexName, 'GSI2');
  assert.equal(calls[0].input.ConsistentRead, undefined);
  await assert.rejects(repo.list({}));
});
test('reference generator uses cryptographic readable code and legacy orders remain schema compatible', () => {
  for (let i = 0; i < 100; i++)
    assert.match(
      newOrderReference(),
      /^BB-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/,
    );
  assert.equal(orderSchema.shape.displayOrderNumber.isOptional(), true);
  assert.deepEqual(
    orderIndexKeys({
      dropId: 'drop',
      orderId: 'order',
      createdAt: 'time',
      pickup: { date: 'date' },
    }),
    {
      GSI1PK: 'PICKUP#date',
      GSI1SK: 'ORDER#time#order',
      GSI2PK: 'DROP#drop',
      GSI2SK: 'ORDER#time#order',
    },
  );
  const dto = orderDto({
    orderId: 'id',
    status: 'PAID',
    paymentStatus: 'CAPTURED',
    customer: {
      name: 'Synthetic',
      email: 'private@example.test',
      phone: 'private',
    },
    totalCents: 123,
    currency: 'usd',
    pickup: { date: '2026-10-22' },
    createdAt: 'time',
    updatedAt: 'time',
    paymentAttemptId: 'private',
    settlement: { private: 'data' },
  } as any);
  assert(!JSON.stringify(dto).includes('private'));
  assert.equal(dto.fulfillmentStatus, null);
});
