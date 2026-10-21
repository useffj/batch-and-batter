// Server-only policy: never import from a client component.
import { total, type Cart } from '../cart/contract';
export interface PricingConfig {
  CHECKOUT_PRICING_MODE?: string;
  STOREFRONT_CURRENCY?: string;
}
export function pricingEnabled(config: PricingConfig) {
  return (
    config.CHECKOUT_PRICING_MODE === 'dev-zero-tax-fee' &&
    config.STOREFRONT_CURRENCY === 'USD'
  );
}
export function publishableKey(value: string | undefined) {
  // Current backend is sandbox-only. Production keys need a separate launch gate.
  return value && /^pk_test_[a-zA-Z0-9]+$/.test(value) ? value : null;
}

// Validate the backend's authoritative quote before forwarding presentation data.
// Recalculation here is a consistency check, never the source of payment amounts.
export function parseQuote(value: unknown, cart: Cart, etag: string) {
  const q = value as Record<string, unknown>;
  if (
    !q ||
    q.version !== 1 ||
    typeof q.id !== 'string' ||
    !/^[a-f0-9]{64}$/.test(q.id) ||
    q.cartId !== cart.cartId ||
    q.cartRevision !== etag ||
    q.dropId !== cart.dropId ||
    q.validUntil !== cart.shoppingExpiresAt ||
    typeof q.dropRevision !== 'string'
  )
    throw new Error('Invalid quote');
  const policy = q.policy as Record<string, unknown>;
  if (
    !policy ||
    policy.id !== 'DEVELOPMENT_ONLY_ZERO_TAX_ZERO_FEE' ||
    typeof policy.version !== 'string' ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(policy.version)
  )
    throw new Error('Invalid policy');
  if (
    !Array.isArray(q.items) ||
    q.items.length !== cart.items.length ||
    q.items.some((i, n) => {
      const expected = [...cart.items].sort((a, b) =>
        a.productId.localeCompare(b.productId),
      )[n];
      return (
        !i ||
        i.productId !== expected.productId ||
        i.quantity !== expected.quantity ||
        i.priceCents !== expected.priceCents ||
        i.cookieUnits !== expected.cookieUnits
      );
    })
  )
    throw new Error('Invalid reserved prices');
  const a = q.amount as Record<string, unknown>;
  if (
    !a ||
    a.currency !== 'usd' ||
    a.subtotalCents !== total(cart, 'priceCents') ||
    a.taxCents !== 0 ||
    a.feeCents !== 0 ||
    a.totalCents !== a.subtotalCents ||
    !Number.isSafeInteger(a.totalCents) ||
    Number(a.totalCents) < 50 ||
    Number(a.totalCents) > 99999999
  )
    throw new Error('Invalid amounts');
  if (
    typeof q.pickupLocation !== 'string' ||
    !q.pickupLocation ||
    q.pickupLocation.length > 2000 ||
    typeof q.pickupInstructions !== 'string' ||
    q.pickupInstructions.length > 4000 ||
    !Array.isArray(q.pickups) ||
    q.pickups.length > 31
  )
    throw new Error('Invalid pickup terms');
  const pickups = q.pickups.map((p: Record<string, unknown>) => {
    if (
      !p ||
      p.dropId !== cart.dropId ||
      p.active !== true ||
      typeof p.date !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(p.date) ||
      typeof p.startTime !== 'string' ||
      !/^\d{2}:\d{2}$/.test(p.startTime) ||
      typeof p.endTime !== 'string' ||
      !/^\d{2}:\d{2}$/.test(p.endTime) ||
      p.endTime <= p.startTime ||
      typeof p.timezone !== 'string'
    )
      throw new Error('Invalid pickup');
    new Intl.DateTimeFormat('en-US', { timeZone: p.timezone });
    return {
      date: p.date,
      startTime: p.startTime,
      endTime: p.endTime,
      timezone: p.timezone,
    };
  });
  if (new Set(pickups.map((p) => p.date)).size !== pickups.length)
    throw new Error('Duplicate pickup');
  return {
    id: q.id,
    summary: {
      currency: 'USD' as const,
      subtotal: Number(a.subtotalCents),
      tax: a.taxCents as 0,
      fees: a.feeCents as 0,
      total: Number(a.totalCents),
    },
    pickups,
    pickupLocation: q.pickupLocation,
    pickupInstructions: q.pickupInstructions,
  };
}
