import { checkoutConfig, checkoutRelay } from '../../../../lib/checkout/relay';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const POST = (request: Request) =>
  checkoutRelay(request, 'continue', checkoutConfig());
