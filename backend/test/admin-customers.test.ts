import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nameTerms,
  normalizeName,
  customerLookupRecords,
  contactKey,
  searchPartition,
} from '../src/customer-lookup';
import { AdminCustomers, customerRoutes } from '../src/admin-customers';
import { createHandler, type ApiEvent } from '../src/api';
import { fakeRepository } from './fixtures';
test('conservative name terms preserve punctuation, accents, and whitespace boundaries', () => {
  assert.deepEqual(nameTerms('  Michael   Johnson '), [
    'michael johnson',
    'michael',
    'johnson',
  ]);
  assert.deepEqual(nameTerms('Élodie O’Neil-Smith'), [
    'élodie o’neil-smith',
    'élodie',
    'o’neil-smith',
  ]);
  assert.equal(normalizeName('E\u0301LODIE'), 'élodie');
  assert.equal(searchPartition('MICHAEL'), searchPartition(' michael '));
  assert.equal(
    searchPartition(' Michael@Example.test '),
    searchPartition('michael@example.test'),
  );
});
test('lookup cardinality stays at five even with many tokens; keys contain no raw PII; exact contact tuples remain separate', () => {
  const o = {
    orderId: '01K00000000000000000000001',
    createdAt: '2026-10-15T12:00:00.000Z',
    customer: {
      name: 'a '.repeat(99) + 'z',
      email: 'person@example.test',
      phone: '+15555550123',
    },
  } as any;
  const rows = customerLookupRecords(o);
  assert.equal(rows.length, 5);
  assert.equal(new Set(rows.map((r) => r.PK + '|' + r.SK)).size, 5);
  assert(!JSON.stringify(rows).includes(o.customer.email));
  assert.notEqual(
    contactKey(o.customer),
    contactKey({ ...o.customer, email: 'other@example.test' }),
  );
  assert.notEqual(
    contactKey(o.customer),
    contactKey({ ...o.customer, name: 'Another' }),
  );
});
for (const route of customerRoutes)
  test(route + ' requires administrator before access', async () => {
    const h = createHandler(() => fakeRepository());
    const e: ApiEvent = {
      routeKey: route,
      requestContext: { requestId: 'synthetic', http: { method: 'POST' } },
    };
    assert.equal((await h(e)).statusCode, 401);
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
    assert.equal((await h(e)).statusCode, 403);
  });
test('queries are bounded consistent base-table reads; malformed search/cursor never accesses data', async () => {
  const calls: any[] = [];
  const repo = new AdminCustomers(
    {
      send: async (c: any) => {
        calls.push(c);
        return { Items: [] };
      },
    } as any,
    'local',
  );
  await repo.search({ query: 'Michael' });
  assert.equal(calls[0].constructor.name, 'QueryCommand');
  assert.equal(calls[0].input.Limit, 20);
  assert.equal(calls[0].input.ScanIndexForward, false);
  assert.equal(calls[0].input.ConsistentRead, true);
  assert.equal(calls[0].input.IndexName, undefined);
  for (const value of [
    { query: '' },
    { query: 'x'.repeat(255) },
    { query: 'bad@' },
    { query: 'Michael', cursor: 'e30' },
    { query: 'Michael', extra: true },
  ])
    await assert.rejects(repo.search(value));
  assert.equal(calls.length, 1);
});
