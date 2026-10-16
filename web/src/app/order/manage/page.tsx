import type { Metadata } from 'next';
import { ManageOrder } from '../../../components/guest/manage-order';
export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Your order | Batch & Batter',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};
export default function Page() {
  return <ManageOrder />;
}
