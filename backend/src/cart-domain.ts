import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { idSchema } from './domain';

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const desiredItemsSchema = z
  .array(z.strictObject({ productId: idSchema, quantity: positive }))
  .min(1)
  .max(12)
  .refine(
    (items) => new Set(items.map((i) => i.productId)).size === items.length,
  );
export const createCartSchema = z.strictObject({
  dropId: idSchema,
  items: desiredItemsSchema,
});
export const replaceCartSchema = z.strictObject({ items: desiredItemsSchema });
const lineSchema = z.strictObject({
  productId: idSchema,
  quantity: positive,
  priceCents: positive,
  cookieUnits: positive,
});
const cartRecord = z.strictObject({
  cartId: idSchema,
  dropId: idSchema,
  status: z.enum([
    'ACTIVE',
    'PAYMENT_PENDING',
    'PAYMENT_COMMITTING',
    'CONVERTED',
    'CANCELLED',
    'EXPIRED',
  ]),
  settlement: z
    .strictObject({
      id: z.string().regex(/^[a-f0-9]{64}$/),
      lineDigest: z.string().regex(/^[a-f0-9]{64}$/),
      outcome: z.enum(['PAID', 'EXPIRED', 'FAILED', 'CANCELLED']),
      intentId: z.string().optional(),
      amountCents: positive,
    })
    .optional(),
  paymentGraceUsed: z.literal(true).optional(),
  paymentStartedAt: z.iso.datetime().optional(),
  paymentDeadline: z.iso.datetime().optional(),
  paymentAttemptId: idSchema.optional(),
  orderId: idSchema.optional(),
  committingStartedAt: z.iso.datetime().optional(),
  committingDeadline: z.iso.datetime().optional(),
  recoveryRequired: z.literal(true).optional(),
  recoveryReason: z.literal('UNKNOWN_FINANCIAL_OUTCOME').optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  shoppingExpiresAt: z.iso.datetime(),
  managementTokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  items: z
    .array(lineSchema)
    .min(1)
    .max(12)
    .refine(
      (items) => new Set(items.map((i) => i.productId)).size === items.length,
    ),
});
function validPaymentState(c: z.infer<typeof cartRecord>): boolean {
  const fields = [
    c.paymentGraceUsed,
    c.paymentStartedAt,
    c.paymentDeadline,
    c.paymentAttemptId,
    c.orderId,
  ];
  const any = fields.some((v) => v !== undefined);
  const all = fields.every((v) => v !== undefined);
  if (any && !all) return false;
  if (c.status === 'ACTIVE' && any) return false;
  if (
    ['PAYMENT_PENDING', 'PAYMENT_COMMITTING', 'CONVERTED'].includes(c.status) &&
    !all
  )
    return false;
  if (
    all &&
    (Date.parse(c.paymentDeadline!) !==
      Date.parse(c.paymentStartedAt!) + 240000 ||
      Date.parse(c.paymentStartedAt!) >= Date.parse(c.shoppingExpiresAt))
  )
    return false;
  const committing =
    c.committingStartedAt !== undefined || c.committingDeadline !== undefined;
  if (c.status === 'PAYMENT_COMMITTING' && !committing) return false;
  if (
    committing &&
    (!all ||
      c.status === 'PAYMENT_PENDING' ||
      c.status === 'ACTIVE' ||
      !c.committingStartedAt ||
      !c.committingDeadline ||
      Date.parse(c.committingDeadline) !==
        Date.parse(c.committingStartedAt) + 120000 ||
      Date.parse(c.committingStartedAt) < Date.parse(c.paymentStartedAt!) ||
      Date.parse(c.committingStartedAt) > Date.parse(c.paymentDeadline!))
  )
    return false;
  if (
    (c.recoveryRequired !== undefined || c.recoveryReason !== undefined) &&
    (c.status !== 'PAYMENT_COMMITTING' ||
      !c.recoveryRequired ||
      !c.recoveryReason)
  )
    return false;
  return true;
}
export const cartSchema = cartRecord.refine(
  validPaymentState,
  'Invalid payment ownership state',
);
export type Cart = z.infer<typeof cartSchema>;
export const ownsReserved = (status: Cart['status']) =>
  ['ACTIVE', 'PAYMENT_PENDING', 'PAYMENT_COMMITTING'].includes(status);
export const shoppingExpired = (cart: Cart, now: number) =>
  cart.status === 'EXPIRED' ||
  (cart.status === 'ACTIVE' && now >= Date.parse(cart.shoppingExpiresAt));
