import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CreateScheduleCommand,
  GetScheduleCommand,
  type SchedulerClient,
} from '@aws-sdk/client-scheduler';
import {
  SchedulerOpeningSchedules,
  schedulerSource,
} from '../src/opening-schedules';
import { createAutoOpenHandler } from '../src/auto-open';
import { createEntrypoint } from '../src/handler';
import { createHandler, type ApiEvent } from '../src/api';
import { ADMIN_GROUP } from '../src/admin-auth';
import { catalogKeys } from '../src/keys';
import { compositionStore } from './composition-store';
import {
  drop,
  dropId,
  productId,
  relation,
  inventory,
  pickup,
} from './fixtures';

const internal = { source: schedulerSource, operation: 'openDrop', dropId };
const key = catalogKeys.drop(dropId);
const scheduled = { ...drop, status: 'SCHEDULED' as const };
function ready(status: 'DRAFT' | 'SCHEDULED' = 'SCHEDULED') {
  const s = compositionStore();
  for (const item of [
    { ...scheduled, status, ...key },
    { ...relation, ...catalogKeys.dropProduct(dropId, productId) },
    {
      ...inventory,
      reserved: 0,
      sold: 0,
      ...catalogKeys.inventory(dropId, productId),
    },
    { ...pickup, ...catalogKeys.pickup(dropId, pickup.date) },
    {
      storefrontDropId: dropId,
      updatedAt: drop.updatedAt,
      ...catalogKeys.storefront,
    },
  ])
    s.put(item);
  return s;
}
function scheduler() {
  let saved: Record<string, unknown> | undefined;
  const calls: (CreateScheduleCommand | GetScheduleCommand)[] = [];
  const client = {
    send: async (command: CreateScheduleCommand | GetScheduleCommand) => {
      calls.push(command);
      if (command instanceof CreateScheduleCommand) {
        if (saved)
          throw Object.assign(new Error('exists'), {
            name: 'ConflictException',
          });
        const { ClientToken, ...config } = command.input;
        saved = structuredClone(config);
        return {};
      }
      return structuredClone(saved);
    },
  } as unknown as Pick<SchedulerClient, 'send'>;
  return {
    service: new SchedulerOpeningSchedules(
      client,
      'test-openings',
      'arn:lambda:exact',
      'arn:role:exact',
    ),
    calls,
    get saved() {
      return saved!;
    },
  };
}
function event(route = 'publish'): ApiEvent {
  return {
    routeKey: `POST /admin/drops/{dropId}/${route}`,
    pathParameters: { dropId },
    body: '{}',
    requestContext: {
      requestId: 'safe-test',
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

test('deterministic schedule verifies exact target, payload, UTC rounding, retries and cleanup on every ensure', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse(drop.opensAt) - 60000);
  const s = scheduler();
  const d = { ...scheduled, opensAt: drop.opensAt.replace('.000Z', '.123Z') };
  await s.service.ensure(d);
  await s.service.ensure(d);
  assert.equal(s.calls.length, 4);
  const first = (s.calls[0] as CreateScheduleCommand).input;
  assert.deepEqual(first, (s.calls[2] as CreateScheduleCommand).input);
  assert.match(first.ClientToken!, /^[a-f0-9]{64}$/);
  assert.deepEqual(s.saved, {
    Name: `open-${dropId}`,
    GroupName: 'test-openings',
    ScheduleExpression: `at(${new Date(Math.ceil(Date.parse(d.opensAt) / 1000) * 1000).toISOString().slice(0, 19)})`,
    ScheduleExpressionTimezone: 'UTC',
    FlexibleTimeWindow: { Mode: 'OFF' },
    State: 'ENABLED',
    ActionAfterCompletion: 'DELETE',
    Target: {
      Arn: 'arn:lambda:exact',
      RoleArn: 'arn:role:exact',
      Input: JSON.stringify(internal),
      RetryPolicy: { MaximumEventAgeInSeconds: 900, MaximumRetryAttempts: 3 },
    },
  });
});
for (const field of [
  'ScheduleExpression',
  'State',
  'Target',
  'ActionAfterCompletion',
  'KmsKeyArn',
])
  test(`conflicting existing schedule ${field} fails closed`, async (t) => {
    t.mock.method(Date, 'now', () => Date.parse(drop.opensAt) - 60000);
    const s = scheduler();
    await s.service.ensure(scheduled);
    s.saved[field] = 'unexpected';
    await assert.rejects(
      s.service.ensure(scheduled),
      /OPENING_SCHEDULE_CONFLICT/,
    );
  });
test('past opening never creates schedule', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse(drop.opensAt));
  const s = scheduler();
  await assert.rejects(s.service.ensure(scheduled), /OPENING_TIME_PASSED/);
  assert.equal(s.calls.length, 0);
});
test('publish schedules committed stored Drop and retains exact admin response; reconciliation is idempotent', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse(drop.opensAt) - 60000);
  const s = ready('DRAFT');
  const schedules = scheduler();
  const handler = createHandler(
    () => s.repository,
    () => ({
      ensure: async (d) => {
        assert.equal(s.get(key)!.status, 'SCHEDULED');
        assert.equal(d.opensAt, s.get(key)!.opensAt);
        await schedules.service.ensure(d);
      },
    }),
  );
  const result = await handler(event());
  assert.equal(result.statusCode, 200);
  assert.deepEqual(Object.keys(JSON.parse(result.body)).sort(), [
    'drop',
    'storefront',
  ]);
  const before = structuredClone(s.items);
  assert.equal((await handler(event('reconcile-opening'))).statusCode, 200);
  assert.deepEqual(s.items, before);
  assert.equal((await handler(event())).statusCode, 409);
});
test('schedule failure honestly reports committed publication and recovery does not republish', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse(drop.opensAt) - 60000);
  const s = ready('DRAFT');
  let fail = true;
  const handler = createHandler(
    () => s.repository,
    () => ({
      ensure: async () => {
        if (fail) throw new Error('secret AWS payload');
      },
    }),
  );
  const result = await handler(event());
  assert.equal(result.statusCode, 503);
  assert.equal(JSON.parse(result.body).code, 'PUBLICATION_SCHEDULING_FAILED');
  assert.ok(!result.body.includes('secret'));
  assert.equal(s.get(key)!.status, 'SCHEDULED');
  assert.equal(s.get(catalogKeys.storefront)!.storefrontDropId, dropId);
  assert.equal((await handler(event())).statusCode, 409);
  fail = false;
  const before = structuredClone(s.items);
  assert.equal((await handler(event('reconcile-opening'))).statusCode, 200);
  assert.deepEqual(s.items, before);
});
for (const offset of [-1, 0, 1])
  test(`automatic opening server-time boundary ${offset}ms`, async (t) => {
    t.mock.method(Date, 'now', () => Date.parse(drop.opensAt) + offset);
    const s = ready();
    const handler = createAutoOpenHandler(() => s.repository);
    if (offset < 0) {
      await assert.rejects(handler(internal), /OPENING_TOO_EARLY/);
      assert.equal(s.get(key)!.status, 'SCHEDULED');
    } else {
      assert.deepEqual(await handler(internal), { result: 'opened' });
      assert.equal(s.get(key)!.status, 'OPEN');
      assert.deepEqual(await handler(internal), {
        result: 'terminal',
        code: 'DROP_NOT_EDITABLE',
      });
    }
  });
