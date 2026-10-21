import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createConfirmationRuntime,
  handler,
  type ConfirmationConfig,
} from '../src/confirmation-runtime';
import { GuestOrders } from '../src/guest-orders';
import { orderSchema, orderKey } from '../src/payment-domain';
import { eventWork, operationKey, digest } from '../src/notification-contract';
import { orderIndexKeys } from '../src/order-reference';
const id = (n: number) => '01K' + String(n).padStart(23, '0');
const config: ConfirmationConfig = {
  mode: 'confirmation-email',
  commerce: 'commerce',
  operations: 'operations',
  catalog: 'catalog',
  sender: 'bakery@example.test',
  origin: 'https://shop.example.test',
  pickupLocation: 'Approved synthetic pickup',
  policies: 'Contact the bakery for assistance.',
};
// In-memory conditional-write model only. No SDK client or network connection.
class Store {
  rows = new Map<string, any>();
  key(t: string, k: any) {
    return t + '|' + k.PK + '|' + k.SK;
  }
  put(t: string, item: any) {
    this.rows.set(this.key(t, item), structuredClone(item));
  }
  get(t: string, k: any) {
    return this.rows.get(this.key(t, k));
  }
  check(op: any, row: any) {
    if (!op.ConditionExpression) return true;
    return op.ConditionExpression.split(' AND ').every((term: string) => {
      if (term === 'attribute_not_exists(PK)') return !row;
      const m = /^([#\w]+)\s*=\s*(:\w+)$/.exec(term);
      assert.ok(m, term);
      return (
        row?.[op.ExpressionAttributeNames?.[m[1]] ?? m[1]] ===
        op.ExpressionAttributeValues[m[2]]
      );
    });
  }
  send = async (c: any): Promise<any> => {
    const q = c.input,
      type = c.constructor.name;
    if (type === 'GetCommand')
      return { Item: structuredClone(this.get(q.TableName, q.Key)) };
    if (type === 'QueryCommand') {
      const items = [...this.rows.entries()]
        .filter(
          ([k, r]) =>
            k.startsWith(q.TableName + '|') &&
            r.PK === q.ExpressionAttributeValues[':pk'] &&
            (!q.ExclusiveStartKey || r.SK > q.ExclusiveStartKey.SK),
        )
        .map(([, r]) => r)
        .sort((a, b) => a.SK.localeCompare(b.SK));
      const page = items.slice(0, q.Limit);
      return {
        Items: structuredClone(page),
        ...(items.length > page.length
          ? { LastEvaluatedKey: { PK: page.at(-1).PK, SK: page.at(-1).SK } }
          : {}),
      };
    }
    if (type === 'DeleteCommand') {
      this.rows.delete(this.key(q.TableName, q.Key));
      return {};
    }
    const actions = type === 'PutCommand' ? [{ Put: q }] : q.TransactItems;
    assert.ok(actions);
    if (
      !actions.every((a: any) => {
        const o = a.Put ?? a.ConditionCheck;
        return this.check(o, this.get(o.TableName, o.Item ?? o.Key));
      })
    )
      throw Object.assign(Error('conditional rejection'), {
        name:
          type === 'PutCommand'
            ? 'ConditionalCheckFailedException'
            : 'TransactionCanceledException',
      });
    for (const a of actions) if (a.Put) this.put(a.Put.TableName, a.Put.Item);
    return {};
  };
}
function fixture() {
  const store = new Store();
  let now = Date.parse('2026-10-21T18:00:00Z');
  const base = {
    orderId: id(1),
    cartId: id(2),
    paymentAttemptId: id(3),
    dropId: id(4),
    displayOrderNumber: 'BB-23456789ABCD',
    status: 'PAID',
    paymentStatus: 'CAPTURED',
    items: [
      {
        productId: id(5),
        name: 'Synthetic cookie',
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
      name: 'Synthetic',
      email: 'customer@example.test',
      phone: '+15555550123',
      smsTransactionalConsent: false,
    },
    pickup: {
      dropId: id(4),
      date: '2026-10-22',
      startTime: '12:00',
      endTime: '14:00',
      timezone: 'America/Denver',
      active: true,
      location: config.pickupLocation,
      instructions: 'Synthetic pickup instructions',
    },
    createdAt: '2026-10-21T17:00:00.000Z',
    updatedAt: '2026-10-21T17:00:00.000Z',
    settlement: {
      id: digest('settlement'),
      lineDigest: digest('lines'),
      outcome: 'PAID',
      amountCents: 945,
    },
  };
  const order = orderSchema.parse({ ...base, ...orderIndexKeys(base) });
  store.put('commerce', { ...orderKey(order.orderId), ...order });
  store.put('operations', {
    PK: `ORDER_EVENT#${order.orderId}#PAID`,
    SK: 'META',
    schemaVersion: 1,
    eventType: 'PAID',
    orderId: order.orderId,
    cartId: order.cartId,
    paymentAttemptId: order.paymentAttemptId,
    dropId: order.dropId,
    settlementId: order.settlement!.id,
    createdAt: order.updatedAt,
  });
  store.put('operations', eventWork(order.orderId));
  const messages: any[] = [];
  let error: Error | undefined;
  const ses = {
    send: async (c: any) => {
      messages.push(c.input);
      if (error) throw error;
      return { MessageId: 'synthetic-accepted' };
    },
  } as any;
  const runtime = createConfirmationRuntime(
    config,
    store as any,
    ses,
    () => now,
  );
  const guest = new GuestOrders(
    store as any,
    'commerce',
    'operations',
    'catalog',
    config.origin,
    () => now,
  );
  return {
    store,
    order,
    messages,
    runtime,
    guest,
    now: (n: number) => {
      now = n;
    },
    fail: (e: Error) => {
      error = e;
    },
    operation: () =>
      store.get(
        'operations',
        operationKey(order.orderId, 'CONFIRMATION#email'),
      ),
  };
}
test('paid event produces frozen confirmation and secure associated-order access once', async () => {
  const f = fixture(),
    before = structuredClone(
      f.store.get('commerce', orderKey(f.order.orderId)),
    );
  await f.runtime({ poll: true });
  await f.runtime({ poll: true });
  f.store.put('operations', eventWork(f.order.orderId));
  await f.runtime({ poll: true });
  assert.equal(f.messages.length, 1);
  const text = f.messages[0].Content.Simple.Body.Text.Data;
  assert.match(text, /BB-23456789ABCD/);
  assert.match(text, /Total: 9.45 USD/);
  assert.match(text, /2026-10-22, 12:00–14:00 America\/Denver/);
  assert.ok(text.includes(config.pickupLocation));
  assert.match(text, /Synthetic pickup instructions/);
  assert.ok(!text.includes('/admin'));
  assert.ok(!text.includes(f.order.customer.phone));
  const token = text.split('/order/manage#')[1];
  const view = await f.guest.view(token);
  assert.equal(view.order.reference, f.order.displayOrderNumber);
  assert.equal(view.order.totalCents, 945);
  await assert.rejects(f.guest.view(f.order.orderId));
  await assert.rejects(f.guest.view('x'.repeat(43)));
  assert.equal(f.operation().status, 'SENT'); // provider acceptance, not delivery
  assert.deepEqual(f.store.get('commerce', orderKey(f.order.orderId)), before);
  f.now(Date.parse('2026-12-01T00:00:00Z'));
  await assert.rejects(f.guest.view(token));
});
for (const mode of [
  'unpaid',
  'failed',
  'abandoned',
  'missing-event',
  'mismatched-event',
])
  test('no paid confirmation for ' + mode, async () => {
    const f = fixture();
    const row = f.store.get('commerce', orderKey(f.order.orderId));
    if (mode === 'missing-event')
      f.store.rows.delete(
        f.store.key('operations', {
          PK: `ORDER_EVENT#${f.order.orderId}#PAID`,
          SK: 'META',
        }),
      );
    else if (mode === 'mismatched-event')
      f.store.get('operations', {
        PK: `ORDER_EVENT#${f.order.orderId}#PAID`,
        SK: 'META',
      }).settlementId = digest('other');
    else {
      row.status =
        mode === 'unpaid'
          ? 'PAYMENT_PENDING'
          : mode === 'failed'
            ? 'FAILED'
            : 'EXPIRED';
      row.paymentStatus =
        mode === 'unpaid'
          ? 'CREATED'
          : mode === 'failed'
            ? 'FAILED'
            : 'EXPIRED';
    }
    await f.runtime({ poll: true });
    assert.equal(f.messages.length, 0);
  });
test('missing runtime configuration and unsupported events fail before any side effect', async () => {
  const f = fixture();
  for (const key of Object.keys(config))
    assert.throws(
      () =>
        createConfirmationRuntime(
          { ...config, [key]: '' } as any,
          f.store as any,
          {} as any,
        ),
      /CONFIGURATION/,
    );
  await assert.rejects(handler({ poll: true }), /CONFIGURATION/);
  await assert.rejects(
    f.runtime({ poll: true, orderId: id(1) }),
    /EVENT_INVALID/,
  );
  assert.equal(f.messages.length, 0);
});
test('unapproved frozen pickup details suppress rather than invent an address', async () => {
  const f = fixture();
  f.store.get('commerce', orderKey(f.order.orderId)).pickup.location =
    'Different pickup';
  await f.runtime({ poll: true });
  assert.equal(f.messages.length, 0);
  assert.equal(f.operation().reason, 'CONFIRMATION_DETAILS_UNAPPROVED');
});
for (const name of [
  'MessageRejected',
  'TooManyRequestsException',
  'TimeoutError',
])
  test(
    'provider ' +
      name +
      ' is observable without resending or changing financial records',
    async () => {
      const f = fixture(),
        before = structuredClone(
          f.store.get('commerce', orderKey(f.order.orderId)),
        );
      f.fail(Object.assign(Error('sensitive provider detail'), { name }));
      await f.runtime({ poll: true });
      await f.runtime({ poll: true });
      assert.equal(f.messages.length, 1);
      assert.equal(
        f.operation().status,
        name === 'TimeoutError' ? 'UNCERTAIN' : 'FAILED',
      );
      assert.ok(!JSON.stringify(f.operation()).includes('sensitive'));
      assert.deepEqual(
        f.store.get('commerce', orderKey(f.order.orderId)),
        before,
      );
    },
  );
test('overlapping polls claim a single confirmation', async () => {
  const f = fixture();
  await Promise.all([f.runtime({ poll: true }), f.runtime({ poll: true })]);
  assert.equal(f.messages.length, 1);
});
test('explicit access reissue recovers a rejected confirmation without retrying its consumed link', async () => {
  const f = fixture();
  f.fail(Object.assign(Error('rejected'), { name: 'MessageRejected' }));
  await f.runtime({ poll: true });
  // Model a separately authorized admin reissue using the established operation contract.
  const key = 'ACCESS#00000000-0000-4000-8000-000000000001#email';
  const o = {
    ...f.operation(),
    kind: 'ACCESS',
    key,
    status: 'PENDING',
    attempts: 0,
    revision: 0,
  };
  delete o.reason;
  f.store.put('operations', { ...o, ...operationKey(f.order.orderId, key) });
  const { dueKey } = await import('../src/notification-contract');
  f.store.put('operations', { ...dueKey(o), orderId: o.orderId, key });
  const accepted: any[] = [];
  const runtime = createConfirmationRuntime(
    config,
    f.store as any,
    {
      send: async (c: any) => {
        accepted.push(c.input);
        return { MessageId: 'accepted' };
      },
    } as any,
    () => Date.parse('2026-10-21T18:00:00Z'),
  );
  await runtime({ poll: true });
  await runtime({ poll: true });
  assert.equal(accepted.length, 1);
  assert.equal(f.operation().status, 'FAILED');
  const text = accepted[0].Content.Simple.Body.Text.Data;
  assert.equal(
    (await f.guest.view(text.split('/order/manage#')[1])).order.reference,
    f.order.displayOrderNumber,
  );
});
test('confirmation consumer passes unrelated due work without sending it or starving later confirmations', async () => {
  const f = fixture();
  const { shard } = await import('../src/notification-contract');
  for (let n = 0; n < 21; n++)
    f.store.put('operations', {
      PK: 'NOTIFICATION_DUE#' + shard(f.order.orderId),
      SK: '000' + String(n).padStart(3, '0'),
      orderId: id(90),
      key: 'REMINDER#2026-10-22#sms',
    });
  await f.runtime({ poll: true });
  assert.equal(f.messages.length, 1);
  assert.equal(
    [...f.store.rows.values()].filter(
      (r) => r.key === 'REMINDER#2026-10-22#sms',
    ).length,
    21,
  );
});
test('accepted email with failed status persistence is not sent again', async () => {
  const f = fixture();
  const db = {
    send: async (c: any) => {
      if (c.constructor.name === 'PutCommand' && c.input.Item.status === 'SENT')
        throw Error('lost acknowledgement');
      return f.store.send(c);
    },
  } as any;
  const messages: any[] = [];
  const runtime = createConfirmationRuntime(
    config,
    db,
    {
      send: async (c: any) => {
        messages.push(c.input);
        return { MessageId: 'accepted' };
      },
    } as any,
    () => Date.parse('2026-10-21T18:00:00Z'),
  );
  await assert.rejects(runtime({ poll: true }), /CONFIRMATION_POLL_FAILED/);
  await runtime({ poll: true });
  assert.equal(messages.length, 1);
  assert.equal(f.operation().status, 'DISPATCHED');
  f.now(Date.parse('2026-10-21T18:06:00Z'));
  await f.runtime({ poll: true });
  assert.equal(f.messages.length, 0);
  assert.equal(f.operation().status, 'UNCERTAIN');
});
test('a guest capability cannot be redirected to a different order or reused after revocation', async () => {
  const f = fixture();
  await f.runtime({ poll: true });
  const token =
    f.messages[0].Content.Simple.Body.Text.Data.split('/order/manage#')[1];
  const lookup = [...f.store.rows.values()].find(
    (r) =>
      r.PK.includes(digest('guest-order:v1:' + token)) &&
      r.orderId === f.order.orderId,
  )!;
  assert.ok(lookup);
  lookup.orderId = id(99);
  await assert.rejects(f.guest.view(token));
  lookup.orderId = f.order.orderId;
  const state = [...f.store.rows.values()].find((r) =>
    Array.isArray(r.tokens),
  )!;
  state.tokens = [];
  await assert.rejects(f.guest.view(token));
});
