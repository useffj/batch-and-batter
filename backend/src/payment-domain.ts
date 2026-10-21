import { orderReferencePattern, orderIndexKeys } from './order-reference';
import { z } from 'zod';
import {
  confirmationTokenId,
  executionSchema,
  settlementSchema,
} from './payment-execution-domain';
import {
  cartSchema,
  CartError,
  checkedTotal,
  type Cart,
  cartDto,
} from './cart-domain';
import { idSchema, dateSchema, pickupSchema } from './domain';
import { canonicalTime, expiryShard } from './cart-expiry';

const cents = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const paymentAttemptStatus = z.enum([
  'CREATED',
  'AUTHENTICATING',
  'AUTHORIZED',
  'CAPTURE_IN_PROGRESS',
  'CAPTURED',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
]);
export const customerSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  email: z.email().max(254),
  phone: z.string().regex(/^\+[1-9]\d{7,14}$/),
  smsTransactionalConsent: z.boolean(),
});
export const startPaymentSchema = z.strictObject({
  confirmationTokenId,
  pickupDate: dateSchema,
  customer: customerSchema,
  // Optional only to read/replay historical receipts; new starts require it.
  quoteId: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type CheckoutInput = z.infer<typeof startPaymentSchema>;
export const paymentAttemptSchema = z.strictObject({
  execution: executionSchema.optional(),
  settlement: settlementSchema.optional(),
  paymentAttemptId: idSchema,
  cartId: idSchema,
  orderId: idSchema,
  dropId: idSchema,
  status: paymentAttemptStatus,
  amountCents: cents.positive(),
  currency: z.string().regex(/^[a-z]{3}$/),
  createdAt: canonicalTime,
  updatedAt: canonicalTime,
});
export const orderSchema = z
  .strictObject({
    displayOrderNumber: z.string().regex(orderReferencePattern).optional(),
    GSI1PK: z.string().optional(),
    GSI1SK: z.string().optional(),
    GSI2PK: z.string().optional(),
    GSI2SK: z.string().optional(),
    orderId: idSchema,
    cartId: idSchema,
    dropId: idSchema,
    status: z.enum([
      'PAYMENT_PENDING',
      'PAID',
      'EXPIRED',
      'FAILED',
      'CANCELLED',
    ]),
    settlement: settlementSchema.optional(),
    paymentStatus: z.enum([
      'CREATED',
      'CAPTURED',
      'EXPIRED',
      'FAILED',
      'CANCELLED',
    ]),
    paymentAttemptId: idSchema,
    items: z
      .array(
        z.strictObject({
          productId: idSchema,
          name: z.string().min(1).max(200),
          quantity: cents.positive(),
          unitPriceCents: cents.positive(),
          cookieUnits: cents.positive(),
        }),
      )
      .min(1)
      .max(12)
      .refine(
        (items) => new Set(items.map((i) => i.productId)).size === items.length,
      ),
    subtotalCents: cents.positive(),
    taxCents: cents,
    feeCents: cents,
    totalCents: cents.positive(),
    currency: z.string().regex(/^[a-z]{3}$/),
    customer: customerSchema,
    pickup: pickupSchema.safeExtend({
      location: z.string().min(1).max(2000),
      instructions: z.string().max(4000),
    }),
    createdAt: canonicalTime,
    updatedAt: canonicalTime,
  })
  .refine(
    (o) =>
      Number.isSafeInteger(o.subtotalCents + o.taxCents + o.feeCents) &&
      o.totalCents === o.subtotalCents + o.taxCents + o.feeCents &&
      o.subtotalCents ===
        o.items.reduce((n, i) => n + i.quantity * i.unitPriceCents, 0),
    'Invalid frozen totals',
  )
  .refine((o) => {
    const keys = orderIndexKeys(o);
    const values = Object.entries(keys);
    return (
      values.every(([k]) => o[k as keyof typeof keys] === undefined) ||
      values.every(([k, v]) => o[k as keyof typeof keys] === v)
    );
  }, 'Invalid order index keys');
export const attemptKey = (id: string) => ({
  PK: `PAYMENT_ATTEMPT#${idSchema.parse(id)}`,
  SK: 'META',
});
export const orderKey = (id: string) => ({
  PK: `ORDER#${idSchema.parse(id)}`,
  SK: 'META',
});

// Explicit local fixture only. No production default, configuration or provider is installed.
export interface PaymentPricing {
  readonly fixture: 'DEVELOPMENT_ONLY_ZERO_TAX_ZERO_FEE';
  readonly currency: string;
  readonly version?: string;
}

export function paymentAmount(cart: Cart, pricing: PaymentPricing) {
  if (
    pricing.fixture !== 'DEVELOPMENT_ONLY_ZERO_TAX_ZERO_FEE' ||
    !/^[a-z]{3}$/.test(pricing.currency)
  )
    throw new CartError('INTERNAL_ERROR');
  return {
    subtotalCents: checkedTotal(cart.items, 'priceCents'),
    taxCents: 0,
    feeCents: 0,
    totalCents: checkedTotal(cart.items, 'priceCents'),
    currency: pricing.currency,
  };
}
export const paymentWorkSchema = z.strictObject({
  schemaVersion: z.literal(2),
  cartId: idSchema,
  paymentAttemptId: idSchema,
  deadlineType: z.literal('PAYMENT'),
  deadline: canonicalTime,
  createdAt: canonicalTime,
});
export const workflowWorkSchema = z.strictObject({
  schemaVersion: z.literal(2),
  cartId: idSchema,
  paymentAttemptId: idSchema,
  deadlineType: z.literal('PAYMENT_WORKFLOW'),
  deadline: canonicalTime,
  createdAt: canonicalTime,
  step: z.literal('CREATE_INTENT'),
});
export type PaymentWork =
  z.infer<typeof paymentWorkSchema> | z.infer<typeof workflowWorkSchema>;
export function paymentWorkKey(work: PaymentWork) {
  return {
    PK: `CART_EXPIRY#V1#${expiryShard(work.cartId)}`,
    SK: `${work.deadline}#${work.deadlineType}#${work.cartId}${work.deadlineType === 'PAYMENT_WORKFLOW' ? `#${work.paymentAttemptId}` : ''}`,
  };
}
export function paymentWork(cart: Cart) {
  const shared = {
    schemaVersion: 2 as const,
    cartId: cart.cartId,
    paymentAttemptId: cart.paymentAttemptId!,
    createdAt: cart.paymentStartedAt!,
  };
  const deadline = paymentWorkSchema.parse({
    ...shared,
    deadlineType: 'PAYMENT',
    deadline: cart.paymentDeadline,
  });
  const workflow = workflowWorkSchema.parse({
    ...shared,
    deadlineType: 'PAYMENT_WORKFLOW',
    deadline: cart.paymentStartedAt,
    step: 'CREATE_INTENT',
  });
  return {
    deadline: { ...deadline, ...paymentWorkKey(deadline) },
    workflow: { ...workflow, ...paymentWorkKey(workflow) },
  };
}
// Pure policy model, not a persisted transition or authority to invent provider results.
export function modelCommitting(cart: Cart, qualifyingStartedAt: string): Cart {
  if (cart.status === 'PAYMENT_COMMITTING') return cartSchema.parse(cart);
  if (cart.status !== 'PAYMENT_PENDING') throw new CartError('CART_CONFLICT');
  const start = Date.parse(canonicalTime.parse(qualifyingStartedAt));
  if (
    start < Date.parse(cart.paymentStartedAt!) ||
    start > Date.parse(cart.paymentDeadline!)
  )
    throw new CartError('CART_CONFLICT');
  return cartSchema.parse({
    ...cart,
    status: 'PAYMENT_COMMITTING',
    updatedAt: new Date(
      Math.max(start, Date.parse(cart.updatedAt) + 1),
    ).toISOString(),
    committingStartedAt: qualifyingStartedAt,
    committingDeadline: new Date(start + 120000).toISOString(),
  });
}
export function modelUnknownHardStop(cart: Cart, now: number) {
  if (
    cart.status !== 'PAYMENT_COMMITTING' ||
    now < Date.parse(cart.committingDeadline!)
  )
    throw new CartError('CART_CONFLICT');
  return {
    cart: cartSchema.parse({
      ...cart,
      updatedAt: cart.recoveryRequired
        ? cart.updatedAt
        : new Date(Math.max(now, Date.parse(cart.updatedAt) + 1)).toISOString(),
      recoveryRequired: true,
      recoveryReason: 'UNKNOWN_FINANCIAL_OUTCOME',
    }),
    retainWork: true as const,
    releaseInventory: false as const,
    sellInventory: false as const,
    allowFinancialCommands: false as const,
    reconcile: true as const,
  };
}
export const paymentRead = (cart: Cart, now: number) => ({
  cart: cartDto(cart),
  payment: cart.paymentGraceUsed
    ? {
        paymentAttemptId: cart.paymentAttemptId!,
        orderId: cart.orderId!,
        paymentDeadline: cart.paymentDeadline!,
        customerWindowClosed: now >= Date.parse(cart.paymentDeadline!),
        ...(cart.committingDeadline
          ? { committingDeadline: cart.committingDeadline }
          : {}),
      }
    : null,
});

export const paymentWakeupSchema = z.strictObject({
  schemaVersion: z.literal(2),
  source: z.literal('batch-and-batter.cart-expiry'),
  operation: z.literal('processPayment'),
  cartId: idSchema,
  paymentAttemptId: idSchema,
  deadlineType: z.enum(['PAYMENT', 'PAYMENT_WORKFLOW']),
  deadline: canonicalTime,
});
