// Pure financial discovery used by the bounded reconciler; no provider initialization.
import { z } from 'zod';
import {
  paymentWorkSchema,
  workflowWorkSchema,
  paymentWorkKey,
} from './payment-domain';
import { workflowSchema, paymentMessage } from './payment-execution-domain';
import { inboxSchema, eventWorkKey } from './stripe-inbox-domain';
import { expiryShard } from './cart-expiry';
export function financialWorkMessage(row: Record<string, unknown>) {
  const { PK, SK, ...data } = row;
  const p = z
    .union([paymentWorkSchema, workflowWorkSchema, workflowSchema, inboxSchema])
    .safeParse(data);
  if (!p.success) return;
  const w = p.data;
  const key =
    w.deadlineType === 'STRIPE_EVENT'
      ? eventWorkKey(w.eventId, w.deadline)
      : w.deadlineType === 'PAYMENT' || w.schemaVersion === 2
        ? paymentWorkKey(w)
        : {
            PK: `CART_EXPIRY#V1#${expiryShard(w.cartId)}`,
            SK: `${w.deadline}#PAYMENT_WORKFLOW#${w.cartId}#${w.paymentAttemptId}`,
          };
  if (key.PK !== PK || key.SK !== SK) return;
  return paymentMessage(
    { ...key, revision: 'revision' in w ? w.revision : 0 },
    w.deadlineType === 'PAYMENT'
      ? 'PAYMENT'
      : w.deadlineType === 'STRIPE_EVENT'
        ? 'STRIPE_EVENT'
        : 'WORKFLOW',
  );
}