test('concurrent automatic attempts permit one transition', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse(drop.opensAt));
  const s = ready();
  const handler = createAutoOpenHandler(() => s.repository);
  const results = await Promise.all([handler(internal), handler(internal)]);
  assert.equal(results.filter((r) => r.result === 'opened').length, 1);
  assert.equal(s.get(key)!.status, 'OPEN');
});
test('storefront conflict is terminal; product revision race is retryable', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse(drop.opensAt));
  const s = ready();
  s.remove(catalogKeys.storefront);
  assert.deepEqual(await createAutoOpenHandler(() => s.repository)(internal), {
    result: 'terminal',
    code: 'STOREFRONT_CONFLICT',
  });
  const r = ready();
  r.hooks.beforeTransaction = () => {
    const pk = catalogKeys.product(productId);
    r.put({ ...r.get(pk)!, updatedAt: '2099-01-01T00:00:00.000Z' });
  };
  await assert.rejects(
    createAutoOpenHandler(() => r.repository)(internal),
    /COMPOSITION_CONFLICT/,
  );
  assert.equal(r.get(key)!.status, 'SCHEDULED');
});
test('malformed events and HTTP spoofing cannot invoke internal opening; logs omit secrets', async (t) => {
  const logs: string[] = [];
  t.mock.method(console, 'info', (v: string) => logs.push(v));
  t.mock.method(console, 'error', (v: string) => logs.push(v));
  let reads = 0;
  const handler = createEntrypoint(
    () => {
      reads++;
      throw new Error('unexpected');
    },
    () => {
      throw new Error('unexpected');
    },
  );
  for (const payload of [
    { ...internal, operation: 'forceOpen' },
    { ...internal, token: 'SECRET' },
    { ...internal, dropId: 'bad' },
    null,
  ])
    assert.deepEqual(await handler(payload), { result: 'rejected' });
  const request = {
    ...event('open'),
    body: JSON.stringify(internal),
    requestContext: { requestId: 'safe', http: { method: 'POST' } },
  };
  assert.equal(
    ((await handler(request)) as { statusCode: number }).statusCode,
    401,
  );
  assert.equal(
    (
      (await handler({
        ...request,
        routeKey: 'GET /health',
        requestContext: {
          requestId: 'health',
          http: { method: 'GET', path: '/health' },
        },
      })) as { statusCode: number }
    ).statusCode,
    200,
  );
  assert.equal(reads, 0);
  assert.ok(logs.some((l) => JSON.parse(l).operation === 'autoOpenDrop'));
  assert.ok(!logs.join('').includes('SECRET'));
  assert.ok(!logs.join('').includes(dropId));
});
test('reconciliation rejects past time and wrong pointer without writes', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse(drop.opensAt));
  const s = ready();
  const service = scheduler();
  const handler = createHandler(
    () => s.repository,
    () => service.service,
  );
  const before = structuredClone(s.items);
  const response = await handler(event('reconcile-opening'));
  assert.equal(response.statusCode, 409);
  assert.equal(JSON.parse(response.body).code, 'OPENING_TIME_PASSED');
  assert.deepEqual(s.items, before);
  s.remove(catalogKeys.storefront);
  assert.equal(
    JSON.parse((await handler(event('reconcile-opening'))).body).code,
    'STOREFRONT_CONFLICT',
  );
  assert.equal(service.calls.length, 0);
});

