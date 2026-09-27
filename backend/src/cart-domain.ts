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
export const cartSchema = z.strictObject({
  cartId: idSchema,
  dropId: idSchema,
  status: z.enum(['ACTIVE', 'CANCELLED', 'EXPIRED']),
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
export type Cart = z.infer<typeof cartSchema>;
export type DesiredItem = z.infer<typeof desiredItemsSchema>[number];
export const cartDtoSchema = cartSchema.omit({ managementTokenHash: true });
export type CartDto = z.infer<typeof cartDtoSchema>;
export function cartDto(c: Cart): CartDto {
  return {
    cartId: c.cartId,
    dropId: c.dropId,
    status: c.status,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    shoppingExpiresAt: c.shoppingExpiresAt,
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