export type DesiredItem = z.infer<typeof desiredItemsSchema>[number];
export const cartDtoSchema = cartRecord.omit({
  managementTokenHash: true,
  settlement: true,
  recoveryRequired: true,
  recoveryReason: true,
});
export type CartDto = z.infer<typeof cartDtoSchema>;
export function cartDto(c: Cart): CartDto {
  return {
    cartId: c.cartId,
    dropId: c.dropId,
    status: c.status,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    shoppingExpiresAt: c.shoppingExpiresAt,
    ...(c.paymentGraceUsed
      ? {
          paymentGraceUsed: c.paymentGraceUsed,
          paymentStartedAt: c.paymentStartedAt!,
          paymentDeadline: c.paymentDeadline!,
          paymentAttemptId: c.paymentAttemptId!,
          orderId: c.orderId!,
        }
      : {}),
    ...(c.committingStartedAt
      ? {
          committingStartedAt: c.committingStartedAt,
          committingDeadline: c.committingDeadline!,
        }
      : {}),
    items: c.items.map((i) => ({
      productId: i.productId,
      quantity: i.quantity,
      priceCents: i.priceCents,
      cookieUnits: i.cookieUnits,
    })),
  };
}
const errors = {
  VALIDATION_ERROR: [400, 'Invalid request data.'],
  UNAUTHORIZED: [401, 'Cart credentials are invalid.'],
  RESERVATION_EXPIRED: [410, 'Your cookie reservation has expired.'],
  PAYMENT_ALREADY_STARTED: [409, 'Payment has already started for this cart.'],
  INVALID_PICKUP_DATE: [400, 'Selected pickup date is not available.'],
  CART_CONFLICT: [
    409,
    'Cart changed or is no longer editable. Reload before retrying.',
  ],
  IDEMPOTENCY_CONFLICT: [
    409,
    'Idempotency key was already used for a different request.',
  ],
  IDEMPOTENCY_KEY_EXPIRED: [
    409,
    'Idempotency key is outside its validity window.',
  ],
  DROP_NOT_OPEN: [409, 'Drop is not open for reservations.'],
  STOREFRONT_CONFLICT: [409, 'Drop is not assigned to the storefront.'],
  PRODUCT_NOT_AVAILABLE: [409, 'A requested product is not available.'],
  INSUFFICIENT_INVENTORY: [
    409,
    'Insufficient inventory for the requested quantity.',
  ],
  QUANTITY_LIMIT_EXCEEDED: [
    409,
    'Cart exceeds the Drop cookie quantity limit.',
  ],
  CART_BUSY: [
    503,
    'Cart could not be confirmed. Retry with the same idempotency key.',
  ],
  QUOTE_STALE: [
    409,
    'Checkout pricing changed. Reload and review before paying.',
  ],
  PAYMENTS_DISABLED: [503, 'New payments are disabled.'],
  PAYMENT_UNAVAILABLE: [503, 'Payment service is temporarily unavailable.'],
  INTERNAL_ERROR: [500, 'Unable to complete the cart request.'],
} as const;
export type CartCode = keyof typeof errors;
export class CartError extends Error {
  readonly status: number;
  constructor(public readonly code: CartCode) {
    super(errors[code][1]);
    this.status = errors[code][0];
  }
}
export const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export function secretHash(raw: unknown): string {
  if (
    typeof raw !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(raw) ||
    Buffer.from(raw, 'base64url').length !== 32 ||
    Buffer.from(raw, 'base64url').toString('base64url') !== raw
  )
    throw new CartError('UNAUTHORIZED');
  return hash(`batch-and-batter:cart-capability:v1:${raw}`);
}
export function sameCapability(a: string, b: string): boolean {
  const valid = /^[a-f0-9]{64}$/;
  return (
    valid.test(a) &&
    valid.test(b) &&
    timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  );
}
export function parseKey(raw: unknown): { raw: string; issuedAt: number } {
  if (typeof raw !== 'string') throw new CartError('VALIDATION_ERROR');
  const match = /^v1\.(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(raw);
  if (
    !match ||
    Buffer.from(match[2], 'base64url').toString('base64url') !== match[2]
  )
    throw new CartError('VALIDATION_ERROR');
  return { raw, issuedAt: Number(match[1]) };
}
export function freshKey(issuedAt: number, now: number) {
  if (now - issuedAt >= 86400000 || issuedAt - now > 300000)
    throw new CartError('IDEMPOTENCY_KEY_EXPIRED');
}
export const etag = (revision: string) =>
  `"${hash(`cart-revision:v1:${revision}`)}"`;
export function checkedTotal(
  items: Cart['items'],
  field: 'cookieUnits' | 'priceCents',
): number {
  let total = 0;
  for (const item of items) {
    const value = item.quantity * item[field];
    if (!Number.isSafeInteger(value) || !Number.isSafeInteger(total + value))
      throw new CartError('VALIDATION_ERROR');
    total += value;
  }
  return total;
}
export interface CartResult {
  status: number;
  cart: CartDto;
  expired?: boolean;
}
export interface CartRequest {
  operation: 'create' | 'replace' | 'release';
  tokenHash: string;
  key: string;
  cartId?: string;
  dropId?: string;
  items?: DesiredItem[];
  ifMatch?: string;
}
export interface CartMetrics {
  attempts: number;
}
export const cartKey = (id: string) => ({
  PK: `CART#${idSchema.parse(id)}`,
  SK: 'META',
});
export const receiptSchema = z.strictObject({
  operation: z.enum(['create', 'replace', 'release']),
  scope: z.string(),
  version: z.literal(1),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  managementTokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  cartId: idSchema,
  response: z.strictObject({
    status: z.union([z.literal(200), z.literal(201)]),
    cart: cartDtoSchema,
  }),
  createdAt: z.iso.datetime(),
  retainUntil: z.number().int().positive(),
});
