import { Storefront } from '../components/storefront/storefront';
import { loadStorefront } from '../lib/storefront/client';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const result = await loadStorefront({
    STOREFRONT_API_BASE_URL: process.env.STOREFRONT_API_BASE_URL,
    STOREFRONT_CURRENCY: process.env.STOREFRONT_CURRENCY,
    NODE_ENV: process.env.NODE_ENV,
  });
  return <Storefront result={result} />;
}
