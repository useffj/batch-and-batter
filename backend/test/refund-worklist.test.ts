import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attention, RefundWorklist } from '../src/refund-worklist';
import { refundOperation } from '../src/refund-domain';
import { createHandler, type ApiEvent } from '../src/api';
import { fakeRepository } from './fixtures';
import { readFileSync } from 'node:fs';
const now = Date.parse('2026-10-22T18:00:00Z');
for (const [status, threshold, label] of [
  ['AUTHORIZED', 3600000, 'Authorization awaiting processing'],
  ['DISPATCHED', 3600000, 'Dispatched outcome not confirmed'],
  ['PENDING', 86400000, 'Long-running pending refund'],
] as const) {
  test(status + ' exact aging boundary uses creation, not poll/backoff', () => {
    const op = {
      status,
      createdAt: new Date(now - threshold).toISOString(),
      updatedAt: new Date(now).toISOString(),
      nextCheckAt: new Date(now + 86400000).toISOString(),
    } as typeof refundOperation._output;
    assert.equal(attention(op, now), label);
    assert.equal(attention(op, now - 1), null);
  });
}
for (const status of ['SUCCEEDED', 'CANCELED'] as const)
  test(status + ' is not attention simply because old', () =>
    assert.equal(
      attention(
        {
          status,
          createdAt: '2000-01-01T00:00:00Z',
        } as typeof refundOperation._output,
        now,
      ),
      null,
    ),
  );
test('read-only module cannot import provider/coordinator or issue writes', () => {
  const s = readFileSync('src/refund-worklist.ts', 'utf8');
  assert(!/from ['"].*(?:refund-provider|\/refunds)['"]/.test(s));
  assert.deepEqual(
    [
      ...new Set([...s.matchAll(/new (\w+Command)\(/g)].map((m) => m[1])),
    ].sort(),
    ['GetCommand', 'QueryCommand'],
  );
});
test('invalid scopes and cursors rejected before database access', async () => {
  const r = new RefundWorklist(
    {
      send: async () => {
        throw Error('DATABASE_MUST_NOT_BE_CALLED');
      },
    } as any,
    'commerce',
    'operations',
  );
  for (const q of [
    {},
    { dropId: 'bad' },
    { pickupDate: '2026-10-20', cursor: 'bad' },
    { pickupDate: '2026-10-20', reference: 'BB-222222222222' },
  ])
    await assert.rejects(
      () => r.list(q),
      (e) =>
        (e as any).statusCode === 400 ||
        (e as Error).message.includes('Invalid scope'),
    );
});
test('worklist requires admin access and never activates refund coordinator', async () => {
  let reads = 0;
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
    undefined,
    () => {
      throw Error('EXECUTION_MUST_NOT_RUN');
    },
    () =>
      ({
        list: async () => {
          reads++;
          return { rows: [], nextCursor: null };
        },
      }) as any,
  );
  const event: ApiEvent = {
    routeKey: 'GET /admin/refund-worklist',
    queryStringParameters: { pickupDate: '2026-10-20' },
    requestContext: { requestId: 'synthetic', http: { method: 'GET' } },
  };
  assert.equal((await h(event)).statusCode, 401);
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
  assert.equal((await h(event)).statusCode, 403);
  assert.equal(reads, 0);
  event.requestContext.authorizer.jwt!.claims!['cognito:groups'] = [
    'batch-and-batter-admins',
  ];
  const r = await h(event);
  assert.equal(r.statusCode, 200);
  assert.match(r.headers['cache-control'], /no-store/);
  assert.equal(reads, 1);
});
