// Server-only policy: never import from a client component.
import { total, type Cart } from '../cart/contract';
import type { Summary } from './contract';
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
export function projectPricing(
  cart: Cart,
  config: PricingConfig,
): Summary | null {
  if (!pricingEnabled(config)) return null;
  const subtotal = total(cart, 'priceCents');
  // Stripe's supported card presentation range; this never authorizes settlement.
  if (subtotal < 50 || subtotal > 99999999) return null;
  return {
    currency: config.STOREFRONT_CURRENCY as 'USD',
    subtotal,
    tax: 0,
    fees: 0,
    total: subtotal,
  };
}
export function publishableKey(value: string | undefined) {
  // Current backend is sandbox-only. Production keys need a separate launch gate.
  return value && /^pk_test_[a-zA-Z0-9]+$/.test(value) ? value : null;
}
