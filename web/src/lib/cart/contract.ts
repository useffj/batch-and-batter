// Explicit public projection. Never import backend/runtime credentials here.
export const ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
export const ETAG = /^"[a-f0-9]{64}"$/;
export interface Item {
  productId: string;
  quantity: number;
}
export interface Cart {
  cartId: string;
  dropId: string;
  status:
    | 'ACTIVE'
    | 'CANCELLED'
    | 'EXPIRED'
    | 'PAYMENT_PENDING'
    | 'PAYMENT_COMMITTING'
    | 'CONVERTED';
  createdAt: string;
  updatedAt: string;
  shoppingExpiresAt: string;
  items: (Item & { priceCents: number; cookieUnits: number })[];
}
export type Operation =
  | { kind: 'create'; dropId: string; items: Item[] }
  | { kind: 'replace'; cartId: string; ifMatch: string; items: Item[] }
  | { kind: 'release'; cartId: string };
export interface Snapshot {
  cart: Cart | null;
  expired: boolean;
  pending: boolean;
  etag: string | null;
  serverNow: number;
}
export const messages = {
  VALIDATION_ERROR:
    'We could not accept that change. Refresh your Cart and try again.',
  UNAUTHORIZED:
    'This Cart is no longer accessible. Return to the latest cookies.',
  RESERVATION_EXPIRED:
    'Your reservation time has expired. Checking release status.',
  CART_CONFLICT:
    'Your Cart changed in another tab or is no longer editable. Review the latest Cart before trying again.',
  IDEMPOTENCY_CONFLICT:
    'This change could not be matched safely. Refresh your Cart.',
  IDEMPOTENCY_KEY_EXPIRED:
    'This saved change is too old to submit. Refresh your Cart.',
  DROP_NOT_OPEN:
    'This Drop is not accepting new reservations. Refresh availability.',
  STOREFRONT_CONFLICT: 'The current Drop has changed. Refresh availability.',
  PRODUCT_NOT_AVAILABLE:
    'One of these cookies is no longer available. Refresh availability.',
  INSUFFICIENT_INVENTORY:
    'There are not enough cookies for that change. Refresh availability.',
  QUANTITY_LIMIT_EXCEEDED: 'That change exceeds this Drop’s cookie-unit limit.',
  CART_BUSY: 'We could not confirm your change yet. Retry the saved change.',
  INTERNAL_ERROR: 'We could not confirm your change. Retry the saved change.',
} as const;
export type CartCode = keyof typeof messages;
export function record(x: unknown): Record<string, unknown> {
  if (!x || typeof x !== 'object' || Array.isArray(x))
    throw new Error('Invalid Cart data');
  return x as Record<string, unknown>;
}
function exact(x: Record<string, unknown>, keys: string[]) {
  if (Object.keys(x).some((k) => !keys.includes(k)))
    throw new Error('Invalid Cart data');
}
export function identifier(x: unknown): string {
  if (typeof x !== 'string' || !ID.test(x))
    throw new Error('Invalid Cart data');
  return x;
}
export function positive(x: unknown): number {
  if (!Number.isSafeInteger(x) || (x as number) <= 0)
    throw new Error('Invalid Cart data');
  return x as number;
}
export function items(x: unknown): Item[] {
  if (!Array.isArray(x) || !x.length || x.length > 12)
    throw new Error('Invalid Cart data');
  const result = x.map((value) => {
    const p = record(value);
    exact(p, ['productId', 'quantity']);
    return {
      productId: identifier(p.productId),
      quantity: positive(p.quantity),
    };
  });
  if (new Set(result.map((p) => p.productId)).size !== result.length)
    throw new Error('Invalid Cart data');
  return result;
}
export function operation(x: unknown): Operation {
  const p = record(x);
  if (p.kind === 'create') {
    exact(p, ['kind', 'dropId', 'items']);
    return {
      kind: p.kind,
      dropId: identifier(p.dropId),
      items: items(p.items),
    };
  }
  if (p.kind === 'release') {
    exact(p, ['kind', 'cartId']);
    return { kind: p.kind, cartId: identifier(p.cartId) };
  }
  if (
    p.kind === 'replace' &&
    typeof p.ifMatch === 'string' &&
    ETAG.test(p.ifMatch)
  ) {
    exact(p, ['kind', 'cartId', 'ifMatch', 'items']);
    return {
      kind: p.kind,
      cartId: identifier(p.cartId),
      ifMatch: p.ifMatch,
      items: items(p.items),
    };
  }
  throw new Error('Invalid Cart data');
}
function timestamp(x: unknown): string {
  if (
    typeof x !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x) ||
    !Number.isFinite(Date.parse(x)) ||
    new Date(x).toISOString() !== x
  )
    throw new Error('Invalid Cart data');
  return x;
}
export function parseCart(value: unknown): Cart {
  const c = record(value);
  if (
    ![
      'ACTIVE',
      'CANCELLED',
      'EXPIRED',
      'PAYMENT_PENDING',
      'PAYMENT_COMMITTING',
      'CONVERTED',
    ].includes(String(c.status)) ||
    !Array.isArray(c.items)
  )
    throw new Error('Invalid Cart data');
  const quantities = items(
    c.items.map((v) => {
      const p = record(v);
      return { productId: p.productId, quantity: p.quantity };
    }),
  );
  const lines = quantities.map((p, i) => ({
    ...p,
    priceCents: positive(record((c.items as unknown[])[i]).priceCents),
    cookieUnits: positive(record((c.items as unknown[])[i]).cookieUnits),
  }));
  const cart = {
    cartId: identifier(c.cartId),
    dropId: identifier(c.dropId),
    status: c.status as Cart['status'],
    createdAt: timestamp(c.createdAt),
    updatedAt: timestamp(c.updatedAt),
    shoppingExpiresAt: timestamp(c.shoppingExpiresAt),
    items: lines,
  };
  total(cart, 'priceCents');
  total(cart, 'cookieUnits');
  return cart;
}
export function total(cart: Cart, field: 'priceCents' | 'cookieUnits') {
  const value = cart.items.reduce((sum, p) => sum + p.quantity * p[field], 0);
  if (!Number.isSafeInteger(value)) throw new Error('Invalid Cart data');
  return value;
}
export const released = (cart: Cart) =>
  cart.status === 'EXPIRED' || cart.status === 'CANCELLED';
export function reservationMessage(cart: Cart, expired: boolean) {
  if (released(cart))
    return 'Your reserved cookies have been released. Browse the latest availability when you’re ready.';
  if (cart.status !== 'ACTIVE')
    return 'This Cart is no longer available for shopping.';
  if (expired)
    return 'Your reservation time has expired. We’re confirming that your cookies have been released.';
  return 'These cookies are reserved while you shop.';
}
