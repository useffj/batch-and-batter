// Synthetic records for existing loopback-only acceptance infrastructure.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PutCommand } = require('@aws-sdk/lib-dynamodb');
const { orderKey, attemptKey } = require('../dist/src/payment-domain');
const {
  command,
  nextWorkflow,
  associationKey,
} = require('../dist/src/payment-execution-domain');
const { refundKey } = require('../dist/src/notification-contract');
const { cartKey, cartSchema } = require('../dist/src/cart-domain');
const {
  settlementIdentity,
  paidEventKey,
} = require('../dist/src/payment-settlement');
const { catalogKeys } = require('../dist/src/keys');
export async function seedRefundOrder(f, n, now) {
  const scope = 'dev:acct_SYNTHETIC';
  const put = (Item) =>
    f.client.send(new PutCommand({ TableName: f.table, Item }));
  const o = structuredClone(f.orders[n]);
  const intentId = 'pi_SYNTHETIC' + n,
    at = new Date(now).toISOString(),
    a = o.paymentAttemptId;
  const cart = cartSchema.parse({
    cartId: o.cartId,
    dropId: o.dropId,
    orderId: o.orderId,
    paymentAttemptId: a,
    status: 'CONVERTED',
    paymentGraceUsed: true,
    paymentStartedAt: at,
    paymentDeadline: new Date(now + 240000).toISOString(),
    createdAt: at,
    updatedAt: at,
    shoppingExpiresAt: new Date(now + 600000).toISOString(),
    managementTokenHash: 'c'.repeat(64),
    items: o.items.map((i) => ({
      productId: i.productId,
      quantity: i.quantity,
      priceCents: i.unitPriceCents,
      cookieUnits: i.cookieUnits,
    })),
  });
  const settlement = settlementIdentity(
    cart,
    {
      scope,
      intentId,
      parameters: { amountCents: o.totalCents, currency: o.currency },
    },
    'PAID',
  );
  await put({ ...cartKey(o.cartId), ...cart, settlement });
  await put({
    ...paidEventKey(o.orderId),
    schemaVersion: 1,
    eventType: 'PAID',
    orderId: o.orderId,
    cartId: o.cartId,
    paymentAttemptId: a,
    dropId: o.dropId,
    settlementId: settlement.id,
    createdAt: at,
  });
  o.status = 'PAID';
  o.paymentStatus = 'CAPTURED';
  o.settlement = settlement;
  const capture = {
    id: 'payment-capture:' + a,
    kind: 'CAPTURE',
    intentId,
    amountCents: o.totalCents,
    currency: 'usd',
    finalCapture: true,
    preparedAt: at,
    retryUntil: new Date(now + 23 * 3600000).toISOString(),
    state: 'OBSERVED',
    dispatchedAt: at,
    observedAt: at,
    outcome: 'SUCCEEDED',
  };
  const work = nextWorkflow(o.cartId, a, 1, 'FINALIZE_ORDER', now, at);
  await put({ ...orderKey(o.orderId), ...o });
  await put({
    ...attemptKey(a),
    paymentAttemptId: a,
    orderId: o.orderId,
    cartId: o.cartId,
    dropId: o.dropId,
    status: 'CAPTURED',
    amountCents: o.totalCents,
    currency: o.currency,
    createdAt: at,
    updatedAt: at,
    settlement,
    execution: {
      scope,
      confirmationTokenId: 'ctoken_SYNTHETIC',
      revision: 1,
      parameters: {
        amountCents: o.totalCents,
        currency: 'usd',
        captureMethod: 'manual',
        confirmationMethod: 'automatic',
        paymentMethodTypes: ['card'],
        metadata: {
          environment: 'dev',
          cartId: o.cartId,
          orderId: o.orderId,
          paymentAttemptId: a,
          dropId: o.dropId,
        },
      },
      create: command('CREATE', a, 0, now),
      confirmations: [],
      capture,
      captureEvidence: {
        scope,
        intentId,
        amountCents: o.totalCents,
        amountReceivedCents: o.totalCents,
        currency: 'usd',
        status: 'succeeded',
        verifiedAt: at,
        commandId: capture.id,
      },
      intentId,
      stage: 'FINALIZE_ORDER',
      workflow: { PK: work.PK, SK: work.SK, revision: 1 },
    },
  });
  await put({
    ...associationKey(scope, intentId),
    scope,
    intentId,
    cartId: o.cartId,
    orderId: o.orderId,
    paymentAttemptId: a,
    environment: 'dev',
    createdAt: at,
  });
  await put({
    ...refundKey(o.orderId),
    disposition: 'NONE',
    settlementId: settlement.id,
    updatedAt: at,
  });
  await put({
    ...catalogKeys.inventory(o.dropId, o.items[0].productId),
    dropId: o.dropId,
    productId: o.items[0].productId,
    total: 100,
    sold: 50,
    reserved: 5,
    updatedAt: at,
  });
  return o;
}