test('ambiguous accepted CreateSchedule recovers by verifying the same deterministic schedule', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse(drop.opensAt) - 60000);
  let saved: Record<string, unknown> | undefined;
  let creates = 0;
  const client = {
    send: async (command: CreateScheduleCommand | GetScheduleCommand) => {
      if (command instanceof CreateScheduleCommand) {
        creates++;
        if (saved)
          throw Object.assign(new Error('exists'), {
            name: 'ConflictException',
          });
        const { ClientToken, ...config } = command.input;
        saved = config;
        throw new Error('network timeout');
      }
      return saved;
    },
  } as unknown as Pick<SchedulerClient, 'send'>;
  const service = new SchedulerOpeningSchedules(
    client,
    'group',
    'target',
    'role',
  );
  await assert.rejects(service.ensure(scheduled), /network timeout/);
  await service.ensure(scheduled);
  assert.equal(creates, 2);
  assert.equal(saved!.Name, `open-${dropId}`);
});
test('successful idempotent CreateSchedule cannot mask altered existing schedule', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse(drop.opensAt) - 60000);
  const client = {
    send: async (command: CreateScheduleCommand | GetScheduleCommand) =>
      command instanceof CreateScheduleCommand
        ? {}
        : { Name: `open-${dropId}`, Target: { Arn: 'wrong' } },
  } as unknown as Pick<SchedulerClient, 'send'>;
  await assert.rejects(
    new SchedulerOpeningSchedules(client, 'group', 'target', 'role').ensure(
      scheduled,
    ),
    /OPENING_SCHEDULE_CONFLICT/,
  );
});
test('automatic transient errors are sanitized and invalid readiness is explicit terminal rejection', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse(drop.opensAt));
  const records: string[] = [];
  t.mock.method(console, 'error', (record: string) => records.push(record));
  const s = ready();
  s.hooks.failure = new Error('SECRET raw AWS detail');
  await assert.rejects(
    createAutoOpenHandler(() => s.repository)(internal, {
      awsRequestId: 'lambda-safe',
    }),
    /^Error: Automatic opening retry required: INTERNAL_ERROR$/,
  );
  assert.equal(s.get(key)!.status, 'SCHEDULED');
  const r = ready();
  r.remove(catalogKeys.pickup(dropId, pickup.date));
  assert.deepEqual(await createAutoOpenHandler(() => r.repository)(internal), {
    result: 'rejected',
    code: 'DROP_NOT_READY',
  });
  assert.ok(!records.join('').includes('SECRET'));
  assert.equal(JSON.parse(records[0]).lambdaRequestId, 'lambda-safe');
});
for (const status of [
  'DRAFT',
  'OPEN',
  'PAUSED',
  'CLOSED',
  'SOLD_OUT',
  'COMPLETED',
])
  test(`automatic event cannot rewrite ${status}`, async (t) => {
    t.mock.method(Date, 'now', () => Date.parse(drop.opensAt));
    const s = ready();
    s.put({ ...s.get(key)!, status });
    const before = structuredClone(s.items);
    assert.deepEqual(
      await createAutoOpenHandler(() => s.repository)(internal),
      { result: 'terminal', code: 'DROP_NOT_EDITABLE' },
    );
    assert.deepEqual(s.items, before);
  });
test('reconciliation requires admin auth and hides service failure details', async () => {
  const s = ready();
  let calls = 0;
  const handler = createHandler(
    () => s.repository,
    () => ({
      ensure: async () => {
        calls++;
        throw new Error('SECRET');
      },
    }),
  );
  const anonymous = {
    ...event('reconcile-opening'),
    requestContext: { requestId: 'anonymous', http: { method: 'POST' } },
  };
  assert.equal((await handler(anonymous)).statusCode, 401);
  assert.equal(calls, 0);
  const response = await handler(event('reconcile-opening'));
  assert.equal(response.statusCode, 503);
  assert.equal(JSON.parse(response.body).code, 'OPENING_SCHEDULE_UNCONFIRMED');
  assert.ok(!response.body.includes('SECRET'));
});
