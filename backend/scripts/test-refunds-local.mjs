import { seedRefundOrder } from './refund-local-fixtures.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fixtures } from './orders-local-fixtures.mjs';
const require = createRequire(import.meta.url);
const { PutCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { Refunds } = require('../dist/src/refunds');
const { MockStripeRefundProvider } = require('../dist/src/refund-provider');
const { refundKey } = require('../dist/src/notification-contract');
const { ledgerKey } = require('../dist/src/refund-domain');
const { orderKey, attemptKey } = require('../dist/src/payment-domain');
const {
  command,
  nextWorkflow,
  associationKey,
} = require('../dist/src/payment-execution-domain');
const { catalogKeys } = require('../dist/src/keys');
const { cancellationKey } = require('../dist/src/cancellation-requests');
const f = await fixtures();
let now = Date.parse('2026-10-20T18:00:00Z');
const provider = new MockStripeRefundProvider();
const scope = 'dev:acct_SYNTHETIC';
const coordinator = (client = f.client, p = provider) =>
  new Refunds(client, f.table, f.table, f.table, p, scope, () => now);
const put = (Item) =>
  f.client.send(new PutCommand({ TableName: f.table, Item }));
const read = async (Key) =>
  (
    await f.client.send(
      new GetCommand({ TableName: f.table, Key, ConsistentRead: true }),
    )
  ).Item;
const input = (amountCents = 945) => ({
  operationId: randomUUID(),
  amountCents,
  reason: 'Synthetic refund',
  disposition: 'DO_NOT_RESTOCK',
  physicallyAvailable: false,
  items: [],
});
const seed = (n) => seedRefundOrder(f, n, now);

async function success(o, i, r = coordinator()) {
  await r.authorize(o.orderId, i, 'synthetic-admin');
  now += 10;
  await r.run(o.orderId, i.operationId);
  provider.refunds.get(i.operationId).status = 'succeeded';
  now += 1000000;
  return r.run(o.orderId, i.operationId);
}
try {
  const r = coordinator();
  const o = await seed(0),
    i = input();
  await put({
    ...cancellationKey(o.orderId),
    orderId: o.orderId,
    requestId: randomUUID(),
    type: 'GUARANTEED',
    reason: '',
    status: 'RECEIVED_PENDING_PROCESSING',
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    revision: 1,
    eligibility: {
      deadline: new Date(now + 1e6).toISOString(),
      hours: 24,
      pickupDate: o.pickup.date,
      pickupStart: o.pickup.startTime,
      orderUpdatedAt: o.updatedAt,
      settlementId: o.settlement.id,
      refundDisposition: 'NONE',
      fulfillment: null,
      amountCents: o.totalCents,
      currency: o.currency,
    },
  });
  await assert.rejects(r.authorize(o.orderId, input(100), 'synthetic-admin'));
  await r.authorize(o.orderId, i, 'synthetic-admin');
  assert.equal(
    (await r.authorize(o.orderId, i, 'synthetic-admin')).operationId,
    i.operationId,
  );
  await assert.rejects(r.authorize(o.orderId, input(), 'synthetic-admin'));
  now += 10;
  assert.equal((await r.run(o.orderId, i.operationId)).status, 'PENDING');
  assert.equal((await read(orderKey(o.orderId))).status, 'PAID');
  provider.refunds.get(i.operationId).status = 'succeeded';
  now += 1000000;
  assert.equal((await r.run(o.orderId, i.operationId)).status, 'SUCCEEDED');
  assert.equal((await read(orderKey(o.orderId))).status, 'CANCELLED');
  assert.equal((await read(ledgerKey(o.orderId))).refundedCents, 945);
  await r.run(o.orderId, i.operationId);
  assert.equal(provider.calls, 1);
  assert.ok(
    await read({ PK: 'REFUND_COMPLETION#' + o.orderId, SK: i.operationId }),
  );
  console.log(
    'PASS guaranteed full, partial refusal, duplicate, competing authorization, pending, success, notification, no repeat create',
  );
  const partial = await seed(1);
  await success(partial, input(400));
  assert.equal((await read(orderKey(partial.orderId))).status, 'PAID');
  await assert.rejects(
    r.authorize(partial.orderId, input(546), 'synthetic-admin'),
  );
  await success(partial, input(545));
  assert.equal((await read(ledgerKey(partial.orderId))).refundedCents, 945);
  assert.equal(
    (
      await read(
        catalogKeys.inventory(partial.dropId, partial.items[0].productId),
      )
    ).sold,
    50,
  );
  console.log(
    'PASS partial, cumulative amount, retained historical totals and no inferred restock',
  );
  const race = await seed(2);
  const results = await Promise.allSettled([
    r.authorize(race.orderId, input(600), 'synthetic-admin'),
    r.authorize(race.orderId, input(600), 'synthetic-admin'),
  ]);
  assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
  console.log('PASS concurrent amount reservation');
  const unknown = await seed(3);
  await put({
    ...refundKey(unknown.orderId),
    disposition: 'UNKNOWN',
    settlementId: unknown.settlement.id,
    updatedAt: new Date(now).toISOString(),
  });
  await assert.rejects(
    r.authorize(unknown.orderId, input(), 'synthetic-admin'),
  );
  await assert.rejects(r.authorize(partial.orderId, input(), ''));
  console.log('PASS unknown evidence and missing administrator');
  const lost = await seed(4),
    li = input();
  provider.loseAcknowledgement = true;
  await r.authorize(lost.orderId, li, 'synthetic-admin');
  now += 10;
  const before = provider.calls;
  await r.run(lost.orderId, li.operationId);
  provider.loseAcknowledgement = false;
  provider.refunds.get(li.operationId).status = 'succeeded';
  now += 1000000;
  await coordinator().run(lost.orderId, li.operationId);
  assert.equal(provider.calls, before + 1);
  console.log('PASS lost acknowledgement and process restart');
  const restock = await seed(5),
    ri = {
      ...input(),
      disposition: 'RESTOCK',
      physicallyAvailable: true,
      items: [{ productId: restock.items[0].productId, quantity: 2 }],
    };
  await success(restock, ri);
  await r.run(restock.orderId, ri.operationId);
  assert.equal(
    (
      await read(
        catalogKeys.inventory(restock.dropId, restock.items[0].productId),
      )
    ).sold,
    48,
  );
  console.log('PASS explicit restock once');
  const failed = await seed(6),
    fi = input();
  await r.authorize(failed.orderId, fi, 'synthetic-admin');
  now += 10;
  await r.run(failed.orderId, fi.operationId);
  provider.refunds.get(fi.operationId).status = 'failed';
  now += 1000000;
  assert.equal((await r.run(failed.orderId, fi.operationId)).status, 'FAILED');
  assert.equal((await read(ledgerKey(failed.orderId))).refundedCents, 0);
  console.log(
    'PASS failed refund releases reservation without refund or restock',
  );
  const db = await seed(7),
    di = input();
  await r.authorize(db.orderId, di, 'synthetic-admin');
  now += 10;
  await r.run(db.orderId, di.operationId);
  provider.refunds.get(di.operationId).status = 'succeeded';
  now += 1000000;
  const broken = {
    send: (cmd) => {
      if (cmd.constructor.name === 'TransactWriteCommand')
        throw Error('INJECTED_DATABASE_FAILURE');
      return f.client.send(cmd);
    },
  };
  await assert.rejects(coordinator(broken).run(db.orderId, di.operationId));
  const calls = provider.calls;
  await coordinator().run(db.orderId, di.operationId);
  assert.equal(provider.calls, calls);
  console.log(
    'PASS provider success/database failure recovery without new refund',
  );

  const events = await seed(8),
    ei = input(200);
  await r.authorize(events.orderId, ei, 'synthetic-admin');
  now += 10;
  await r.run(events.orderId, ei.operationId);
  provider.refunds.get(ei.operationId).status = 'succeeded';
  const event = {
    eventId: 'evt_SYNTHETIC1',
    orderId: events.orderId,
    operationId: ei.operationId,
    refundId: provider.refunds.get(ei.operationId).id,
  };
  await r.webhook(event);
  await r.webhook(event);
  await r.webhook({ ...event, eventId: 'evt_SYNTHETICOLD' });
  assert.equal((await read(ledgerKey(events.orderId))).refundedCents, 200);
  console.log(
    'PASS duplicate and out-of-order wakeups use canonical provider state',
  );
  const mismatch = await seed(9),
    mi = input();
  await r.authorize(mismatch.orderId, mi, 'synthetic-admin');
  now += 10;
  await r.run(mismatch.orderId, mi.operationId);
  const snapshot = provider.refunds.get(mi.operationId);
  snapshot.accountId = 'acct_WRONG';
  now += 1000000;
  await assert.rejects(r.run(mismatch.orderId, mi.operationId));
  snapshot.accountId = provider.accountId;
  snapshot.environment = 'live';
  await assert.rejects(r.run(mismatch.orderId, mi.operationId));
  snapshot.environment = 'dev';
  console.log('PASS wrong account and environment retain reserved amount');
  const uncertain = await seed(10),
    ui = input();
  await r.authorize(uncertain.orderId, ui, 'synthetic-admin');
  now += 10;
  provider.unavailable = true;
  assert.equal(
    (await r.run(uncertain.orderId, ui.operationId)).status,
    'RECONCILIATION_REQUIRED',
  );
  provider.unavailable = false;
  provider.refunds.get(ui.operationId).status = 'succeeded';
  now += 1000000;
  await r.run(uncertain.orderId, ui.operationId);
  console.log('PASS uncertain outcome and bounded reconciliation');
  const collected = await seed(11);
  await put({
    PK: 'ORDER#' + collected.orderId,
    SK: 'FULFILLMENT',
    orderId: collected.orderId,
    revision: 1,
    status: 'PICKED_UP',
    history: [
      {
        requestId: randomUUID(),
        status: 'PICKED_UP',
        at: new Date(now).toISOString(),
        administrator: 'synthetic-admin',
        reason: 'Synthetic collection',
      },
    ],
  });
  await assert.rejects(
    r.authorize(
      collected.orderId,
      {
        ...input(),
        disposition: 'RESTOCK',
        physicallyAvailable: true,
        items: [{ productId: collected.items[0].productId, quantity: 1 }],
      },
      'synthetic-admin',
    ),
  );
  console.log('PASS collected inventory cannot be returned');
  const { FulfillmentRepository } = require('../dist/src/admin-fulfillment');
  const fulfillment = new FulfillmentRepository(f.client, f.table, () => now);
  await assert.rejects(
    fulfillment.transition(
      race.orderId,
      {
        requestId: randomUUID(),
        revision: 0,
        status: 'READY_FOR_PICKUP',
        reason: '',
      },
      'synthetic-admin',
    ),
  );
  console.log('PASS fulfillment blocked by active refund claim');
  const { Notifications } = require('../dist/src/notifications');
  const {
    MockEmailProvider,
    MockSmsProvider,
  } = require('../dist/src/notification-providers');
  const {
    MockNotificationTransport,
  } = require('../dist/src/notification-transport');
  const mail = new MockEmailProvider();
  const notifications = new Notifications(
    f.client,
    f.table,
    f.table,
    new MockNotificationTransport(),
    { email: mail, sms: new MockSmsProvider() },
    { policies: 'Synthetic only', now: () => now },
  );
  await notifications.deliver(o.orderId, 'REFUND#' + i.operationId + '#email');
  await notifications.deliver(o.orderId, 'REFUND#' + i.operationId + '#email');
  assert.equal(mail.messages.length, 1);
  assert.match(mail.messages[0].text, /Refund completed: 9.45 USD/);
  assert.doesNotMatch(mail.messages[0].text, /Pickup:/);
  console.log(
    'PASS completion email prepared atomically and delivered once through mock provider',
  );
  const { GuestOrders } = require('../dist/src/guest-orders');
  const guest = new GuestOrders(
    f.client,
    f.table,
    f.table,
    f.table,
    'https://synthetic.example.test',
    () => now,
  );
  // Existing token authorization is tested independently; the summary must expose no admin reason/account.
  const summary = await r.view(events.orderId);
  assert.equal(summary.refundedCents, 200);
  assert.equal(summary.remainingCents, 745);
  console.log('PASS authoritative administrator totals and immutable prices');
  const changed = await seed(12),
    ci = input();
  const attempt = await read(attemptKey(changed.paymentAttemptId));
  delete attempt.execution.captureEvidence;
  await put(attempt);
  await assert.rejects(r.authorize(changed.orderId, ci, 'synthetic-admin'));
  console.log(
    'PASS authorization holds/missing capture cannot authorize refunds',
  );
  const reversed = provider.refunds.get(ei.operationId);
  reversed.status = 'failed';
  await r.webhook({ ...event, eventId: 'evt_SYNTHETICREVERSAL' });
  assert.equal((await read(ledgerKey(events.orderId))).blocked, true);
  await assert.rejects(
    r.authorize(events.orderId, input(100), 'synthetic-admin'),
  );
  console.log(
    'PASS contradictory terminal provider evidence freezes further refunds for operator reconciliation',
  );

  const { FinancialWorkflow } = require('../dist/src/payment-settlement');
  const payments = new FinancialWorkflow(
    f.client,
    f.table,
    f.table,
    {},
    scope,
    f.table,
    () => now,
  );
  assert.equal(await payments.completed(o.paymentAttemptId), true);
  console.log(
    'PASS historical payment completion remains valid after full refund',
  );
  const customer = await seed(13),
    customerMail = new MockEmailProvider();
  const customerNotifications = new Notifications(
    f.client,
    f.table,
    f.table,
    new MockNotificationTransport(),
    { email: customerMail, sms: new MockSmsProvider() },
    {
      policies: 'Synthetic',
      now: () => now,
      issueManagementLink: (op) => guest.issue(op),
    },
  );
  await customerNotifications.confirmation(customer.orderId);
  await customerNotifications.deliver(customer.orderId, 'CONFIRMATION#email');
  const token = customerMail.messages[0].text
    .split('/order/manage#')[1]
    .split(/\s/)[0];
  await success(customer, input());
  const customerView = await guest.view(token);
  assert.equal(customerView.refund.status, 'SUCCEEDED');
  assert.equal(customerView.refund.refundedCents, 945);
  assert.equal(customerView.order.status, 'CANCELLED');
  assert.doesNotMatch(
    JSON.stringify(customerView),
    /acct_SYNTHETIC|synthetic-admin|re_SYNTHETIC/,
  );
  console.log(
    'PASS secure customer view shows completion without provider or administrator data',
  );
  const exception = await seed(14);
  await put({
    ...cancellationKey(exception.orderId),
    orderId: exception.orderId,
    requestId: randomUUID(),
    type: 'EXCEPTION',
    reason: 'Synthetic late request',
    status: 'APPROVED_PENDING_PROCESSING',
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    revision: 2,
    eligibility: {
      deadline: new Date(now - 1e6).toISOString(),
      hours: 24,
      pickupDate: exception.pickup.date,
      pickupStart: exception.pickup.startTime,
      orderUpdatedAt: exception.updatedAt,
      settlementId: exception.settlement.id,
      refundDisposition: 'NONE',
      fulfillment: null,
      amountCents: 945,
      currency: 'usd',
    },
  });
  await success(exception, input(200));
  assert.equal((await read(ledgerKey(exception.orderId))).refundedCents, 200);
  console.log(
    'PASS administrator-approved exception can receive a partial refund',
  );
  const returned = await seed(15);
  await success(returned, {
    ...input(100),
    disposition: 'RESTOCK',
    physicallyAvailable: true,
    items: [{ productId: returned.items[0].productId, quantity: 1 }],
  });
  assert.equal(
    (
      await read(
        catalogKeys.inventory(returned.dropId, returned.items[0].productId),
      )
    ).sold,
    49,
  );
  assert.equal((await read(orderKey(returned.orderId))).status, 'PAID');
  console.log(
    'PASS partial restock uses explicit units, not monetary inference',
  );
  const canceled = await seed(16),
    cancelInput = input();
  provider.initialStatus = 'canceled';
  await r.authorize(canceled.orderId, cancelInput, 'synthetic-admin');
  now += 10;
  assert.equal(
    (await r.run(canceled.orderId, cancelInput.operationId)).status,
    'CANCELED',
  );
  provider.initialStatus = 'pending';
  assert.equal((await read(ledgerKey(canceled.orderId))).refundedCents, 0);
  console.log('PASS canceled provider refund is not presented as completed');
  const replay = await seed(17),
    replayInput = input();
  let lostReply = true;
  const loseDbReply = {
    send: async (cmd) => {
      const result = await f.client.send(cmd);
      if (cmd.constructor.name === 'TransactWriteCommand' && lostReply) {
        lostReply = false;
        throw Error('LOST_DATABASE_ACK');
      }
      return result;
    },
  };
  await coordinator(loseDbReply).authorize(
    replay.orderId,
    replayInput,
    'synthetic-admin',
  );
  await r.authorize(replay.orderId, replayInput, 'synthetic-admin');
  assert.equal((await read(ledgerKey(replay.orderId))).reservedCents, 945);
  console.log(
    'PASS authorization database acknowledgement loss replays original operation',
  );
  const parallel = await seed(18),
    parallelInput = input();
  await r.authorize(parallel.orderId, parallelInput, 'synthetic-admin');
  now += 10;
  const startCalls = provider.calls;
  await Promise.allSettled([
    r.run(parallel.orderId, parallelInput.operationId),
    r.run(parallel.orderId, parallelInput.operationId),
  ]);
  assert.equal(provider.calls, startCalls + 1);
  console.log('PASS concurrent workers issue only one original refund create');

  const changedCommand = await seed(19),
    changedInput = input(400);
  await r.authorize(changedCommand.orderId, changedInput, 'synthetic-admin');
  const commandKey = {
    PK: 'ORDER_REFUNDS#' + changedCommand.orderId,
    SK: changedInput.operationId,
  };
  const stored = await read(commandKey);
  await put({ ...stored, amountCents: 401 });
  now += 10;
  const previousCalls = provider.calls;
  await assert.rejects(r.run(changedCommand.orderId, changedInput.operationId));
  assert.equal(provider.calls, previousCalls);
  console.log(
    'PASS contradictory command/ledger amount blocks provider dispatch',
  );
  const crossed = await seed(20),
    crossedInput = input(100);
  await r.authorize(crossed.orderId, crossedInput, 'synthetic-admin');
  now += 10;
  await r.run(crossed.orderId, crossedInput.operationId);
  provider.refunds.get(crossedInput.operationId).status = 'succeeded';
  now += 1000000;
  let interleave = true;
  const crossing = {
    send: async (cmd) => {
      if (cmd.constructor.name === 'QueryCommand' && interleave) {
        interleave = false;
        await r.run(crossed.orderId, crossedInput.operationId);
      }
      return f.client.send(cmd);
    },
  };
  await assert.rejects(coordinator(crossing).view(crossed.orderId));
  assert.equal((await r.view(crossed.orderId)).refundedCents, 100);
  console.log(
    'PASS cross-completion administrator reads fail closed instead of mixing totals',
  );

  const guestRace = await seed(21),
    guestRaceMail = new MockEmailProvider();
  const issuer = new Notifications(
    f.client,
    f.table,
    f.table,
    new MockNotificationTransport(),
    { email: guestRaceMail, sms: new MockSmsProvider() },
    {
      policies: 'Synthetic',
      now: () => now,
      issueManagementLink: (op) => guest.issue(op),
    },
  );
  await issuer.confirmation(guestRace.orderId);
  await issuer.deliver(guestRace.orderId, 'CONFIRMATION#email');
  const guestRaceToken = guestRaceMail.messages[0].text
    .split('/order/manage#')[1]
    .split(/\s/)[0];
  const guestRaceInput = input(100);
  await r.authorize(guestRace.orderId, guestRaceInput, 'synthetic-admin');
  now += 10;
  await r.run(guestRace.orderId, guestRaceInput.operationId);
  provider.refunds.get(guestRaceInput.operationId).status = 'succeeded';
  now += 1000000;
  let crossGuest = true;
  const guestClient = {
    send: async (cmd) => {
      if (
        cmd.constructor.name === 'GetCommand' &&
        cmd.input.Key.PK === 'ORDER_REFUNDS#' + guestRace.orderId &&
        crossGuest
      ) {
        crossGuest = false;
        await r.run(guestRace.orderId, guestRaceInput.operationId);
      }
      return f.client.send(cmd);
    },
  };
  const racingGuest = new GuestOrders(
    guestClient,
    f.table,
    f.table,
    f.table,
    'https://synthetic.example.test',
    () => now,
  );
  await assert.rejects(racingGuest.view(guestRaceToken));
  assert.equal((await guest.view(guestRaceToken)).refund.refundedCents, 100);
  console.log(
    'PASS cross-completion customer reads require refresh rather than showing mixed financial state',
  );
} finally {
  await f.close();
}
