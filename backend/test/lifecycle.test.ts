import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { createHandler, type ApiEvent } from '../src/api';
import { ADMIN_GROUP } from '../src/admin-auth';
import { createAutoOpenHandler } from '../src/auto-open';
import { CatalogWriteError } from '../src/repository';
import { dropStatusSchema, type Drop } from '../src/domain';
import { catalogKeys } from '../src/keys';
import { compositionStore, cancellation } from './composition-store';
import {
  drop,
  dropId,
  productId,
  otherProductId,
  relation,
  inventory,
  pickup,
  fakeRepository,
} from './fixtures';

const dk = catalogKeys.drop(dropId),
  pk = catalogKeys.product(productId),
  pointer = catalogKeys.storefront;
const rk = catalogKeys.dropProduct(dropId, productId),
  ik = catalogKeys.inventory(dropId, productId),
  pickupKey = catalogKeys.pickup(dropId, pickup.date);
const openingTime = Date.parse(drop.opensAt);
const methods = ['pauseDrop', 'resumeDrop', 'closeDrop'] as const;
type Method = (typeof methods)[number];
const sources: Record<Method, Drop['status']> = {
  pauseDrop: 'OPEN',
  resumeDrop: 'PAUSED',
  closeDrop: 'OPEN',
};
const targets: Record<Method, Drop['status']> = {
  pauseDrop: 'PAUSED',
  resumeDrop: 'OPEN',
  closeDrop: 'CLOSED',
};
function store(status: Drop['status'] = 'OPEN') {
  const s = compositionStore();
  for (const item of [
    { ...drop, status, ...dk },
    { ...relation, ...rk },
    { ...inventory, ...ik },
    { ...pickup, ...pickupKey },
    { storefrontDropId: dropId, updatedAt: drop.updatedAt, ...pointer },
  ])
    s.put(item);
  return s;
}
function event(method: Method): ApiEvent {
  return {
    routeKey: `POST /admin/drops/{dropId}/${method.replace('Drop', '')}`,
    pathParameters: { dropId },
    body: '{}',
    requestContext: {
      requestId: 'lifecycle-request',
      http: { method: 'POST' },
      authorizer: {
        jwt: {
          claims: {
            token_use: 'access',
            sub: 'test-admin',
            username: 'test-admin',
            'cognito:groups': [ADMIN_GROUP],
          },
        },
      },
    },
  };
}
const fails = (code: string) => (e: unknown) =>
  e instanceof CatalogWriteError && e.code === code;
const transactions = (s: ReturnType<typeof store>) =>
  s.commands.filter((c) => c instanceof TransactWriteCommand);

for (const method of methods)
  test(`${method}: exact transaction, revision, metadata preservation and unique Catalog targets`, async (t) => {
    t.mock.method(Date, 'now', () => openingTime);
    const s = store(sources[method]);
    const before = structuredClone(s.items);
    const result = await s.repository[method](dropId);
    assert.deepEqual(result, {
      ...drop,
      status: targets[method],
      updatedAt: new Date(
        Math.max(openingTime, Date.parse(drop.updatedAt) + 1),
      ).toISOString(),
    });
    const txs = transactions(s);
    assert.equal(txs.length, 1);
    const actions = txs[0].input.TransactItems!;
    const token = method === 'resumeDrop' ? ':paused' : ':source';
    assert.deepEqual(actions[0], {
      Put: {
        TableName: 'test-catalog',
        Item: { ...result, ...dk },
        ConditionExpression: `attribute_exists(PK) AND #status = ${token} AND #updated = :expected`,
        ExpressionAttributeNames: {
          '#status': 'status',
          '#updated': 'updatedAt',
        },
        ExpressionAttributeValues: {
          [token]: sources[method],
          ':expected': drop.updatedAt,
        },
      },
    });
    const pointerCheck = {
      TableName: 'test-catalog',
      Key: pointer,
      ConditionExpression: '#storefrontDropId = :dropId',
      ExpressionAttributeNames: { '#storefrontDropId': 'storefrontDropId' },
      ExpressionAttributeValues: { ':dropId': dropId },
    };
    if (method === 'pauseDrop') assert.equal(actions.length, 1);
    if (method === 'closeDrop') {
      assert.equal(actions.length, 2);
      assert.deepEqual(actions[1], { Delete: pointerCheck });
      assert.equal(s.get(pointer), undefined);
      before.delete(`${pointer.PK}/${pointer.SK}`);
    }
    if (method === 'resumeDrop') {
      assert.equal(actions.length, 3);
      assert.deepEqual(actions[1], { ConditionCheck: pointerCheck });
      assert.deepEqual(actions[2], {
        ConditionCheck: {
          TableName: 'test-catalog',
          Key: pk,
          ConditionExpression:
            'attribute_exists(PK) AND #active = :active AND #updated = :expected',
          ExpressionAttributeNames: {
            '#active': 'active',
            '#updated': 'updatedAt',
          },
          ExpressionAttributeValues: {
            ':active': true,
            ':expected': s.get(pk)!.updatedAt,
          },
        },
      });
    }
    before.set(`${dk.PK}/${dk.SK}`, { ...result, ...dk });
    assert.deepEqual(s.items, before);
    assert.ok(
      s.commands
        .filter((c) => c instanceof GetCommand)
        .every((c) => c.input.ConsistentRead === true),
    );
  });
