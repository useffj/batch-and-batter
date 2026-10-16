import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fixtures } from './orders-local-fixtures.mjs';
const require = createRequire(import.meta.url);
const {
  PutCommand,
  DeleteCommand,
  ScanCommand,
} = require('@aws-sdk/lib-dynamodb');
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
const {
  refundKey,
  consentKey,
  suppressionKey,
  digest,
  operationKey,
  dueKey,
} = require('../dist/src/notification-contract');
const { orderKey } = require('../dist/src/payment-domain');
const f = await fixtures();
let now = Date.parse('2026-10-21T16:01:00Z');
const transport = new MockNotificationTransport(),
  email = new MockEmailProvider(),
  sms = new MockSmsProvider();
let provider = email;
const service = new Notifications(
  f.client,
  f.table,
  f.table,
  transport,
  { email: { send: (m) => provider.send(m) }, sms },
  {
    policies: 'Synthetic policy: contact the bakery for pickup changes.',
    now: () => now,
  },
);
const status = new AdminNotifications(f.client, f.table);
const put = async (Item) =>
  f.client.send(new PutCommand({ TableName: f.table, Item }));
const remove = async (Key) =>
  f.client.send(new DeleteCommand({ TableName: f.table, Key }));
const snapshot = async () => {
  const r = await f.client.send(new ScanCommand({ TableName: f.table }));
  return r.Items.filter(
    (r) => r.PK.startsWith('ORDER#') && r.SK === 'META',
  ).sort((a, b) => a.PK.localeCompare(b.PK));
};
async function seed(order) {
  order.settlement = {
    id: digest(order.orderId),
    lineDigest: digest('synthetic'),
    outcome: 'PAID',
    amountCents: order.totalCents,
  };
  await put({ ...orderKey(order.orderId), ...order });
  await put({
    PK: 'ORDER_EVENT#' + order.orderId + '#PAID',
    SK: 'META',
    schemaVersion: 1,
    eventType: 'PAID',
    orderId: order.orderId,
    cartId: order.cartId,
    paymentAttemptId: order.paymentAttemptId,
    dropId: order.dropId,
    settlementId: order.settlement.id,
    createdAt: '2026-10-20T18:00:00.000Z',
  });
  await refund(order, 'NONE');
}
async function refund(order, disposition) {
  await put({
    ...refundKey(order.orderId),
    disposition,
    settlementId: order.settlement.id,
    updatedAt: new Date(now).toISOString(),
  });
}
async function clearReminder(order) {
  for (const c of ['email', 'sms']) {
    const key = 'REMINDER#2026-10-22#' + c;
    await remove(operationKey(order.orderId, key));
    await remove(dueKey({ orderId: order.orderId, key }));
  }
}
const op = async (order, key) =>
  (await status.status(order.orderId)).notifications.find((n) => n.key === key);
