import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import {
  CreateScheduleCommand,
  GetScheduleCommand,
  type SchedulerClient,
} from '@aws-sdk/client-scheduler';
import { createHandler, type ApiEvent } from '../src/api';
import { ADMIN_GROUP } from '../src/admin-auth';
import { createAutoOpenHandler } from '../src/auto-open';
import {
  SchedulerOpeningSchedules,
  schedulerSource,
} from '../src/opening-schedules';
import { CatalogWriteError } from '../src/repository';
import { catalogKeys } from '../src/keys';
import { dropStatusSchema, type Drop } from '../src/domain';
import { compositionStore } from './composition-store';
import {
  drop,
  dropId,
  productId,
  otherProductId,
  product,
  relation,
  inventory,
  pickup,
} from './fixtures';

const now = Date.parse('2026-09-23T12:00:00.000Z');
const opensAt = '2026-09-24T12:00:00.000Z';
const dk = catalogKeys.drop(dropId),
  ik = catalogKeys.inventory(dropId, productId);
const internal = { source: schedulerSource, operation: 'openDrop', dropId };
function store() {
  const s = compositionStore();
  for (const item of [
    { ...drop, status: 'SCHEDULED', opensAt, ...dk },
    { ...relation, ...catalogKeys.dropProduct(dropId, productId) },
    { ...inventory, reserved: 0, sold: 0, ...ik },
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
function event(cancel = false): ApiEvent {
  return {
    routeKey: cancel
      ? 'POST /admin/drops/{dropId}/cancel'
      : 'PATCH /admin/drops/{dropId}',
    body: cancel ? '{}' : JSON.stringify({ name: 'Updated' }),
    headers: { 'If-Match': `"${drop.updatedAt}"` },
    pathParameters: { dropId },
    requestContext: {
      requestId: 'scheduled-test',
      http: { method: cancel ? 'POST' : 'PATCH' },
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
const audits = (s: ReturnType<typeof store>) =>
  [...s.items.values()].filter((i) => String(i.SK).startsWith('ADMIN_CHANGE#'));

test('scheduled edit atomically changes metadata, products, inventory, pickups and audit; storefront composes new values', async (t) => {
  t.mock.method(Date, 'now', () => now);
  const s = store();
  const next = await s.repository.changeScheduled(
    dropId,
    drop.updatedAt,
    'test-admin',
    {
      name: 'New menu',
      opensAt: '2026-09-25T12:00:00.000Z',
      pickupLocation: 'New location',
      products: [
        {
          productId,
          priceCents: 600,
          cookieUnits: 2,
          displayOrder: 0,
          active: true,
          inventoryTotal: 20,
        },
      ],
      pickups: [
        {
          date: '2026-10-02',
          startTime: '15:00',
          endTime: '18:00',
          timezone: 'America/Denver',
          active: true,
        },
      ],
    },
  );
  assert.equal(next.status, 'SCHEDULED');
  assert.equal(next.createdAt, drop.createdAt);
  assert.equal(next.openingRevision, next.updatedAt);
  assert.equal(s.get(ik)?.total, 20);
  const audit = audits(s)[0];
  assert.equal(audit.actor, 'test-admin');
  assert.equal((audit.before as any).inventories[0].total, 100);
  assert.equal((audit.after as any).inventories[0].total, 20);
  const response = await createHandler(() => s.repository)({
    routeKey: 'GET /drops/current',
    requestContext: { requestId: 'read', http: { method: 'GET' } },
  });
  const view = JSON.parse(response.body).drop;
  assert.equal(view.name, 'New menu');
  assert.equal(view.opensAt, next.opensAt);
  assert.equal(view.pickupLocation, 'New location');
  assert.equal(view.pickupDates[0].date, '2026-10-02');
  assert.equal(view.products[0].priceCents, 600);
  assert.equal(view.products[0].cookieUnits, 2);
  assert.equal(view.products[0].availability.available, 20);
  assert.equal(view.openingRevision, undefined);
});

test('product inclusion/removal preserves immutable allocation history and no owned inventory is reset', async (t) => {
  t.mock.method(Date, 'now', () => now);
  const s = store();
  s.put({
    ...product,
    productId: otherProductId,
    ...catalogKeys.product(otherProductId),
  });
  await s.repository.changeScheduled(dropId, drop.updatedAt, 'admin', {
    products: [
      {
        productId: otherProductId,
        priceCents: 500,
        cookieUnits: 1,
        displayOrder: 0,
        active: true,
        inventoryTotal: 40,
      },
    ],
  });
  assert.equal(s.get(ik), undefined);
  assert.equal(s.get(catalogKeys.dropProduct(dropId, productId)), undefined);
  assert.equal((audits(s)[0].before as any).inventories[0].total, 100);
  assert.equal(s.get(catalogKeys.inventory(dropId, otherProductId))?.total, 40);
});

for (const cancel of [false, true]) {
  test(`${cancel ? 'cancel' : 'edit'} rejects duplicate and stale revisions without another audit`, async (t) => {
    t.mock.method(Date, 'now', () => now);
    const s = store();
    const change = () =>
      s.repository.changeScheduled(
        dropId,
        drop.updatedAt,
        'admin',
        cancel ? null : { name: 'New' },
      );
    await change();
    const before = structuredClone(s.items);
    await assert.rejects(
      change(),
      fails(cancel ? 'DROP_NOT_EDITABLE' : 'COMPOSITION_CONFLICT'),
    );
    assert.deepEqual(s.items, before);
    assert.equal(audits(s).length, 1);
  });
  for (const ownership of [
    { reserved: 1, sold: 0 },
    { reserved: 0, sold: 1 },
    { reserved: 1, sold: 1 },
  ]) {
    test(`${cancel ? 'cancel' : 'edit/allocation reduction'} rejects reserved/sold ${JSON.stringify(ownership)}`, async (t) => {
      t.mock.method(Date, 'now', () => now);
      const s = store();
      s.put({ ...s.get(ik), ...ownership });
      const before = structuredClone(s.items);
      await assert.rejects(
        s.repository.changeScheduled(
          dropId,
          drop.updatedAt,
          'admin',
          cancel
            ? null
            : {
                products: [
                  {
                    productId,
                    priceCents: 500,
                    cookieUnits: 1,
                    displayOrder: 0,
                    active: true,
                    inventoryTotal: 0,
                  },
                ],
              },
        ),
        fails('INVENTORY_NOT_EDITABLE'),
      );
      assert.deepEqual(s.items, before);
    });
  }
  for (const status of dropStatusSchema.options.filter(
    (v) => v !== 'SCHEDULED',
  )) {
    test(`${cancel ? 'cancel' : 'edit'} rejects ${status}, including all customer-bearing lifecycle states`, async (t) => {
      t.mock.method(Date, 'now', () => now);
      const s = store();
      s.put({ ...s.get(dk), status });
      await assert.rejects(
        s.repository.changeScheduled(
          dropId,
          drop.updatedAt,
          'admin',
          cancel ? null : { name: 'New' },
        ),
        fails('DROP_NOT_EDITABLE'),
      );
      assert.equal(audits(s).length, 0);
    });
  }
  test(`${cancel ? 'cancel' : 'edit'} rejects at original opening boundary`, async (t) => {
    t.mock.method(Date, 'now', () => Date.parse(opensAt));
    const s = store();
    await assert.rejects(
      s.repository.changeScheduled(
        dropId,
        drop.updatedAt,
        'admin',
        cancel ? null : { name: 'New' },
      ),
      fails('DROP_NOT_EDITABLE'),
    );
  });
  for (const race of ['revision', 'opening', 'inventory', 'pointer', 'audit']) {
    test(`${cancel ? 'cancel' : 'edit'} atomic guard rejects ${race} race`, async (t) => {
      t.mock.method(Date, 'now', () => now);
      const s = store();
      s.hooks.beforeTransaction = () => {
        if (race === 'revision')
          s.put({ ...s.get(dk), updatedAt: new Date(now + 10).toISOString() });
        if (race === 'opening') s.put({ ...s.get(dk), status: 'OPEN' });
        if (race === 'inventory') s.put({ ...s.get(ik), reserved: 1 });
        if (race === 'pointer')
          s.put({
            ...catalogKeys.storefront,
            storefrontDropId: otherProductId,
          });
        if (race === 'audit')
          s.put({
            ...dk,
            SK: `ADMIN_CHANGE#${drop.updatedAt}`,
            actor: 'earlier',
          });
      };
      await assert.rejects(
        s.repository.changeScheduled(
          dropId,
          drop.updatedAt,
          'admin',
          cancel ? null : { name: 'New' },
        ),
        CatalogWriteError,
      );
      assert.equal(s.get(dk)?.name, drop.name);
      assert.notEqual(s.get(dk)?.status, 'CLOSED');
      if (race !== 'audit') assert.equal(audits(s).length, 0);
    });
  }
  test(`${cancel ? 'cancel' : 'edit'} authorization precedes parsing or repository access`, async () => {
    const e = event(cancel);
    delete e.requestContext.authorizer;
    e.body = 'bad';
    const handler = createHandler(() => {
      throw new Error('must not access');
    });
    assert.equal((await handler(e)).statusCode, 401);
    e.requestContext.authorizer = {
      jwt: {
        claims: {
          token_use: 'access',
          sub: 'user',
          username: 'user',
          'cognito:groups': ['customers'],
        },
      },
    };
    assert.equal((await handler(e)).statusCode, 403);
  });
}

test('cancellation preserves composition, releases pointer, and duplicate legacy/new work and reconcile cannot reopen', async (t) => {
  let time = now;
  t.mock.method(Date, 'now', () => time);
  const s = store();
  const savedInventory = structuredClone(s.get(ik));
  const canceled = await s.repository.changeScheduled(
    dropId,
    drop.updatedAt,
    'admin',
    null,
  );
  assert.equal(canceled.status, 'CLOSED');
  assert.deepEqual(s.get(ik), savedInventory);
  assert.equal(s.get(catalogKeys.storefront), undefined);
  time = Date.parse(opensAt) + 1000;
  const auto = createAutoOpenHandler(() => s.repository);
  for (const delivery of [
    internal,
    internal,
    { ...internal, openingRevision: drop.updatedAt },
  ])
    assert.equal((await auto(delivery)).result, 'terminal');
  const e = event(true);
  e.routeKey = 'POST /admin/drops/{dropId}/reconcile-opening';
  const handler = createHandler(
    () => s.repository,
    () => {
      throw new Error('must not schedule');
    },
  );
  assert.equal((await handler(e)).statusCode, 409);
  const current = await handler({
    routeKey: 'GET /drops/current',
    requestContext: { requestId: 'current', http: { method: 'GET' } },
  });
  assert.equal(JSON.parse(current.body).drop, null);
  e.routeKey = 'GET /admin/drops/{dropId}/composition';
  e.requestContext.http.method = 'GET';
  assert.equal(JSON.parse((await handler(e)).body).drop.status, 'CLOSED');
});

test('rescheduling invalidates legacy and old-generation deliveries even after the new opening time', async (t) => {
  let time = now;
  t.mock.method(Date, 'now', () => time);
  const s = store();
  const first = await s.repository.changeScheduled(
    dropId,
    drop.updatedAt,
    'admin',
    { opensAt: '2026-09-25T12:00:00.000Z' },
  );
  const second = await s.repository.changeScheduled(
    dropId,
    first.updatedAt,
    'admin',
    { opensAt: '2026-09-26T12:00:00.000Z' },
  );
  const auto = createAutoOpenHandler(() => s.repository);
  time = Date.parse(second.opensAt) + 1;
  assert.equal((await auto(internal)).result, 'terminal');
  assert.equal(
    (await auto({ ...internal, openingRevision: first.openingRevision }))
      .result,
    'terminal',
  );
  assert.equal(s.get(dk)?.status, 'SCHEDULED');
  assert.equal(
    (await auto({ ...internal, openingRevision: second.openingRevision }))
      .result,
    'opened',
  );
  assert.equal(
    (await auto({ ...internal, openingRevision: second.openingRevision }))
      .result,
    'terminal',
  );
});

test('opening transaction cannot use a snapshot superseded by edit', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse(opensAt));
  const s = store();
  s.hooks.beforeTransaction = () =>
    s.put({
      ...s.get(dk),
      updatedAt: new Date(now).toISOString(),
      openingRevision: new Date(now).toISOString(),
    });
  await assert.rejects(
    s.repository.openScheduled(dropId, {}),
    fails('COMPOSITION_CONFLICT'),
  );
  assert.equal(s.get(dk)?.status, 'SCHEDULED');
});

test('schedule identities and payloads are deterministic per generation; legacy unchanged', async (t) => {
  t.mock.method(Date, 'now', () => now);
  const created: any[] = [];
  const client = {
    send: async (command: any) => {
      if (command instanceof CreateScheduleCommand) {
        created.push(command.input);
        return {};
      }
      assert.ok(command instanceof GetScheduleCommand);
      return created.at(-1);
    },
  } as unknown as Pick<SchedulerClient, 'send'>;
  const scheduler = new SchedulerOpeningSchedules(
    client,
    'group',
    'target',
    'role',
  );
  const scheduled: Drop = { ...drop, status: 'SCHEDULED', opensAt };
  await scheduler.ensure(scheduled);
  await scheduler.ensure({ ...scheduled, openingRevision: drop.updatedAt });
  await scheduler.ensure({ ...scheduled, openingRevision: drop.updatedAt });
  assert.equal(created[0].Name, `open-${dropId}`);
  assert.notEqual(created[1].Name, created[0].Name);
  assert.deepEqual(created[1], created[2]);
  assert.ok(created[1].Name.length <= 64);
  assert.equal(
    JSON.parse(created[1].Target.Input).openingRevision,
    drop.updatedAt,
  );
});

test('committed edit with failed schedule is recoverable through existing reconciliation', async (t) => {
  t.mock.method(Date, 'now', () => now);
  const s = store();
  const e = event();
  const failed = createHandler(
    () => s.repository,
    () => ({
      ensure: async () => {
        throw new Error('private service error');
      },
    }),
  );
  const result = await failed(e);
  assert.equal(result.statusCode, 503);
  assert.equal(JSON.parse(result.body).code, 'OPENING_SCHEDULE_UNCONFIRMED');
  assert.equal(s.get(dk)?.name, 'Updated');
  assert.equal((await failed(e)).statusCode, 409);
  let scheduled: Drop | undefined;
  const recovered = createHandler(
    () => s.repository,
    () => ({
      ensure: async (d) => {
        scheduled = d;
      },
    }),
  );
  e.routeKey = 'POST /admin/drops/{dropId}/reconcile-opening';
  e.requestContext.http.method = 'POST';
  e.body = '{}';
  assert.equal((await recovered(e)).statusCode, 200);
  assert.equal(scheduled?.openingRevision, s.get(dk)?.openingRevision);
});

for (const invalid of [
  { status: 'OPEN' },
  { openingRevision: opensAt },
  { reserved: 0 },
  { products: [] },
  { name: 'x'.repeat(201) },
  {},
  { pickups: [{ ...pickup, dropId }] },
]) {
  test(`strict scheduled input rejects ${JSON.stringify(invalid).slice(0, 80)}`, async () => {
    const e = event();
    e.body = JSON.stringify(invalid);
    assert.equal(
      (
        await createHandler(() => {
          throw new Error('no access');
        })(e)
      ).statusCode,
      400,
    );
  });
}
for (const headers of [
  {},
  { 'If-Match': '*' },
  { 'If-Match': 'W/"version"' },
  { 'If-Match': `"${drop.updatedAt}"`, 'if-match': `"${drop.updatedAt}"` },
]) {
  test(`reject missing/malformed/duplicate revision ${JSON.stringify(headers)}`, async () => {
    const e = event();
    e.headers = headers;
    assert.equal(
      (
        await createHandler(() => {
          throw new Error('no access');
        })(e)
      ).statusCode,
      400,
    );
  });
}

test('null clears optional closing time without persisting undefined; invalid new schedule fails atomically', async (t) => {
  t.mock.method(Date, 'now', () => now);
  const s = store();
  s.put({ ...s.get(dk), closesAt: '2026-09-28T12:00:00.000Z' });
  const next = await s.repository.changeScheduled(
    dropId,
    drop.updatedAt,
    'admin',
    { closesAt: null },
  );
  assert.ok(!('closesAt' in next));
  await assert.rejects(
    s.repository.changeScheduled(dropId, next.updatedAt, 'admin', {
      opensAt: '2026-10-10T12:00:00.000Z',
    }),
    fails('DROP_NOT_READY'),
  );
  assert.equal(audits(s).length, 1);
  const writes = s.commands.filter((c) => c instanceof TransactWriteCommand);
  assert.equal(writes.length, 1);
});

test('cancel after edit makes current-generation delivery terminal and cannot delete another storefront owner', async (t) => {
  let time = now;
  t.mock.method(Date, 'now', () => time);
  const s = store();
  const edited = await s.repository.changeScheduled(
    dropId,
    drop.updatedAt,
    'admin',
    { name: 'Edited' },
  );
  await s.repository.changeScheduled(dropId, edited.updatedAt, 'admin', null);
  s.put({
    ...catalogKeys.storefront,
    storefrontDropId: otherProductId,
    updatedAt: edited.updatedAt,
  });
  time = Date.parse(opensAt) + 1;
  const auto = createAutoOpenHandler(() => s.repository);
  assert.equal(
    (await auto({ ...internal, openingRevision: edited.openingRevision }))
      .result,
    'terminal',
  );
  assert.equal(s.get(catalogKeys.storefront)?.storefrontDropId, otherProductId);
});

test('product revision race blocks edit atomically', async (t) => {
  t.mock.method(Date, 'now', () => now);
  const s = store();
  s.hooks.beforeTransaction = () =>
    s.put({
      ...product,
      updatedAt: opensAt,
      ...catalogKeys.product(productId),
    });
  await assert.rejects(
    s.repository.changeScheduled(dropId, drop.updatedAt, 'admin', {
      name: 'Edited',
    }),
    fails('COMPOSITION_CONFLICT'),
  );
  assert.equal(s.get(dk)?.name, drop.name);
  assert.equal(audits(s).length, 0);
});

test('bounded action count and audit size reject before any transaction', async (t) => {
  t.mock.method(Date, 'now', () => now);
  for (const kind of ['actions', 'audit']) {
    const s = store();
    if (kind === 'actions')
      for (let i = 0; i < 100; i++) {
        const id = '01K5J10000000000000000' + String(i).padStart(4, '0');
        s.put({
          ...inventory,
          productId: id,
          reserved: 0,
          sold: 0,
          ...catalogKeys.inventory(dropId, id),
        });
      }
    else s.put({ ...s.get(dk), description: 'x'.repeat(155_000) });
    await assert.rejects(
      s.repository.changeScheduled(dropId, drop.updatedAt, 'admin', null),
      fails('DROP_NOT_READY'),
    );
    assert.ok(!s.commands.some((c) => c instanceof TransactWriteCommand));
  }
});

test('cross-field schedule validation gives a controlled conflict, not a service error', async (t) => {
  t.mock.method(Date, 'now', () => now);
  const s = store();
  const e = event();
  e.body = JSON.stringify({ closesAt: '2026-09-23T13:00:00.000Z' });
  const result = await createHandler(() => s.repository)(e);
  assert.equal(result.statusCode, 409);
  assert.equal(JSON.parse(result.body).code, 'DROP_NOT_READY');
  assert.equal(audits(s).length, 0);
});

test('edit can move opening earlier; new generation remains authoritative and manual opening still works', async (t) => {
  let time = now;
  t.mock.method(Date, 'now', () => time);
  const s = store();
  const next = await s.repository.changeScheduled(
    dropId,
    drop.updatedAt,
    'admin',
    { opensAt: '2026-09-23T13:00:00.000Z' },
  );
  const auto = createAutoOpenHandler(() => s.repository);
  await assert.rejects(
    auto({ ...internal, openingRevision: next.openingRevision }),
    /OPENING_TOO_EARLY/,
  );
  time = Date.parse(next.opensAt);
  assert.equal((await s.repository.openScheduled(dropId)).status, 'OPEN');
  assert.equal(
    (await auto({ ...internal, openingRevision: next.openingRevision })).result,
    'terminal',
  );
});