for (const method of methods)
  for (const status of dropStatusSchema.options.filter(
    (s) =>
      !(s === sources[method] || (method === 'closeDrop' && s === 'PAUSED')),
  ))
    test(`${method} rejects ${status}`, async () => {
      const s = store(status);
      const before = structuredClone(s.items);
      await assert.rejects(
        s.repository[method](dropId),
        fails('DROP_NOT_EDITABLE'),
      );
      assert.equal(transactions(s).length, 0);
      assert.deepEqual(s.items, before);
    });
test('close accepts PAUSED using exact source status and repeated close rejects', async () => {
  const s = store('PAUSED');
  await s.repository.closeDrop(dropId);
  assert.equal(
    transactions(s)[0].input.TransactItems![0].Put!.ExpressionAttributeValues![
      ':source'
    ],
    'PAUSED',
  );
  await assert.rejects(
    s.repository.closeDrop(dropId),
    fails('DROP_NOT_EDITABLE'),
  );
});
for (const method of methods)
  for (const missing of [true, false])
    test(`${method} rejects ${missing ? 'missing' : 'different'} storefront before writing`, async () => {
      const s = store(sources[method]);
      if (missing) s.remove(pointer);
      else s.put({ ...s.get(pointer)!, storefrontDropId: otherProductId });
      const before = structuredClone(s.items);
      await assert.rejects(
        s.repository[method](dropId),
        fails('STOREFRONT_CONFLICT'),
      );
      assert.equal(transactions(s).length, 0);
      assert.deepEqual(s.items, before);
    });
for (const method of methods)
  for (const change of ['missing', 'status', 'revision'])
    test(`${method} maps concurrent Drop ${change} by consistent reread`, async (t) => {
      t.mock.method(Date, 'now', () => openingTime);
      const s = store(sources[method]);
      s.hooks.beforeTransaction = () => {
        if (change === 'missing') s.remove(dk);
        else
          s.put({
            ...s.get(dk)!,
            ...(change === 'status'
              ? { status: 'CLOSED' }
              : { updatedAt: '2099-01-01T00:00:00.000Z' }),
          });
      };
      await assert.rejects(
        s.repository[method](dropId),
        fails(
          change === 'missing'
            ? 'DROP_NOT_FOUND'
            : change === 'status'
              ? 'DROP_NOT_EDITABLE'
              : 'COMPOSITION_CONFLICT',
        ),
      );
      assert.equal(transactions(s).length, 1);
      assert.ok(s.get(pointer));
    });
for (const method of ['resumeDrop', 'closeDrop'] as const)
  for (const missing of [true, false])
    test(`${method} protects pointer ${missing ? 'removal' : 'reassignment'} at commit`, async (t) => {
      t.mock.method(Date, 'now', () => openingTime);
      const s = store(sources[method]);
      s.hooks.beforeTransaction = () => {
        if (missing) s.remove(pointer);
        else s.put({ ...s.get(pointer)!, storefrontDropId: otherProductId });
      };
      await assert.rejects(
        s.repository[method](dropId),
        fails('STOREFRONT_CONFLICT'),
      );
      assert.equal(s.get(dk)!.status, sources[method]);
      if (!missing)
        assert.equal(s.get(pointer)!.storefrontDropId, otherProductId);
    });
for (const mutation of ['inactive', 'revision', 'deleted'])
  test(`resume rejects concurrent Product ${mutation}`, async (t) => {
    t.mock.method(Date, 'now', () => openingTime);
    const s = store('PAUSED');
    s.hooks.beforeTransaction = () => {
      if (mutation === 'deleted') s.remove(pk);
      else
        s.put({
          ...s.get(pk)!,
          ...(mutation === 'inactive'
            ? { active: false }
            : { updatedAt: '2099-01-01T00:00:00.000Z' }),
        });
    };
    await assert.rejects(
      s.repository.resumeDrop(dropId),
      fails('COMPOSITION_CONFLICT'),
    );
    assert.equal(s.get(dk)!.status, 'PAUSED');
  });