try {
  const paid = f.orders.filter((o) => o.status === 'PAID');
  for (const order of paid) await seed(order);
  const original = await snapshot();
  const o = paid[0],
    id = o.orderId;
  await Promise.all([service.confirmation(id), service.confirmation(id)]);
  await Promise.all([
    service.deliver(id, 'CONFIRMATION#email'),
    service.deliver(id, 'CONFIRMATION#email'),
  ]);
  assert.equal(email.messages.length, 1);
  assert.equal((await op(o, 'CONFIRMATION#email')).status, 'SENT');
  assert.match(email.messages[0].text, /9.45 USD/);
  assert.match(email.messages[0].text, /Historical chocolate cookie/);
  assert.equal(transport.schedules.size, 0); // Reminder time has already passed.
  console.log(
    'PASS duplicate authoritative confirmations and concurrent delivery',
  );
  for (const disposition of ['UNKNOWN', 'PENDING', 'PARTIAL', 'FULL']) {
    await clearReminder(o);
    await refund(o, disposition);
    await service.reminders('2026-10-22');
    assert.equal(
      (await op(o, 'REMINDER#2026-10-22#email')).reason,
      'REFUND_' + disposition,
    );
  }
  await clearReminder(o);
  await remove(refundKey(id));
  await service.reminders('2026-10-22');
  assert.equal(
    (await op(o, 'REMINDER#2026-10-22#email')).reason,
    'REFUND_UNKNOWN',
  );
  console.log('PASS historical unknown and all refund suppression states');
  await clearReminder(o);
  await refund(o, 'NONE');
  await service.reminders('2026-10-22');
  assert.equal((await op(o, 'REMINDER#2026-10-22#email')).status, 'PENDING');
  assert.equal(
    (await op(o, 'REMINDER#2026-10-22#sms')).reason,
    'SMS_CONSENT_UNVERIFIED',
  );
  await refund(o, 'FULL');
  await service.deliver(id, 'REMINDER#2026-10-22#email');
  assert.equal((await op(o, 'REMINDER#2026-10-22#email')).status, 'SUPPRESSED');
  assert.equal(email.messages.length, 1);
  console.log(
    'PASS refund change before send and boolean-only consent rejection',
  );
  await refund(o, 'NONE');
  await put({
    ...consentKey(id),
    phone: o.customer.phone,
    smsTransactionalConsent: true,
    consentedAt: '2026-10-20T18:00:00.000Z',
    consentSource: 'CHECKOUT_V1',
    optOutAt: null,
  });
  await clearReminder(o);
  await service.reminders('2026-10-22');
  assert.equal(
    (await op(o, 'REMINDER#2026-10-22#sms')).reason,
    'SMS_SUPPRESSION_UNVERIFIED',
  );
  await put({
    ...suppressionKey(o.customer.phone),
    phoneHash: digest(o.customer.phone),
    revision: 1,
    verifiedAt: new Date(now).toISOString(),
    optOutAt: null,
  });
  await clearReminder(o);
  await service.reminders('2026-10-22');
  await service.reminders('2026-10-22');
  await service.deliver(id, 'REMINDER#2026-10-22#sms');
  assert.equal(sms.messages.length, 1);
  await clearReminder(o);
  await service.reminders('2026-10-22');
  await put({
    ...suppressionKey(o.customer.phone),
    phoneHash: digest(o.customer.phone),
    revision: 2,
    verifiedAt: new Date(now).toISOString(),
    optOutAt: new Date(now).toISOString(),
  });
  await service.deliver(id, 'REMINDER#2026-10-22#sms');
  assert.equal(sms.messages.length, 1);
  assert.equal(
    (await op(o, 'REMINDER#2026-10-22#sms')).reason,
    'SMS_OPTED_OUT',
  );
  console.log(
    'PASS provenance, current opt-out, independent SMS and duplicate reminders',
  );
  const failed = paid[1];
  await service.confirmation(failed.orderId);
  let calls = 0;
  provider = {
    send: async () => {
      calls++;
      throw new DeliveryFailure(true);
    },
  };
  for (let i = 0; i < 5; i++)
    await service.deliver(failed.orderId, 'CONFIRMATION#email');
  assert.equal(calls, 3);
  assert.equal((await op(failed, 'CONFIRMATION#email')).status, 'FAILED');
  const uncertain = paid[2];
  await service.confirmation(uncertain.orderId);
  calls = 0;
  provider = {
    send: async () => {
      calls++;
      throw Error('synthetic acknowledgement lost with private content');
    },
  };
  await service.deliver(uncertain.orderId, 'CONFIRMATION#email');
  await service.deliver(uncertain.orderId, 'CONFIRMATION#email');
  assert.equal(calls, 1);
  assert.equal((await op(uncertain, 'CONFIRMATION#email')).status, 'UNCERTAIN');
  assert(
    !JSON.stringify(await status.status(uncertain.orderId)).includes(
      'private content',
    ),
  );
  console.log('PASS bounded failure retries and acknowledgement ambiguity');
  assert.deepEqual(await snapshot(), original);
  console.log('PASS no Order or financial mutation');
  // A cancelled order may have a durable pending operation, but cannot send it.
  const cancelled = paid[3];
  await service.confirmation(cancelled.orderId);
  await put({
    ...orderKey(cancelled.orderId),
    ...cancelled,
    status: 'CANCELLED',
    paymentStatus: 'CANCELLED',
  });
  await service.deliver(cancelled.orderId, 'CONFIRMATION#email');
  assert.equal(
    (await op(cancelled, 'CONFIRMATION#email')).reason,
    'PAYMENT_NOT_ELIGIBLE',
  );
  console.log('PASS cancellation recheck');
  const ack = paid[6];
  const ackProvider = new MockEmailProvider();
  const ackClient = {
    send: async (command) => {
      if (
        command.constructor.name === 'PutCommand' &&
        command.input.Item?.status === 'SENT'
      )
        throw Error('synthetic write acknowledgement loss');
      return f.client.send(command);
    },
  };
  const ackService = new Notifications(
    ackClient,
    f.table,
    f.table,
    transport,
    { email: ackProvider, sms },
    { policies: 'Synthetic policy', now: () => now },
  );
  await ackService.confirmation(ack.orderId);
  await assert.rejects(ackService.deliver(ack.orderId, 'CONFIRMATION#email'));
  await ackService.deliver(ack.orderId, 'CONFIRMATION#email');
  now += 360000;
  await ackService.deliver(ack.orderId, 'CONFIRMATION#email');
  assert.equal(ackProvider.messages.length, 1);
  assert.equal((await op(ack, 'CONFIRMATION#email')).status, 'UNCERTAIN');
  console.log(
    'PASS provider success followed by persistence failure never resends',
  );
  await clearReminder(o);
  await put({
    ...suppressionKey(o.customer.phone),
    phoneHash: digest(o.customer.phone),
    revision: 3,
    verifiedAt: new Date(now).toISOString(),
    optOutAt: null,
  });
  const smsFailure = new Notifications(
    f.client,
    f.table,
    f.table,
    transport,
    {
      email,
      sms: {
        send: async () => {
          throw new DeliveryFailure(false);
        },
      },
    },
    { policies: 'Synthetic policy', now: () => now },
  );
  await smsFailure.reminders('2026-10-22');
  await smsFailure.deliver(id, 'REMINDER#2026-10-22#sms');
  assert.equal((await op(o, 'REMINDER#2026-10-22#sms')).status, 'FAILED');
  assert.equal((await op(o, 'REMINDER#2026-10-22#email')).status, 'PENDING');
  console.log('PASS SMS failure does not change email operation');

  now = Date.parse('2026-10-20T16:00:00Z');
  await service.confirmation(paid[4].orderId);
  await service.confirmation(paid[5].orderId);
  assert.equal(transport.schedules.size, 1);
  await assert.rejects(service.reminders('2026-10-22'), /not due/);
  console.log('PASS one schedule per date and early-trigger rejection');
} finally {
  await f.close();
}
