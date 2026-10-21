import { CartError, etag, hash, type Cart } from './cart-domain';
import type { Drop, PickupDate } from './domain';
import { paymentAmount, type PaymentPricing } from './payment-domain';

// A content identity, not a bearer credential. Starts always reconstruct it from
// authorized records. No browser-supplied amount or quote body is trusted.
export function checkoutQuote(
  cart: Cart,
  drop: Drop,
  pickups: PickupDate[],
  pricing: PaymentPricing,
) {
  const version = pricing.version === undefined ? '1' : pricing.version;
  if (typeof version !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(version))
    throw new CartError('PAYMENT_UNAVAILABLE');
  const amount = paymentAmount(cart, pricing);
  if (
    amount.currency !== 'usd' ||
    amount.totalCents < 50 ||
    amount.totalCents > 99999999
  )
    throw new CartError('PAYMENT_UNAVAILABLE');
  const snapshot = {
    version: 1 as const,
    cartId: cart.cartId,
    cartRevision: etag(cart.updatedAt),
    dropId: cart.dropId,
    dropRevision: drop.updatedAt,
    validUntil: cart.shoppingExpiresAt,
    policy: { id: pricing.fixture, version },
    items: cart.items
      .map((i) => ({ ...i }))
      .sort((a, b) => a.productId.localeCompare(b.productId)),
    amount,
    pickupLocation: drop.pickupLocation,
    pickupInstructions: drop.pickupInstructions,
    pickups: pickups
      .filter((p) => p.active)
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
  return { ...snapshot, id: hash(JSON.stringify(snapshot)) };
}
