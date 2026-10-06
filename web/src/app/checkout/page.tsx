import { Checkout } from '../../components/checkout/checkout';
import { publishableKey } from '../../lib/checkout/pricing';
export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'Checkout — Batch & Batter',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};
export default function CheckoutPage() {
  return (
    <Checkout
      publishableKey={publishableKey(
        process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
      )}
    />
  );
}
