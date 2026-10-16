import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fixtures } from './orders-local-fixtures.mjs';
const require = createRequire(import.meta.url);
const { Waitlists } = require('../dist/src/waitlists');
const {
  MockEmailProvider,
  DeliveryFailure,
} = require('../dist/src/notification-providers');
const {
  PutCommand,
  GetCommand,
  QueryCommand,
} = require('@aws-sdk/lib-dynamodb');
const { catalogKeys } = require('../dist/src/keys');
const f = require('../dist/test/fixtures');
const x = await fixtures(),
  { client, table } = x;
let time = Date.parse('2026-10-15T12:00:00Z');
const queue = {
    messages: [],
    async enqueue(m) {
      this.messages.push(m);
    },
  },
  email = new MockEmailProvider();
const guardedClient = {
  send: async (command) => {
    assert.notEqual(command.constructor.name, 'ScanCommand');
    const writes = command.input.TransactItems ?? [command.input];
    for (const operation of writes) {
      const mutation =
        operation.Put ??
        operation.Update ??
        operation.Delete ??
        (command.constructor.name === 'UpdateCommand' ? operation : null);
      if (mutation)
        assert.match((mutation.Item ?? mutation.Key).PK, /^WAITLIST(?:_|#)/);
    }
    return client.send(command);
  },
};
const service = new Waitlists(
  guardedClient,
  table,
  table,
  table,
  Buffer.alloc(32, 7),
  'https://synthetic.example',
  queue,
  email,
  () => time,
);
const scope = { dropId: f.dropId, productId: f.productId },
  input = { ...scope, email: 'SYNTHETIC@example.invalid', consent: true };
async function put(key, value) {
  await client.send(
    new PutCommand({ TableName: table, Item: { ...key, ...value } }),
  );
}
async function stock(total) {
  await put(catalogKeys.inventory(f.dropId, f.productId), {
    ...f.inventory,
    total,
    reserved: 0,
    sold: 0,
    updatedAt: new Date(time++).toISOString(),
  });
}
async function get(key) {
  return (
    await client.send(
      new GetCommand({ TableName: table, Key: key, ConsistentRead: true }),
    )
  ).Item;
}
try {
  await put(catalogKeys.product(f.productId), f.product);
  await put(catalogKeys.drop(f.dropId), f.drop);
  await put(catalogKeys.dropProduct(f.dropId, f.productId), f.relation);
  await put(catalogKeys.storefront, {
    storefrontDropId: f.dropId,
    updatedAt: f.timestamp,
  });
  await stock(0);
  await put(catalogKeys.product(f.productId), { ...f.product, active: false });
  await assert.rejects(() => service.join(input));
  await put(catalogKeys.product(f.productId), f.product);
  await put(catalogKeys.dropProduct(f.dropId, f.productId), {
    ...f.relation,
    active: false,
  });
  await assert.rejects(() => service.join(input));
  await put(catalogKeys.dropProduct(f.dropId, f.productId), f.relation);
  for (const status of ['DRAFT', 'CLOSED', 'COMPLETED']) {
    await put(catalogKeys.drop(f.dropId), { ...f.drop, status });
    await assert.rejects(() => service.join(input));
  }
  await put(catalogKeys.drop(f.dropId), f.drop);
  console.log(
    'PASS inactive Products, inactive associations and ineligible Drops rejected',
  );
  const before = await get(catalogKeys.inventory(f.dropId, f.productId));
  const results = await Promise.all(
    Array.from({ length: 8 }, () => service.join(input)),
  );
  assert(results.every((r) => r.message === results[0].message));
  let page = await service.list(scope);
  assert.equal(page.entries.length, 1);
  assert.equal(page.entries[0].email, 'synthetic@example.invalid');
  assert.deepEqual(
    await get(catalogKeys.inventory(f.dropId, f.productId)),
    before,
  );
  await assert.rejects(() => service.join({ ...input, email: 'bad' }));
  await assert.rejects(() => service.join({ ...input, consent: false }));
  await assert.rejects(() => service.review(scope));
  assert.equal(email.messages.length, 0);
  console.log(
    'PASS concurrent normalized signup, stable receipt, validation and inventory isolation',
  );
  for (let n = 0; n < 21; n++)
    await service.join({ ...input, email: `synthetic${n}@example.invalid` });
  page = await service.list(scope);
  assert.equal(page.entries.length, 20);
  assert(page.cursor);
  assert.equal((await service.list(scope, page.cursor)).entries.length, 2);
  await assert.rejects(() =>
    service.list({ ...scope, productId: f.otherProductId }, page.cursor),
  );
  console.log('PASS bounded signed pagination and scope isolation');
  await stock(5);
  await assert.rejects(() =>
    service.join({ ...input, email: 'new@example.invalid' }),
  );
  const review = await service.review(scope);
  let campaign = await service.campaign(scope, review.event, 'synthetic-admin');
  assert.equal(campaign.done, false);
  campaign = await service.campaign(scope, review.event, 'synthetic-admin');
  assert.equal(campaign.done, true);
  assert.equal(queue.messages.length, 22);
  await service.campaign(scope, review.event, 'synthetic-admin');
  assert.equal(queue.messages.length, 22);
  const first = queue.messages[0];
  await Promise.all([service.deliver(first), service.deliver(first)]);
  assert.equal(email.messages.length, 1);
  assert.match(email.messages[0].text, /first-come, first-served/);
  assert.match(email.messages[0].text, /not guaranteed/);
  assert.match(email.messages[0].text, /Cookie/);
  assert.match(email.messages[0].text, /Test Drop/);
  await service.deliver(first);
  assert.equal(email.messages.length, 1);
  console.log(
    'PASS explicit campaign, bounded continuation, duplicate event and concurrent delivery protection',
  );
  const token = email.messages[0].text.split('#').at(-1);
  await service.unsubscribe(token);
  await service.unsubscribe(token);
  await assert.rejects(() => service.unsubscribe(token + 'bad'));
  await stock(0);
  await service.join({ ...input, email: email.messages[0].to });
  await stock(7);
  const next = await service.review(scope);
  await service.campaign(scope, next.event, 'synthetic-admin');
  assert(!queue.messages.slice(22).some((m) => m.entryKey === first.entryKey));
  console.log('PASS signed opt-out, sticky suppression and campaign exclusion');
  const second = queue.messages[1];
  await stock(0);
  await service.deliver(second);
  assert.equal(email.messages.length, 1);
  await assert.rejects(() =>
    service.campaign(scope, next.event, 'synthetic-admin'),
  );
  console.log('PASS no dispatch or campaign while unavailable');
  await stock(9);
  const third = await service.review(scope);
  await service.campaign(scope, third.event, 'synthetic-admin');
  const candidates = queue.messages.filter((m) => m.event === third.event);
  const uncertain = new Waitlists(
    client,
    table,
    table,
    table,
    Buffer.alloc(32, 7),
    'https://synthetic.example',
    queue,
    {
      async send() {
        throw Error('Unknown acknowledgement');
      },
    },
    () => time,
  );
  await uncertain.deliver(candidates[0]);
  await service.deliver(candidates[0]);
  assert.equal(email.messages.length, 1);
  const failed = new Waitlists(
    client,
    table,
    table,
    table,
    Buffer.alloc(32, 7),
    'https://synthetic.example',
    queue,
    {
      async send() {
        throw new DeliveryFailure(false);
      },
    },
    () => time,
  );
  await failed.deliver(candidates[1]);
  const view = await service.list(scope);
  assert(view.entries.some((e) => e.notification === 'UNCERTAIN'));
  assert(view.entries.some((e) => e.notification === 'FAILED'));
  console.log(
    'PASS honest failed and uncertain outcomes without automatic resend',
  );
  for (let n = 0; n < 20; n++) await service.rateLimit('synthetic-ip');
  await assert.rejects(() => service.rateLimit('synthetic-ip'));
  console.log('PASS bounded public rate limiting');
  const orders = await client.send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: 'PK = :p',
      ExpressionAttributeValues: {
        ':p': `WAITLIST#${f.dropId}#${f.productId}`,
      },
    }),
  );
  assert.equal(orders.Items.length, 22);
  // Same contact remains independent across both Product and Drop scopes.
  await stock(0);
  await put(catalogKeys.product(f.otherProductId), {
    ...f.product,
    productId: f.otherProductId,
  });
  await put(catalogKeys.dropProduct(f.dropId, f.otherProductId), {
    ...f.relation,
    productId: f.otherProductId,
  });
  await put(catalogKeys.inventory(f.dropId, f.otherProductId), {
    ...f.inventory,
    productId: f.otherProductId,
    total: 0,
    reserved: 0,
    sold: 0,
  });
  await service.join({ ...input, productId: f.otherProductId });
  assert.equal(
    (await service.list({ ...scope, productId: f.otherProductId })).entries
      .length,
    1,
  );
  const otherDrop = '01K5J100000000000000000004';
  await put(catalogKeys.drop(otherDrop), { ...f.drop, dropId: otherDrop });
  await put(catalogKeys.dropProduct(otherDrop, f.productId), {
    ...f.relation,
    dropId: otherDrop,
  });
  await put(catalogKeys.inventory(otherDrop, f.productId), {
    ...f.inventory,
    dropId: otherDrop,
    total: 0,
    reserved: 0,
    sold: 0,
  });
  await put(catalogKeys.storefront, {
    storefrontDropId: otherDrop,
    updatedAt: f.timestamp,
  });
  await service.join({ ...input, dropId: otherDrop });
  assert.equal(
    (await service.list({ ...scope, dropId: otherDrop })).entries.length,
    1,
  );
  await put(catalogKeys.storefront, {
    storefrontDropId: f.dropId,
    updatedAt: f.timestamp,
  });
  console.log('PASS independent same-email Product and Drop membership');
  await stock(11);
  const retryEvent = await service.review(scope);
  let interrupted = true;
  const ambiguousQueue = {
    messages: [],
    async enqueue(m) {
      this.messages.push(m);
      if (interrupted) {
        interrupted = false;
        throw Error('Queue acknowledgement unknown');
      }
    },
  };
  const recovering = new Waitlists(
    client,
    table,
    table,
    table,
    Buffer.alloc(32, 7),
    'https://synthetic.example',
    ambiguousQueue,
    email,
    () => time,
  );
  await assert.rejects(() =>
    recovering.campaign(scope, retryEvent.event, 'synthetic-admin'),
  );
  await recovering.campaign(scope, retryEvent.event, 'synthetic-admin');
  const retries = ambiguousQueue.messages.filter(
    (m) => m.entryKey === ambiguousQueue.messages[0].entryKey,
  );
  assert.equal(retries.length, 2);
  const sentBefore = email.messages.length;
  for (const message of retries) await service.deliver(message);
  assert.equal(email.messages.length, sentBefore + 1);
  console.log(
    'PASS lost queue acknowledgement retries without skipped page or duplicate send',
  );
  const candidate = ambiguousQueue.messages.find(
    (m) => m.entryKey !== retries[0].entryKey,
  );
  let failFinish = true;
  const faultDb = {
    send: async (command) => {
      if (
        command.input.TransactItems?.some(
          (t) => t.Update?.ExpressionAttributeValues?.[':s'] === 'SENT',
        ) &&
        failFinish
      ) {
        failFinish = false;
        throw Error('Persistence acknowledgement unavailable');
      }
      return client.send(command);
    },
  };
  const faultService = new Waitlists(
    faultDb,
    table,
    table,
    table,
    Buffer.alloc(32, 7),
    'https://synthetic.example',
    queue,
    email,
    () => time,
  );
  await assert.rejects(() => faultService.deliver(candidate));
  const sentAfter = email.messages.length;
  await service.deliver(candidate);
  assert.equal(email.messages.length, sentAfter);
  assert(
    (await service.list(scope)).entries.some(
      (e) => e.notification === 'DISPATCHED_OUTCOME_UNKNOWN',
    ),
  );
  console.log(
    'PASS post-send persistence failure retains unknown claim and never resends',
  );
  const retryCandidate = ambiguousQueue.messages.find(
    (m) =>
      m.entryKey !== retries[0].entryKey && m.entryKey !== candidate.entryKey,
  );
  let conflictOnce = true;
  const conflictDb = {
    send: async (command) => {
      if (
        conflictOnce &&
        command.input.TransactItems?.some(
          (t) =>
            t.Update?.ExpressionAttributeValues?.[':claimed'] === 'DISPATCHED',
        )
      ) {
        conflictOnce = false;
        throw Object.assign(Error('Synthetic transaction conflict'), {
          name: 'TransactionCanceledException',
        });
      }
      return client.send(command);
    },
  };
  const conflicted = new Waitlists(
    conflictDb,
    table,
    table,
    table,
    Buffer.alloc(32, 7),
    'https://synthetic.example',
    queue,
    email,
    () => time,
  );
  await assert.rejects(() => conflicted.deliver(retryCandidate));
  const countBefore = email.messages.length;
  await service.deliver(retryCandidate);
  assert.equal(email.messages.length, countBefore + 1);
  console.log(
    'PASS transient dispatch conflict remains retryable without losing notification',
  );
  const delayedCandidate = ambiguousQueue.messages.find(
    (m) =>
      ![
        retries[0].entryKey,
        candidate.entryKey,
        retryCandidate.entryKey,
      ].includes(m.entryKey),
  );
  const delayedRow = await get({
    PK: `WAITLIST#${scope.dropId}#${scope.productId}`,
    SK: delayedCandidate.entryKey,
  });
  const delayed = new Waitlists(
    client,
    table,
    table,
    table,
    Buffer.alloc(32, 7),
    'https://synthetic.example',
    queue,
    {
      async send(message) {
        await email.send(message);
        await stock(15);
        const newer = await service.review(scope);
        await service.campaign(scope, newer.event, 'synthetic-admin');
      },
    },
    () => time,
  );
  await delayed.deliver(delayedCandidate);
  assert.equal(
    (
      await get({
        PK: `WAITLIST_DELIVERY#${delayedRow.id}`,
        SK: delayedCandidate.event,
      })
    ).status,
    'SENT',
  );
  const latest = await get({
    PK: `WAITLIST_HISTORY#${delayedRow.id}`,
    SK: 'LATEST',
  });
  assert.notEqual(latest.event, delayedCandidate.event);
  assert.equal(latest.status, 'PENDING');
  console.log(
    'PASS delayed delivery preserves newer campaign status and original outcome',
  );
  console.log(
    'PASS local acceptance uses only loopback DynamoDB and mock email; no managed AWS or provider calls',
  );
} finally {
  await x.close();
}
