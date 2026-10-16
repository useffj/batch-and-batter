// Uses the established disposable, loopback-only Orders fixture. Writes are setup only.
import { createRequire } from 'node:module';
import { fixtures } from './orders-local-fixtures.mjs';
const require = createRequire(import.meta.url);
const { PutCommand } = require('@aws-sdk/lib-dynamodb');
const { refundOperationKey, ledgerKey } = require('../dist/src/refund-domain');
const { orderKey } = require('../dist/src/payment-domain');
export const clock = Date.parse('2026-10-22T18:00:00.000Z');
export const opId = (n) =>
  '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
export async function worklistFixtures() {
  const f = await fixtures();
  const order = f.orders[1];
  // Reuse the valid settlement shape from the existing refund fixture, preserving Orders indexes.
  const { seedRefundOrder } = await import('./refund-local-fixtures.mjs');
  const seeded = await seedRefundOrder(f, 1, clock);
  Object.assign(order, seeded);
  const put = (Item) =>
    f.client.send(new PutCommand({ TableName: f.table, Item }));
  await put({ ...orderKey(order.orderId), ...order });
  const ledger = {
    orderId: order.orderId,
    settlementId: seeded.settlement.id,
    capturedCents: order.totalCents,
    refundedCents: 100,
    reservedCents: 0,
    revision: 1,
    active: null,
    blocked: true,
    returned: {},
    updatedAt: order.updatedAt,
  };
  await put({ ...ledgerKey(order.orderId), ...ledger });
  const states = [
    'AUTHORIZED',
    'DISPATCHED',
    'PENDING',
    'SUCCEEDED',
    'FAILED',
    'CANCELED',
    'RECONCILIATION_REQUIRED',
  ];
  for (let i = 0; i < 37; i++) {
    const operation = {
      operationId: opId(i),
      orderId: order.orderId,
      amountCents: 10,
      reason: 'Synthetic recorded evidence',
      disposition: 'DO_NOT_RESTOCK',
      physicallyAvailable: false,
      items: [],
      administrator: 'synthetic',
      fingerprint: 'b'.repeat(64),
      intentId: 'pi_SYNTHETIC1',
      accountId: 'acct_SYNTHETIC',
      scope: 'dev:acct_SYNTHETIC',
      environment: 'dev',
      currency: 'usd',
      capturedCents: order.totalCents,
      previousRefundedCents: 0,
      settlementId: seeded.settlement.id,
      idempotencyKey: 'refund:' + order.orderId + ':' + opId(i),
      status: states[i % 7],
      revision: 0,
      checks: 2,
      providerId: i % 2 ? 're_SYNTHETIC' + i : undefined,
      createdAt: new Date(
        clock - (i === 2 ? 60000 : 48 * 3600000),
      ).toISOString(),
      updatedAt: new Date(clock - 1000).toISOString(),
      nextCheckAt: new Date(clock + 60000).toISOString(),
    };
    if (operation.providerId === undefined) delete operation.providerId;
    await put({ ...refundOperationKey(order.orderId, opId(i)), ...operation });
  }
  for (let i = 0; i < 31; i++)
    await put({
      PK: 'REFUND_AUDIT#' + order.orderId,
      SK: opId(0) + '#' + String(i).padStart(12, '0'),
      operationId: opId(0),
      status: 'AUTHORIZED',
      at: new Date(clock - 100000 + i).toISOString(),
    });
  return { ...f, order, ledger, put };
}
