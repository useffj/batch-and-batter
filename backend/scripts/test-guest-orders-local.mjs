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
const { GuestOrders, accessExpiration } = require('../dist/src/guest-orders');
const { Notifications } = require('../dist/src/notifications');
const { AdminNotifications } = require('../dist/src/admin-notifications');
const {
  MockNotificationTransport,
} = require('../dist/src/notification-transport');
const {
  MockEmailProvider,
  MockSmsProvider,
  DeliveryFailure,
} = require('../dist/src/notification-providers');
const { orderKey } = require('../dist/src/payment-domain');
const {
  refundKey,
  digest,
  operationKey,
} = require('../dist/src/notification-contract');
const f = await fixtures();
let now = Date.parse('2026-10-20T18:00:00Z');
const guest = new GuestOrders(
    f.client,
    f.table,
    f.table,
    f.table,
    'https://synthetic.example.test',
    () => now,
  ),
  mail = new MockEmailProvider(),
  sms = new MockSmsProvider(),
  transport = new MockNotificationTransport();
let provider = mail;
const notification = new Notifications(
    f.client,
    f.table,
    f.table,
    transport,
    { email: { send: (m) => provider.send(m) }, sms },
    {
      policies: 'Synthetic policy',
      now: () => now,
      issueManagementLink: (o) => guest.issue(o),
    },
  ),
  status = new AdminNotifications(f.client, f.table);
const put = (Item) =>
  f.client.send(new PutCommand({ TableName: f.table, Item }));
const record = async (Key) =>
  (
    await f.client.send(
      new GetCommand({ TableName: f.table, Key, ConsistentRead: true }),
    )
  ).Item;
const tokenFrom = (m) => m.text.split('/order/manage#')[1].split(/\s/)[0];
const operation = async (o, key) =>
  (await status.status(o.orderId)).notifications.find((n) => n.key === key);