for (const mutation of [
  'inactiveProduct',
  'missingPickup',
  'missingInventory',
  'futureOpening',
])
  test(`resume readiness rejects ${mutation}`, async (t) => {
    t.mock.method(Date, 'now', () => openingTime);
    const s = store('PAUSED');
    if (mutation === 'inactiveProduct') s.put({ ...s.get(pk)!, active: false });
    if (mutation === 'missingPickup') s.remove(pickupKey);
    if (mutation === 'missingInventory') s.remove(ik);
    if (mutation === 'futureOpening')
      s.put({ ...s.get(dk)!, opensAt: '2099-01-01T00:00:00.000Z' });
    await assert.rejects(
      s.repository.resumeDrop(dropId),
      fails('DROP_NOT_READY'),
    );
    assert.equal(transactions(s).length, 0);
  });
for (const [winner, loser, source] of [
  ['pauseDrop', 'pauseDrop', 'OPEN'],
  ['pauseDrop', 'closeDrop', 'OPEN'],
  ['closeDrop', 'pauseDrop', 'OPEN'],
  ['resumeDrop', 'closeDrop', 'PAUSED'],
  ['closeDrop', 'resumeDrop', 'PAUSED'],
  ['closeDrop', 'closeDrop', 'OPEN'],
] as const)
  test(`${winner} wins race with ${loser}`, async (t) => {
    t.mock.method(Date, 'now', () => openingTime);
    const s = store(source);
    s.hooks.beforeTransaction = async () => {
      s.hooks.beforeTransaction = () => {};
      await s.repository[winner](dropId);
    };
    await assert.rejects(
      s.repository[loser](dropId),
      fails('DROP_NOT_EDITABLE'),
    );
    assert.equal(s.get(dk)!.status, targets[winner]);
    assert.equal(!!s.get(pointer), winner !== 'closeDrop');
  });
for (const method of methods)
  test(`${method} preserves cancellation order and unknown service errors`, async (t) => {
    t.mock.method(Date, 'now', () => openingTime);
    const cases: Array<[string[] | undefined, string | undefined]> = [
      [
        Array(
          method === 'pauseDrop' ? 1 : method === 'resumeDrop' ? 3 : 2,
        ).fill('ConditionalCheckFailed'),
        'COMPOSITION_CONFLICT',
      ],
      [
        Array(
          method === 'pauseDrop' ? 1 : method === 'resumeDrop' ? 3 : 2,
        ).fill('TransactionConflict'),
        'COMPOSITION_CONFLICT',
      ],
      [undefined, undefined],
      [['ProvisionedThroughputExceeded'], undefined],
    ];
    if (method !== 'pauseDrop')
      cases.push([
        [
          'None',
          'ConditionalCheckFailed',
          ...(method === 'resumeDrop' ? ['None'] : []),
        ],
        'STOREFRONT_CONFLICT',
      ]);
    if (method === 'resumeDrop')
      cases.push([
        ['None', 'None', 'ConditionalCheckFailed'],
        'COMPOSITION_CONFLICT',
      ]);
    for (const [codes, expected] of cases) {
      const s = store(sources[method]);
      const before = structuredClone(s.items);
      const error = cancellation(codes);
      s.hooks.failure = error;
      await assert.rejects(
        s.repository[method](dropId),
        expected ? fails(expected) : (e: unknown) => e === error,
      );
      assert.deepEqual(s.items, before);
    }
  });
