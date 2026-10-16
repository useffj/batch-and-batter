import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cancellationDeadline,
  requestInput,
} from '../src/cancellation-requests';
import { createHandler, type ApiEvent } from '../src/api';
import { fakeRepository } from './fixtures';
test('cancellation deadline is elapsed 24h across Denver DST, not previous-day wall time', () => {
  assert.equal(
    cancellationDeadline('2026-03-08', '16:00'),
    '2026-03-07T22:00:00.000Z',
  );
  assert.equal(
    cancellationDeadline('2026-11-01', '16:00'),
    '2026-10-31T23:00:00.000Z',
  );
  assert.equal(
    cancellationDeadline('2026-10-22', '16:00', 48),
    '2026-10-20T22:00:00.000Z',
  );
  assert.throws(() => cancellationDeadline('2026-03-08', '02:30'));
  assert.throws(() => cancellationDeadline('2026-11-01', '01:30'));
  assert.throws(() => cancellationDeadline('2026-10-22', '16:00', 0));
});
test('exception reason and bounded strict intake required', () => {
  assert(
    !requestInput.safeParse({
      requestId: '48f38775-37c7-4c24-85b1-8b273261ad21',
      type: 'EXCEPTION',
      reason: ' ',
    }).success,
  );
});
for (const route of [
  'GET /admin/orders/{orderId}/requests',
  'POST /admin/orders/{orderId}/requests/review',
])
  test(route + ' requires administrator', async () => {
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
          sub: 'synthetic',
          username: 'synthetic',
          token_use: 'access',
          'cognito:groups': ['customer'],
        },
      },
    };
    assert.equal((await handler(e)).statusCode, 403);
  });
