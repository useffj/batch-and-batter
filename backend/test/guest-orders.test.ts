import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accessExpiration,
  pickupCutoff,
  denverWall,
  GuestOrders,
} from '../src/guest-orders';
import { createHandler, type ApiEvent } from '../src/api';
import { fakeRepository } from './fixtures';
for (const [date, time, expected] of [
  ['2026-03-08', '19:00', '2026-04-08T01:00:00.000Z'],
  ['2026-11-01', '19:00', '2026-12-02T02:00:00.000Z'],
] as const)
  test('expiration uses Denver pickup end across DST ' + date, () =>
    assert.equal(accessExpiration(date, time), expected),
  );
test('ambiguous or nonexistent pickup end fails closed', () => {
  assert.throws(() => accessExpiration('2026-03-08', '02:30'));
  assert.throws(() => accessExpiration('2026-11-01', '01:30'));
});
test('default and configured cutoff compare server Denver wall time', () => {
  assert.equal(pickupCutoff('2026-11-02'), '2026-11-01T15:00');
  assert.equal(pickupCutoff('2026-03-09', '14:30'), '2026-03-08T14:30');
  assert.equal(
    denverWall(Date.parse('2026-11-01T22:00:00Z')),
    '2026-11-01T15:00',
  );
  assert.equal(
    denverWall(Date.parse('2026-03-08T21:00:00Z')),
    '2026-03-08T15:00',
  );
});
for (const route of [
  'GET /admin/orders/{orderId}/access',
  'POST /admin/orders/{orderId}/access/reissue',
  'POST /admin/orders/{orderId}/access/revoke',
])
  test(
    route + ' requires administrator access before repository access',
    async () => {
      const handler = createHandler(() => fakeRepository());
      const e: ApiEvent = {
        routeKey: route,
        requestContext: {
          requestId: 'synthetic',
          http: { method: route.split(' ')[0] },
        },
      };
      assert.equal((await handler(e)).statusCode, 401);
      e.requestContext.authorizer = {
        jwt: {
          claims: {
            token_use: 'access',
            sub: 'synthetic',
            username: 'synthetic',
            'cognito:groups': ['customer'],
          },
        },
      };
      assert.equal((await handler(e)).statusCode, 403);
    },
  );
test('guest routes require a trusted source address and never expose exceptions', async () => {
  const h = createHandler(
    () => fakeRepository(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () =>
      new GuestOrders(
        {
          send: async () => {
            throw Error('private detail');
          },
        } as any,
        'a',
        'b',
        'c',
        'https://shop.test',
      ),
  );
  const r = await h({
    routeKey: 'POST /orders/manage/view',
    body: '{"token":"private"}',
    requestContext: { requestId: 'synthetic', http: { method: 'POST' } },
  });
  assert.equal(r.statusCode, 403);
  assert(!r.body.includes('private'));
  assert.match(
    r.headers!['Cache-Control'] ?? r.headers!['cache-control'],
    /no-store/,
  );
});