for (const method of methods)
  test(`${method} HTTP auth, validation, DTO and safe logs; no scheduling`, async (t) => {
    t.mock.method(Date, 'now', () => openingTime);
    const logs: string[] = [];
    t.mock.method(console, 'info', (v: string) => logs.push(v));
    t.mock.method(console, 'error', (v: string) => logs.push(v));
    let accessed = 0;
    const denied = createHandler(() => {
      accessed++;
      throw new Error('unexpected');
    });
    const anonymous = {
      ...event(method),
      requestContext: { requestId: 'anon', http: { method: 'POST' } },
    };
    assert.equal((await denied(anonymous)).statusCode, 401);
    const wrong = event(method);
    wrong.requestContext.authorizer!.jwt!.claims!['cognito:groups'] = [
      'not-admin',
    ];
    assert.equal((await denied(wrong)).statusCode, 403);
    for (const body of [
      'null',
      '[]',
      '{"force":true}',
      '{"status":"OPEN"}',
      '{"updatedAt":"2099-01-01T00:00:00.000Z"}',
      '{"dropId":"other"}',
      '{"PK":"secret"}',
      '{"storefrontDropId":"other"}',
      'not-json',
    ])
      assert.equal((await denied({ ...event(method), body })).statusCode, 400);
    assert.equal(accessed, 0);
    const s = store(sources[method]);
    const handler = createHandler(
      () => s.repository,
      () => {
        throw new Error('Unexpected scheduler access');
      },
    );
    const response = await handler(
      { ...event(method), body: undefined },
      { awsRequestId: 'lambda-lifecycle' },
    );
    assert.equal(response.statusCode, 200);
    const dto = JSON.parse(response.body);
    assert.deepEqual(Object.keys(dto), ['drop']);
    assert.equal(dto.drop.dropId, dropId);
    assert.equal(dto.drop.status, targets[method]);
    assert.ok(dto.drop.updatedAt > drop.updatedAt);
    for (const field of ['PK', 'SK', 'products', 'pickupDates'])
      assert.ok(!(field in dto.drop));
    const repeated = await handler(event(method));
    assert.equal(repeated.statusCode, 409);
    assert.equal(JSON.parse(repeated.body).code, 'DROP_NOT_EDITABLE');
    const record = logs
      .map((l) => JSON.parse(l))
      .find((l) => l.operation === method && l.statusCode === 200);
    assert.equal(record.lambdaRequestId, 'lambda-lifecycle');
    assert.equal(record.requestId, 'lifecycle-request');
    assert.ok(logs.some((l) => JSON.parse(l).code === 'DROP_NOT_EDITABLE'));
    assert.ok(!logs.join('').includes('secret'));
  });
test('pause/resume/close public visibility and automatic-event regression', async (t) => {
  t.mock.method(Date, 'now', () => openingTime);
  const s = store();
  const handler = createHandler(() => s.repository);
  const current = () =>
    handler({
      routeKey: 'GET /drops/current',
      requestContext: { requestId: 'public', http: { method: 'GET' } },
    });
  assert.equal(JSON.parse((await current()).body).drop.status, 'OPEN');
  await s.repository.pauseDrop(dropId);
  assert.equal(JSON.parse((await current()).body).drop.status, 'PAUSED');
  const automatic = createAutoOpenHandler(() => s.repository);
  assert.deepEqual(
    await automatic({
      source: 'batch-and-batter.scheduler',
      operation: 'openDrop',
      dropId,
    }),
    { result: 'terminal', code: 'DROP_NOT_EDITABLE' },
  );
  await s.repository.resumeDrop(dropId);
  assert.equal(JSON.parse((await current()).body).drop.status, 'OPEN');
  await s.repository.closeDrop(dropId);
  assert.deepEqual(JSON.parse((await current()).body), { drop: null });
  const direct = await handler({
    routeKey: 'GET /drops/{dropId}',
    pathParameters: { dropId },
    requestContext: { requestId: 'direct', http: { method: 'GET' } },
  });
  assert.equal(JSON.parse(direct.body).drop.status, 'CLOSED');
  assert.deepEqual(
    await automatic({
      source: 'batch-and-batter.scheduler',
      operation: 'openDrop',
      dropId,
    }),
    { result: 'terminal', code: 'DROP_NOT_EDITABLE' },
  );
});
test('pause timestamp advances despite regressing clock', async (t) => {
  t.mock.method(Date, 'now', () => 0);
  const s = store();
  const result = await s.repository.pauseDrop(dropId);
  assert.equal(Date.parse(result.updatedAt), Date.parse(drop.updatedAt) + 1);
});
test('resume uses at most 98 active Product checks without chunking', async (t) => {
  t.mock.method(Date, 'now', () => openingTime);
  for (const count of [98, 99]) {
    const s = store('PAUSED');
    const product = s.get(pk)!;
    for (let i = 1; i < count; i++) {
      const id = i.toString().padStart(26, '0');
      s.put({ ...product, productId: id, ...catalogKeys.product(id) });
      s.put({
        ...relation,
        productId: id,
        ...catalogKeys.dropProduct(dropId, id),
      });
      s.put({
        ...inventory,
        productId: id,
        ...catalogKeys.inventory(dropId, id),
      });
    }
    if (count === 98) {
      await s.repository.resumeDrop(dropId);
      assert.equal(transactions(s)[0].input.TransactItems!.length, 100);
    } else {
      await assert.rejects(
        s.repository.resumeDrop(dropId),
        fails('DROP_NOT_READY'),
      );
      assert.equal(transactions(s).length, 0);
    }
  }
});
