import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  worklistFixtures,
  clock,
  opId,
} from './refund-worklist-local-fixtures.mjs';
const require = createRequire(import.meta.url);
const { RefundWorklist } = require('../dist/src/refund-worklist');
const { ledgerKey } = require('../dist/src/refund-domain');
const f = await worklistFixtures();
let calls = [],
  hook = null;
const client = {
  send: async (c) => {
    assert(
      ['GetCommand', 'QueryCommand'].includes(c.constructor.name),
      'ZERO WRITE COMMANDS',
    );
    calls.push(c);
    if (hook) await hook(c);
    return f.client.send(c);
  },
};
const repository = new RefundWorklist(client, f.table, f.table, () => clock);
try {
  async function pages(filters) {
    let cursor,
      rows = [],
      seen = new Set(),
      empty = 0;
    do {
      calls = [];
      const r = await repository.list({
        ...filters,
        ...(cursor ? { cursor } : {}),
      });
      assert(calls.length <= 8);
      assert(Buffer.byteLength(JSON.stringify(r)) <= 128 * 1024);
      rows.push(...r.rows);
      if (!r.rows.length && r.nextCursor) empty++;
      cursor = r.nextCursor;
      if (cursor) {
        assert(!seen.has(cursor));
        seen.add(cursor);
      }
      assert(seen.size < 100);
    } while (cursor);
    return { rows, empty };
  }
  const all = await pages({
    dropId: f.drops[0].dropId,
    attentionOnly: 'false',
  });
  assert.equal(all.rows.filter((x) => x.operation).length, 37);
  assert.equal(
    new Set(
      all.rows.filter((x) => x.operation).map((x) => x.operation.operationId),
    ).size,
    37,
  );
  assert(all.empty > 0);
  assert.equal(
    new Set(all.rows.filter((x) => x.operation).map((x) => x.operation.status))
      .size,
    7,
  );
  console.log(
    'PASS Drop traversal, all seven statuses, >25 operations, multiple refunds, empty pages, bounded work and no loops',
  );
  const date = await pages({
    pickupDate: f.order.pickup.date,
    attentionOnly: 'false',
  });
  assert.equal(date.rows.filter((x) => x.operation).length, 37);
  console.log('PASS pickup-date discovery');
  const emptyFiltered = await repository.list({
    reference: f.order.displayOrderNumber,
    status: 'SUCCEEDED',
    attentionOnly: 'true',
  });
  const emptyOperations = await repository.list({
    reference: f.order.displayOrderNumber,
    status: 'SUCCEEDED',
    attentionOnly: 'true',
    cursor: emptyFiltered.nextCursor,
  });
  assert.equal(emptyOperations.rows.length, 0);
  assert(emptyOperations.nextCursor);
  const continuedEmpty = await repository.list({
    reference: f.order.displayOrderNumber,
    status: 'SUCCEEDED',
    attentionOnly: 'true',
    cursor: emptyOperations.nextCursor,
  });
  assert.notEqual(continuedEmpty.nextCursor, emptyOperations.nextCursor);
  console.log(
    'PASS zero-match operation pages preserve and advance continuation',
  );

  const exact = await pages({
    reference: f.order.displayOrderNumber,
    attentionOnly: 'true',
  });
  assert(
    exact.rows.some(
      (x) =>
        x.attentionReason === 'Blocked refund ledger' && x.reservedCents === 0,
    ),
  );
  assert(exact.rows.some((x) => x.attentionReason === 'Failed refund'));
  assert(
    exact.rows.some((x) => x.attentionReason === 'Reconciliation required'),
  );
  assert(!exact.rows.some((x) => x.operation?.operationId === opId(2)));
  assert(
    exact.rows.some((x) => x.attentionReason === 'Long-running pending refund'),
  );
  assert(
    exact.rows.every(
      (x) =>
        x.operation?.status !== 'SUCCEEDED' &&
        x.operation?.status !== 'CANCELED',
    ),
  );
  console.log(
    'PASS exact reference, zero-reserved blocked ledger, failed/reconciliation/aging and normal pending separation',
  );
  const success = await pages({
    reference: f.order.displayOrderNumber,
    attentionOnly: 'false',
    status: 'SUCCEEDED',
  });
  assert(
    success.rows
      .filter((x) => x.operation)
      .every((x) => x.operation.status === 'SUCCEEDED'),
  );
  const first = await repository.list({
    reference: f.order.displayOrderNumber,
    attentionOnly: 'false',
  });
  for (const q of [
    {
      reference: f.order.displayOrderNumber,
      status: 'FAILED',
      attentionOnly: 'false',
      cursor: first.nextCursor,
    },
    { dropId: f.drops[0].dropId, cursor: first.nextCursor },
    { reference: f.order.displayOrderNumber, cursor: 'garbage' },
    { reference: f.order.displayOrderNumber, dropId: f.drops[0].dropId },
  ])
    await assert.rejects(() => repository.list(q));
  console.log(
    'PASS filter/scope-bound cursors and malformed continuation rejection',
  );
  let cursor,
    count = 0;
  do {
    const d = await repository.detail(f.order.orderId, opId(0), cursor);
    count += d.audit.length;
    assert.equal(d.order.originalTotalCents, f.order.totalCents);
    assert.equal(d.order.capturedCents, f.order.totalCents);
    assert.equal(d.order.refundedCents, 100);
    assert.equal(d.order.availableCents, f.order.totalCents - 100);
    assert.equal(d.operation.providerId, null);
    cursor = d.nextCursor;
  } while (cursor);
  assert.equal(count, 31);
  const d = await repository.detail(f.order.orderId, opId(1));
  assert.equal(d.operation.providerId, 're_SYNTHETIC1');
  assert.equal(d.operation.checks, 2);
  const a = await repository.detail(f.order.orderId, opId(0));
  await assert.rejects(() =>
    repository.detail(f.order.orderId, opId(1), a.nextCursor),
  );
  console.log(
    'PASS >25 audit transitions, recorded provider evidence, exact totals and bound audit cursors',
  );
  const legacy = { ...f.order };
  delete legacy.displayOrderNumber;
  await f.put({ ...legacy, PK: 'ORDER#' + legacy.orderId, SK: 'META' });
  const missing = await pages({
    dropId: f.drops[0].dropId,
    attentionOnly: 'false',
  });
  assert(missing.rows.some((x) => x.reference === null));
  await assert.rejects(() =>
    repository.list({ reference: f.order.displayOrderNumber }),
  );
  await f.put({ ...f.order, PK: 'ORDER#' + f.order.orderId, SK: 'META' });
  console.log(
    'PASS missing historical reference disclosed; contradictory exact lookup fails closed',
  );
  let hits = 0;
  hook = async (c) => {
    if (
      c.constructor.name === 'QueryCommand' &&
      c.input.TableName === f.table &&
      !c.input.IndexName
    ) {
      hits++;
      if (hits === 1)
        await f.put({
          ...ledgerKey(f.order.orderId),
          ...f.ledger,
          revision: 2,
          refundedCents: 110,
        });
    }
  };
  await assert.rejects(() =>
    repository.list({
      reference: f.order.displayOrderNumber,
      attentionOnly: 'false',
    }),
  );
  hook = null;
  console.log('PASS concurrent completion changes fail closed');
  // Fault injection occurs outside repository; all repository commands are read-only.
  assert(
    calls.every((c) =>
      ['GetCommand', 'QueryCommand'].includes(c.constructor.name),
    ),
  );
  console.log(
    'PASS ZERO repository writes and ZERO providers installed or called',
  );
} finally {
  await f.close();
}
