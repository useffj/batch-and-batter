import { z } from 'zod';
import { hash } from './cart-domain';
import { canonicalTime } from './cart-expiry';
import { intentId } from './payment-execution-domain';
export const webhookTypes = [
  'payment_intent.created',
  'payment_intent.amount_capturable_updated',
  'payment_intent.processing',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
] as const;
const eventId = z
  .string()
  .regex(/^evt_[a-zA-Z0-9]+$/)
  .max(255);
export const eventReceiptSchema = z.strictObject({
  eventId,
  scope: z.string(),
  intentId,
  eventType: z.enum(webhookTypes),
  state: z.enum(['RECEIVED', 'PROCESSED']),
  createdAt: canonicalTime,
  revision: z.number().int().nonnegative(),
  work: z.strictObject({
    PK: z.string(),
    SK: z.string(),
    revision: z.number().int().nonnegative(),
  }),
});
export const inboxSchema = z.strictObject({
  schemaVersion: z.literal(3),
  deadlineType: z.literal('STRIPE_EVENT'),
  eventId,
  deadline: canonicalTime,
  createdAt: canonicalTime,
  revision: z.number().int().nonnegative(),
});
export const receiptKey = (id: string) => ({
  PK: `EXTERNAL_EVENT#STRIPE#${eventId.parse(id)}`,
  SK: 'META',
});
export const eventWorkKey = (id: string, at: string) => ({
  PK: `CART_EXPIRY#V1#${(parseInt(hash(eventId.parse(id)).slice(0, 2), 16) & 15).toString(16).toUpperCase().padStart(2, '0')}`,
  SK: `${canonicalTime.parse(at)}#STRIPE_EVENT#${id}`,
});
