import { Unsubscribe } from '../../../components/storefront/waitlist';
export const metadata = {
  robots: { index: false, follow: false },
  referrer: 'no-referrer' as const,
};
export const dynamic = 'force-dynamic';
export default function Page() {
  return <Unsubscribe />;
}
