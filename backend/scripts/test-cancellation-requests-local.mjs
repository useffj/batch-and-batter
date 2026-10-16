import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fixtures } from './orders-local-fixtures.mjs';
const require = createRequire(import.meta.url);
const {
  PutCommand,
  GetCommand,
  ScanCommand,
} = require('@aws-sdk/lib-dynamodb');
const { GuestOrders } = require('../dist/src/guest-orders');
const {
  CancellationRequests,
  cancellationDeadline,
  cancellationKey,
} = require('../dist/src/cancellation-requests');
const { Notifications } = require('../dist/src/notifications');
const {
  MockNotificationTransport,
} = require('../dist/src/notification-transport');
const {
  MockEmailProvider,
  MockSmsProvider,
} = require('../dist/src/notification-providers');
const { refundKey, digest } = require('../dist/src/notification-contract');
const { orderKey } = require('../dist/src/payment-domain');
const { AdminNotifications } = require('../dist/src/admin-notifications');
const f = await fixtures();
let now = Date.parse('2026-10-20T18:00:00Z');
const guest = new GuestOrders(
  f.client,
  f.table,
  f.table,
  f.table,
  'https://synthetic.example.test',
  () => now,
);
const requests = new CancellationRequests(
  f.client,
  f.table,
  f.table,
  () => now,
);
const mail = new MockEmailProvider(),
  sms = new MockSmsProvider(),
  transport = new MockNotificationTransport();
const notification = new Notifications(
  f.client,
  f.table,
  f.table,
  transport,
  { email: mail, sms },
  {
    policies: 'Synthetic only',
    now: () => now,
    issueManagementLink: (o) => guest.issue(o),
  },
);
const put = (Item) =>
  f.client.send(new PutCommand({ TableName: f.table, Item }));
const read = async (Key) =>
  (
    await f.client.send(
      new GetCommand({ TableName: f.table, Key, ConsistentRead: true }),
    )
  ).Item;