try {
  const orders = f.orders.filter((o) => o.status === 'PAID');
  for (const o of orders) {
    o.settlement = {
      id: digest(o.orderId),
      lineDigest: digest('synthetic'),
      outcome: 'PAID',
      amountCents: o.totalCents,
    };
    await put({ ...orderKey(o.orderId), ...o });
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
    await put({
      ...refundKey(o.orderId),
      disposition: 'NONE',
      settlementId: o.settlement.id,
      updatedAt: new Date(now).toISOString(),
    });
  }
  const o = orders[0],
    other = orders[1];
  const original = await record(orderKey(o.orderId));
  for (const date of ['2026-10-23', '2026-10-24'])
    await put({
      PK: 'DROP#' + o.dropId,
      SK: 'PICKUP#' + date,
      dropId: o.dropId,
      date,
      startTime: '12:00',
      endTime: '15:00',
      timezone: 'America/Denver',
      active: true,
    });
  await notification.confirmation(o.orderId);
  await Promise.all([
    notification.deliver(o.orderId, 'CONFIRMATION#email'),
    notification.deliver(o.orderId, 'CONFIRMATION#email'),
  ]);
  assert.equal(mail.messages.length, 1);
  const token = tokenFrom(mail.messages[0]);
  assert.equal(token.length, 43);
  const view = await guest.view(token);
  assert.equal(view.order.reference, o.displayOrderNumber);
  assert.equal(view.order.totalCents, 945);
  assert(!JSON.stringify(view).includes(o.orderId));
  assert(!JSON.stringify(view).includes(token));
  const all = (await f.client.send(new ScanCommand({ TableName: f.table })))
    .Items;
  assert(!JSON.stringify(all).includes(token));
  assert(!JSON.stringify(transport.messages).includes(token));
  console.log(
    'PASS secure initial issuance, duplicate attempts, hash-only storage and private historical DTO',
  );
  for (const invalid of [
    'bad',
    o.displayOrderNumber,
    other.orderId,
    'A'.repeat(43),
  ])
    await assert.rejects(guest.view(invalid));
  console.log(
    'PASS invalid tokens, order-number/internal-ID access and cross-order access rejected',
  );
  const request = {
    token,
    requestId: randomUUID(),
    revision: view.revision,
    date: '2026-10-23',
  };
  let acknowledgementLost = false;
  const lostAckGuest = new GuestOrders(
    {
      send: async (command) => {
        const result = await f.client.send(command);
        if (
          command.constructor.name === 'TransactWriteCommand' &&
          !acknowledgementLost
        ) {
          acknowledgementLost = true;
          throw Error('Synthetic lost transaction acknowledgement');
        }
        return result;
      },
    },
    f.table,
    f.table,
    f.table,
    'https://synthetic.example.test',
    () => now,
  );
  assert.deepEqual(await lostAckGuest.change(request), {
    changed: true,
    revision: 1,
  });
  assert.equal(acknowledgementLost, true);
  assert.deepEqual(await guest.change(request), { changed: true, revision: 1 });
  let next = await guest.view(token);
  assert.equal(next.order.pickup.date, '2026-10-23');
  assert.equal(next.order.pickup.startTime, '12:00');
  assert.equal(
    (await f.repository.list({ pickupDate: '2026-10-22' })).orders.some(
      (x) => x.orderId === o.orderId,
    ),
    false,
  );
  assert.equal(
    (await f.repository.list({ pickupDate: '2026-10-23' })).orders.some(
      (x) => x.orderId === o.orderId,
    ),
    true,
  );
  const changed = await record(orderKey(o.orderId));
  for (const key of [
    'items',
    'subtotalCents',
    'taxCents',
    'feeCents',
    'totalCents',
    'paymentStatus',
    'settlement',
    'paymentAttemptId',
    'cartId',
  ])
    assert.deepEqual(changed[key], original[key]);
  console.log(
    'PASS idempotent pickup change, old/new index queries and unchanged financial snapshots',
  );
  const race = await Promise.allSettled([
    guest.change({
      token,
      requestId: randomUUID(),
      revision: 1,
      date: '2026-10-24',
    }),
    guest.change({
      token,
      requestId: randomUUID(),
      revision: 1,
      date: '2026-10-24',
    }),
  ]);
  assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1);
  await assert.rejects(
    guest.change({
      token,
      requestId: randomUUID(),
      revision: 2,
      date: '2026-11-01',
    }),
  );
  console.log(
    'PASS concurrent revision protection and out-of-Drop date rejection',
  );
  for (const disposition of ['UNKNOWN', 'PENDING', 'PARTIAL', 'FULL']) {
    await put({
      ...refundKey(o.orderId),
      disposition,
      settlementId: o.settlement.id,
      updatedAt: new Date(now).toISOString(),
    });
    await assert.rejects(
      guest.change({
        token,
        requestId: randomUUID(),
        revision: 2,
        date: '2026-10-23',
      }),
    );
  }
  await put({
    ...refundKey(o.orderId),
    disposition: 'NONE',
    settlementId: o.settlement.id,
    updatedAt: new Date(now).toISOString(),
  });
  const beforeCancel = await record(orderKey(o.orderId));
  await put({
    ...beforeCancel,
    status: 'CANCELLED',
    paymentStatus: 'CANCELLED',
  });
  await assert.rejects(
    guest.change({
      token,
      requestId: randomUUID(),
      revision: 2,
      date: '2026-10-23',
    }),
  );
  await put(beforeCancel);
  const { DeleteCommand } = require('@aws-sdk/lib-dynamodb');
  const fulfillment = {
    PK: 'ORDER#' + o.orderId,
    SK: 'FULFILLMENT',
    orderId: o.orderId,
    revision: 1,
    status: 'READY_FOR_PICKUP',
    history: [
      {
        requestId: randomUUID(),
        status: 'READY_FOR_PICKUP',
        at: new Date(now).toISOString(),
        administrator: 'synthetic',
        reason: 'synthetic',
      },
    ],
  };
  await put(fulfillment);
  await assert.rejects(
    guest.change({
      token,
      requestId: randomUUID(),
      revision: 2,
      date: '2026-10-23',
    }),
  );
  await f.client.send(
    new DeleteCommand({
      TableName: f.table,
      Key: { PK: fulfillment.PK, SK: fulfillment.SK },
    }),
  );
  console.log(
    'PASS all incompatible refund, cancellation and fulfillment states',
  );

  now = Date.parse('2026-10-23T21:00:00Z');
  await assert.rejects(
    guest.change({
      token,
      requestId: randomUUID(),
      revision: 2,
      date: '2026-10-23',
    }),
  );
  now = Date.parse('2026-10-20T18:00:00Z');
  await put({
    ...refundKey(o.orderId),
    disposition: 'PENDING',
    settlementId: o.settlement.id,
    updatedAt: new Date(now).toISOString(),
  });
  await assert.rejects(
    guest.change({
      token,
      requestId: randomUUID(),
      revision: 2,
      date: '2026-10-23',
    }),
  );
  await put({
    ...refundKey(o.orderId),
    disposition: 'NONE',
    settlementId: o.settlement.id,
    updatedAt: new Date(now).toISOString(),
  });
  const initialExpires = (await guest.adminStatus(o.orderId)).originalExpiresAt;
  assert.equal(initialExpires, accessExpiration('2026-10-22', '19:00'));
  console.log(
    'PASS cutoff/refund suppression and original expiration unchanged by pickup changes',
  );
  const admin = {
    requestId: randomUUID(),
    reason: 'Synthetic explicit replacement',
  };
  await guest.admin(o.orderId, 'reissue', admin, 'synthetic-admin');
  await guest.admin(o.orderId, 'reissue', admin, 'synthetic-admin');
  await notification.deliver(o.orderId, 'ACCESS#' + admin.requestId + '#email');
  assert.equal(mail.messages.length, 2);
  const replacement = tokenFrom(mail.messages[1]);
  await guest.view(token);
  await guest.view(replacement);
  assert.equal((await guest.adminStatus(o.orderId)).tokens.length, 2);
  await assert.rejects(
    guest.admin(
      o.orderId,
      'reissue',
      { requestId: randomUUID(), reason: 'Third token' },
      'synthetic-admin',
    ),
  );
  const first = (await guest.adminStatus(o.orderId)).tokens[0];
  await guest.admin(
    o.orderId,
    'revoke',
    {
      requestId: randomUUID(),
      reason: 'Explicit revocation',
      tokenId: first.id,
    },
    'synthetic-admin',
  );
  await assert.rejects(guest.view(token));
  await guest.view(replacement);
  console.log(
    'PASS audited idempotent reissue, two-token maximum, preserved old link and explicit revocation',
  );
  now = Date.parse(initialExpires);
  await assert.rejects(guest.view(replacement));
  now = Date.parse('2026-10-20T18:00:00Z');
  console.log('PASS server-side expiration');
  const lost = orders[2];
  const crash = new Notifications(
    f.client,
    f.table,
    f.table,
    transport,
    { email: mail, sms },
    {
      policies: 'Synthetic',
      now: () => now,
      issueManagementLink: async (op) => {
        await guest.issue(op);
        throw Error('synthetic crash after hash');
      },
    },
  );
  await crash.confirmation(lost.orderId);
  const sentBefore = mail.messages.length;
  await crash.deliver(lost.orderId, 'CONFIRMATION#email');
  await crash.deliver(lost.orderId, 'CONFIRMATION#email');
  assert.equal(mail.messages.length, sentBefore);
  assert.equal((await guest.adminStatus(lost.orderId)).tokens.length, 1);
  assert.equal(
    (await operation(lost, 'CONFIRMATION#email')).status,
    'UNCERTAIN',
  );
  console.log('PASS crash after hash persistence cannot issue or send again');
  const ambiguous = orders[3];
  provider = {
    send: async (m) => {
      mail.messages.push(m);
      throw Error('synthetic lost provider acknowledgement');
    },
  };
  await notification.confirmation(ambiguous.orderId);
  await notification.deliver(ambiguous.orderId, 'CONFIRMATION#email');
  const ambiguousToken = tokenFrom(mail.messages.at(-1));
  await notification.deliver(ambiguous.orderId, 'CONFIRMATION#email');
  assert.equal((await guest.adminStatus(ambiguous.orderId)).tokens.length, 1);
  await guest.view(ambiguousToken);
  assert.equal(
    (await operation(ambiguous, 'CONFIRMATION#email')).status,
    'UNCERTAIN',
  );
  console.log(
    'PASS lost provider acknowledgement preserves link without resend or rotation',
  );
  const rejected = orders[4];
  provider = {
    send: async () => {
      throw new DeliveryFailure(true);
    },
  };
  await notification.confirmation(rejected.orderId);
  await notification.deliver(rejected.orderId, 'CONFIRMATION#email');
  await notification.deliver(rejected.orderId, 'CONFIRMATION#email');
  assert.equal(
    (await operation(rejected, 'CONFIRMATION#email')).status,
    'FAILED',
  );
  assert.equal((await guest.adminStatus(rejected.orderId)).tokens.length, 1);
  provider = mail;
  const explicit = {
    requestId: randomUUID(),
    reason: 'Confirmed provider rejection replacement',
  };
  await guest.admin(rejected.orderId, 'reissue', explicit, 'synthetic-admin');
  await notification.deliver(
    rejected.orderId,
    'ACCESS#' + explicit.requestId + '#email',
  );
  assert.equal((await guest.adminStatus(rejected.orderId)).tokens.length, 2);
  console.log(
    'PASS definitive rejection requires explicit replacement, no automatic second issuance',
  );

  const accepted = orders[5],
    acceptedMail = new MockEmailProvider();
  let lostAck = true;
  const ackClient = {
    send: async (command) => {
      if (
        command.constructor.name === 'PutCommand' &&
        command.input.Item?.status === 'SENT' &&
        lostAck
      ) {
        lostAck = false;
        throw Error('synthetic persistence acknowledgement loss');
      }
      return f.client.send(command);
    },
  };
  const ackService = new Notifications(
    ackClient,
    f.table,
    f.table,
    transport,
    { email: acceptedMail, sms },
    {
      policies: 'Synthetic',
      now: () => now,
      issueManagementLink: (op) => guest.issue(op),
    },
  );
  await ackService.confirmation(accepted.orderId);
  await assert.rejects(
    ackService.deliver(accepted.orderId, 'CONFIRMATION#email'),
  );
  now += 360000;
  await ackService.deliver(accepted.orderId, 'CONFIRMATION#email');
  assert.equal(acceptedMail.messages.length, 1);
  await guest.view(tokenFrom(acceptedMail.messages[0]));
  assert.equal(
    (await operation(accepted, 'CONFIRMATION#email')).status,
    'UNCERTAIN',
  );
  console.log(
    'PASS provider acceptance followed by persistence failure preserves the valid link without resend',
  );
  const changeOp = (await status.status(o.orderId)).notifications.find(
    (n) => n.kind === 'PICKUP_CHANGE' && n.pickupDate === '2026-10-23',
  );
  await notification.deliver(o.orderId, changeOp.key);
  assert.equal((await operation(o, changeOp.key)).reason, 'PICKUP_CHANGED');
  const sentCount = mail.messages.length;
  await notification.poll();
  assert.equal(mail.messages.length, sentCount);
  assert(transport.schedules.has('pickup-reminder-2026-10-24'));
  console.log(
    'PASS changed-date schedules and suppression of obsolete change messages without real sending',
  );
  for (let i = 0; i < 60; i++) await guest.rateLimit('synthetic-source');
  await assert.rejects(guest.rateLimit('synthetic-source'));
  console.log('PASS bounded persistent request rate limiting');
} finally {
  await f.close();
}
