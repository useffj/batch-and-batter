import { checkoutConfig, checkoutRelay } from '../../../lib/checkout/relay';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const GET = (request: Request) =>
  checkoutRelay(request, 'read', checkoutConfig());
