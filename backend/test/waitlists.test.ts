import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, type ApiEvent } from '../src/api';
import { ADMIN_GROUP } from '../src/admin-auth';
import { Waitlists, waitlistSignup } from '../src/waitlists';
import { createNotificationWorker } from '../src/notification-worker';
import { MockEmailProvider } from '../src/notification-providers';
import { fakeRepository, dropId, productId } from './fixtures';
const scope = { dropId, productId };
function event(routeKey: string, authorized = false): ApiEvent {
  return {
    routeKey,
    body: JSON.stringify({
      ...scope,
      email: 'synthetic@example.invalid',
      consent: true,
    }),
    requestContext: {
      requestId: 'synthetic',
      http: { method: routeKey.split(' ')[0], sourceIp: '127.0.0.1' },
      ...(authorized
        ? {
            authorizer: {
              jwt: {
                claims: {
                  token_use: 'access',
                  sub: 'synthetic-admin',
                  username: 'synthetic-admin',
                  'cognito:groups': [ADMIN_GROUP],
                },
              },
            },
          }
        : {}),
    },
  };
}
test('waitlist inputs require exact scope, email and separate explicit consent', () => {
  for (const value of [
    { ...scope, email: 'bad', consent: true },
    { ...scope, email: 'synthetic@example.invalid', consent: false },
    { ...scope, email: 'synthetic@example.invalid', smsConsent: true },
    {
      ...scope,
      email: 'synthetic@example.invalid',
      consent: true,
      orderId: dropId,
    },
  ])
    assert.equal(waitlistSignup.safeParse(value).success, false);
  assert.equal(
    waitlistSignup.parse({
      ...scope,
      email: 'SYNTHETIC@example.invalid',
      consent: true,
    }).email,
    'synthetic@example.invalid',
  );
});
test('admin waitlist routes reject unauthorized access before service construction', async () => {
  let calls = 0;
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
    undefined,
    undefined,
    () => {
      calls++;
      throw Error();
    },
  );
  for (const route of [
    'GET /admin/waitlists',
    'POST /admin/waitlists/review',
    'POST /admin/waitlists/campaign',
  ])
    assert.equal((await h(event(route))).statusCode, 401);
  assert.equal(calls, 0);
});
test('waitlist production factory is fail closed without runtime activation', async () => {
  const h = createHandler(() => fakeRepository());
  for (const route of [
    'POST /waitlists',
    'POST /waitlists/unsubscribe',
    'GET /admin/waitlists',
  ]) {
    const r = await h(event(route, true));
    assert.equal(r.statusCode, 503);
    assert.match(
      r.headers['Cache-Control'] ?? r.headers['cache-control'],
      /no-store/,
    );
    assert(!r.body.includes('synthetic@example.invalid'));
  }
});
test('request limits, malformed JSON, public rate limit and admin identity boundary', async () => {
  let joins = 0,
    rate = 0,
    actor = '';
  const service = {
    rateLimit: async () => {
      rate++;
    },
    join: async () => {
      joins++;
      return { message: 'Received' };
    },
    campaign: async (_s: unknown, _e: string, a: string) => {
      actor = a;
      return { done: true };
    },
  } as unknown as Waitlists;
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
    undefined,
    undefined,
    () => service,
  );
  assert.equal((await h(event('POST /waitlists'))).statusCode, 200);
  assert.equal(joins, 1);
  assert.equal(rate, 1);
  for (const body of ['{', 'x'.repeat(2049)])
    assert.equal(
      (await h({ ...event('POST /waitlists'), body })).statusCode,
      400,
    );
  assert.equal(joins, 1);
  assert.equal(
    (
      await h({
        ...event('POST /admin/waitlists/campaign', true),
        body: JSON.stringify({ ...scope, event: 'a'.repeat(64) }),
      })
    ).statusCode,
    200,
  );
  assert.equal(actor, 'synthetic-admin');
});
test('key/origin validation and signed opt-out fail before database operations', async () => {
  const db = {
    send: async () => {
      throw Error('NO_DB');
    },
  } as any;
  const queue = {
    enqueue: async () => {
      throw Error('NO_QUEUE');
    },
  };
  assert.throws(
    () =>
      new Waitlists(
        db,
        'c',
        'x',
        'o',
        Buffer.alloc(31),
        'https://synthetic.example',
        queue,
        new MockEmailProvider(),
      ),
  );
  assert.throws(
    () =>
      new Waitlists(
        db,
        'c',
        'x',
        'o',
        Buffer.alloc(32),
        'http://synthetic.example',
        queue,
        new MockEmailProvider(),
      ),
  );
  const s = new Waitlists(
    db,
    'c',
    'x',
    'o',
    Buffer.alloc(32),
    'https://synthetic.example',
    queue,
    new MockEmailProvider(),
  );
  await assert.rejects(() => s.unsubscribe('forged'));
  await assert.rejects(() => s.list(scope, 'forged'));
});
test('source-only worker routes waitlist references and fails closed without service', async () => {
  let deliveries = 0;
  const message = {
    type: 'WAITLIST',
    ...scope,
    event: 'a'.repeat(64),
    entryKey: 'synthetic-key',
  };
  const records = {
    Records: [{ messageId: 'one', body: JSON.stringify(message) }],
  };
  const existing = {
    handle: async () => {
      throw Error('Wrong handler');
    },
  } as any;
  assert.equal(
    (await createNotificationWorker(existing)(records)).batchItemFailures
      .length,
    1,
  );
  assert.deepEqual(
    await createNotificationWorker(existing, {
      deliver: async () => {
        deliveries++;
      },
    })(records),
    { batchItemFailures: [] },
  );
  assert.equal(deliveries, 1);
});