const input = (type = 'GUARANTEED') => ({
  requestId: randomUUID(),
  type,
  reason: type === 'EXCEPTION' ? 'Synthetic travel conflict' : '',
});
try {
  const orders = f.orders.filter((o) => o.status === 'PAID'),
    tokens = [];
  for (const o of orders) {
    o.settlement = {
      id: digest(o.orderId),
      lineDigest: digest('synthetic'),
      outcome: 'PAID',
      amountCents: o.totalCents,
    };
    await put({ ...orderKey(o.orderId), ...o });
    await put({
      ...refundKey(o.orderId),
      disposition: 'NONE',
      settlementId: o.settlement.id,
      updatedAt: new Date(now).toISOString(),
    });
    await put({
      PK: 'ORDER_EVENT#' + o.orderId + '#PAID',
      SK: 'META',
      schemaVersion: 1,
      eventType: 'PAID',
      orderId: o.orderId,
      cartId: o.cartId,
      paymentAttemptId: o.paymentAttemptId,
      dropId: o.dropId,
      settlementId: o.settlement.id,
      createdAt: new Date(now).toISOString(),
    });
    await notification.confirmation(o.orderId);
    await notification.deliver(o.orderId, 'CONFIRMATION#email');
    tokens.push(
      mail.messages.at(-1).text.split('/order/manage#')[1].split(/\s/)[0],
    );
  }
  const before = await Promise.all(
    orders.map((o) => read(orderKey(o.orderId))),
  );
  const a = input();
  assert((await guest.view(tokens[0])).cancellation.eligible);
  await guest.requestCancellation(tokens[0], a);
  await guest.requestCancellation(tokens[0], a);
  await assert.rejects(guest.requestCancellation(tokens[0], input()));
  const status = (await guest.view(tokens[0])).cancellation;
  assert.equal(status.request.status, 'RECEIVED_PENDING_PROCESSING');
  assert.equal(status.request.eligibility.amountCents, 945);
  assert(!JSON.stringify(status).includes('settlementId'));
  const changedPolicy = new CancellationRequests(
    f.client,
    f.table,
    f.table,
    () => now,
    48,
  );
  assert.equal(
    (await changedPolicy.view(orders[0].orderId)).deadline,
    status.deadline,
  );
  assert.equal((await changedPolicy.view(orders[0].orderId)).hours, 24);
  console.log(
    'PASS secure timely request, durable status and idempotent duplicate protection',
  );
  const deadline = cancellationDeadline('2026-10-22', '16:00');
  now = Date.parse(deadline);
  assert.equal((await guest.view(tokens[1])).cancellation.eligible, false);
  await assert.rejects(guest.requestCancellation(tokens[1], input()));
  await guest.requestCancellation(tokens[1], input('EXCEPTION'));
  assert.equal(
    (await guest.view(tokens[1])).cancellation.request.type,
    'EXCEPTION',
  );
  console.log(
    'PASS exact deadline rejects guaranteed request and permits reasoned discretionary assistance',
  );
  now = Date.parse(deadline) - 1;
  const race = await Promise.allSettled([
    guest.requestCancellation(tokens[2], input()),
    guest.requestCancellation(tokens[2], input()),
  ]);
  assert.equal(race.filter((x) => x.status === 'fulfilled').length, 1);
  console.log('PASS concurrent requests produce only one durable outcome');
  let lost = false;
  const faultGuest = new GuestOrders(
    {
      send: async (c) => {
        const r = await f.client.send(c);
        if (c.constructor.name === 'TransactWriteCommand' && !lost) {
          lost = true;
          throw Error('Synthetic lost acknowledgement');
        }
        return r;
      },
    },
    f.table,
    f.table,
    f.table,
    'https://synthetic.example.test',
    () => now,
  );
  const retry = input();
  assert.deepEqual(await faultGuest.requestCancellation(tokens[3], retry), {
    received: true,
  });
  assert(lost);
  await guest.requestCancellation(tokens[3], retry);
  console.log(
    'PASS lost transaction acknowledgement recovers original receipt',
  );
  const o = orders[4];
  for (const disposition of ['UNKNOWN', 'PENDING', 'PARTIAL', 'FULL']) {
    await put({
      ...refundKey(o.orderId),
      disposition,
      settlementId: o.settlement.id,
      updatedAt: new Date(now).toISOString(),
    });
    assert.equal((await guest.view(tokens[4])).cancellation.eligible, false);
    await assert.rejects(guest.requestCancellation(tokens[4], input()));
  }
  await put({
    ...refundKey(o.orderId),
    disposition: 'NONE',
    settlementId: o.settlement.id,
    updatedAt: new Date(now).toISOString(),
  });
  await put({ ...before[4], status: 'CANCELLED', paymentStatus: 'CANCELLED' });
  await assert.rejects(guest.requestCancellation(tokens[4], input()));
  await put(before[4]);
  await put({
    PK: 'ORDER#' + o.orderId,
    SK: 'FULFILLMENT',
    orderId: o.orderId,
    revision: 1,
    status: 'PICKED_UP',
    history: [
      {
        requestId: randomUUID(),
        status: 'PICKED_UP',
        at: new Date(now).toISOString(),
        administrator: 'synthetic',
        reason: '',
      },
    ],
  });
  await assert.rejects(guest.requestCancellation(tokens[4], input()));
  console.log(
    'PASS cancelled, refunded, unknown refund and collected Orders fail closed',
  );
  const grants = await guest.adminStatus(orders[5].orderId);
  await guest.admin(
    orders[5].orderId,
    'revoke',
    {
      requestId: randomUUID(),
      reason: 'Synthetic revocation',
      tokenId: grants.tokens[0].id,
    },
    'synthetic-admin',
  );
  await assert.rejects(guest.requestCancellation(tokens[5], input()));
  const clock = now;
  now = Date.parse('2027-01-01T00:00:00Z');
  await assert.rejects(guest.requestCancellation(tokens[6], input()));
  now = clock;
  console.log('PASS revoked and expired tokens rejected');
  now = Date.parse('2026-10-20T18:00:00Z');
  const moved = orders[6];
  await put({
    PK: 'DROP#' + moved.dropId,
    SK: 'PICKUP#2026-10-24',
    dropId: moved.dropId,
    date: '2026-10-24',
    startTime: '12:00',
    endTime: '15:00',
    timezone: 'America/Denver',
    active: true,
  });
  await guest.change({
    token: tokens[6],
    requestId: randomUUID(),
    revision: 0,
    date: '2026-10-24',
  });
  assert.equal(
    (await guest.view(tokens[6])).cancellation.deadline,
    cancellationDeadline('2026-10-24', '12:00'),
  );
  await assert.rejects(
    guest.change({
      token: tokens[0],
      requestId: randomUUID(),
      revision: 0,
      date: '2026-10-24',
    }),
  );
  console.log(
    'PASS changed pickup controls deadline; recorded request blocks conflicting pickup changes',
  );
  const admin = await guest.adminRequest(orders[0].orderId);
  assert.equal(admin.history.length, 1);
  assert.equal(admin.refundDisposition, 'NONE');
  await assert.rejects(
    guest.reviewRequest(
      orders[0].orderId,
      {
        requestId: randomUUID(),
        revision: 1,
        decision: 'DECLINE_EXCEPTION',
        note: 'Invalid rejection',
      },
      'admin',
    ),
  );
  const review = {
    requestId: randomUUID(),
    revision: 1,
    decision: 'NOTE',
    note: 'Entitlement preserved for financial processing',
  };
  await guest.reviewRequest(orders[0].orderId, review, 'synthetic-admin');
  await guest.reviewRequest(orders[0].orderId, review, 'synthetic-admin');
  const updated = await guest.adminRequest(orders[0].orderId);
  assert.equal(updated.history.length, 2);
  assert(updated.history.some((x) => x.administrator === 'synthetic-admin'));
  assert.equal(updated.request.status, 'RECEIVED_PENDING_PROCESSING');
  const decisions = await Promise.allSettled(
    ['APPROVE_EXCEPTION', 'DECLINE_EXCEPTION'].map((decision) =>
      guest.reviewRequest(
        orders[1].orderId,
        {
          requestId: randomUUID(),
          revision: 1,
          decision,
          note: 'Synthetic discretionary decision',
        },
        'admin',
      ),
    ),
  );
  assert.equal(decisions.filter((x) => x.status === 'fulfilled').length, 1);
  const list = await f.repository.list({
    reference: orders[0].displayOrderNumber,
  });
  assert.equal(list.orders[0].cancellationRequest.type, 'GUARANTEED');
  console.log(
    'PASS bounded administrator listing, immutable review audit, entitlement protection and concurrent decision control',
  );
  now = Date.parse('2026-10-21T17:00:00Z');
  await notification.reminders('2026-10-22');
  await notification.deliver(orders[0].orderId, 'REMINDER#2026-10-22#email');
  await notification.deliver(orders[1].orderId, 'REMINDER#2026-10-22#email');
  const ns = new AdminNotifications(f.client, f.table);
  assert.equal(
    (await ns.status(orders[0].orderId)).notifications.find(
      (x) => x.key === 'REMINDER#2026-10-22#email',
    ).reason,
    'CANCELLATION_REQUEST_PENDING',
  );
  assert.equal(
    (await ns.status(orders[1].orderId)).notifications.find(
      (x) => x.key === 'REMINDER#2026-10-22#email',
    ).status,
    'SENT',
  );
  await notification.deliver(
    orders[0].orderId,
    'REQUEST#' + a.requestId + '#email',
  );
  const count = mail.messages.length;
  await notification.deliver(
    orders[0].orderId,
    'REQUEST#' + a.requestId + '#email',
  );
  assert.equal(mail.messages.length, count);
  assert(
    mail.messages
      .at(-1)
      .text.includes('does not confirm cancellation or a refund'),
  );
  console.log(
    'PASS request notification idempotency; timely reminder suppression; exception reminders preserved',
  );
  // Interleave a financial-state change after eligibility reads, before intake commits.
  now = Date.parse('2026-10-20T18:00:00Z');
  let injected = false;
  const racingGuest = new GuestOrders(
    {
      send: async (command) => {
        if (command.constructor.name === 'TransactWriteCommand' && !injected) {
          injected = true;
          await put({
            ...refundKey(orders[8].orderId),
            disposition: 'PENDING',
            settlementId: orders[8].settlement.id,
            updatedAt: new Date(now + 1).toISOString(),
          });
        }
        return f.client.send(command);
      },
    },
    f.table,
    f.table,
    f.table,
    'https://synthetic.example.test',
    () => now,
  );
  await assert.rejects(racingGuest.requestCancellation(tokens[8], input()));
  assert(injected);
  assert.equal(await requests.state(orders[8].orderId), null);
  now = Date.parse(deadline) + 1;
  await guest.requestCancellation(tokens[9], input('EXCEPTION'));
  await put({
    ...refundKey(orders[9].orderId),
    disposition: 'FULL',
    settlementId: orders[9].settlement.id,
    updatedAt: new Date(now).toISOString(),
  });
  await assert.rejects(
    guest.reviewRequest(
      orders[9].orderId,
      {
        requestId: randomUUID(),
        revision: 1,
        decision: 'APPROVE_EXCEPTION',
        note: 'Must reject incompatible evidence',
      },
      'admin',
    ),
  );
  assert.equal(
    (await requests.state(orders[9].orderId)).status,
    'EXCEPTION_REQUESTED',
  );
  console.log(
    'PASS intervening refund state blocks intake and incompatible evidence blocks exception approval',
  );
  for (let i = 0; i < orders.length; i++)
    if (i !== 6)
      assert.deepEqual(await read(orderKey(orders[i].orderId)), before[i]);
  const scan = await f.client.send(new ScanCommand({ TableName: f.table }));
  const raw = JSON.stringify(scan.Items);
  for (const token of tokens) assert(!raw.includes(token));
  assert.equal(sms.messages.length, 0);
  assert(!scan.Items.some((x) => String(x.PK).includes('STRIPE_REFUND')));
  console.log(
    'PASS unchanged Orders/financial snapshots, no token persistence and mock-only notification delivery',
  );
} finally {
  await f.close();
}
