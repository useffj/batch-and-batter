import { isolatedMediaEnabled } from '../../../lib/admin/media-config';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { authorize, AdminFailure } from '../../../lib/admin/runtime';
import { Products } from '../../../components/admin/products';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export default async function AdminPage() {
  let expiresAt: number;
  let catalogScope: string | undefined;
  try {
    const session = await authorize((await cookies()).toString(), process.env);
    expiresAt = session.expiresAt;
    catalogScope = session.catalogScope;
  } catch (e) {
    const reason =
      e instanceof AdminFailure
        ? e.code === 'EXPIRED'
          ? 'expired'
          : e.code === 'FORBIDDEN'
            ? 'forbidden'
            : e.code === 'CONFIGURATION'
              ? 'configuration'
              : e.code === 'UNAUTHENTICATED'
                ? ''
                : 'unavailable'
        : 'unavailable';
    redirect(`/admin/login${reason ? `?reason=${reason}` : ''}`);
  }
  return (
    <Products
      expiresAt={expiresAt}
      catalogScope={catalogScope}
      mediaEnabled={isolatedMediaEnabled(process.env)}
    />
  );
}
