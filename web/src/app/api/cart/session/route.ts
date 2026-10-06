import { cartRelay } from '../../../../lib/cart/relay';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const POST = (request: Request) =>
  cartRelay(request, 'prepare', {
    NODE_ENV: process.env.NODE_ENV,
    STOREFRONT_API_BASE_URL: process.env.STOREFRONT_API_BASE_URL,
    STOREFRONT_CURRENCY: process.env.STOREFRONT_CURRENCY,
  });
