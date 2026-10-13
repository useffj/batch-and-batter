import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { authorize, AdminFailure } from '../../lib/admin/server';
import { Dashboard } from '../../components/admin/dashboard';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export default async function AdminPage() {
  let expiresAt: number;
  try {
    expiresAt = (await authorize((await cookies()).toString(), process.env))
      .expiresAt;
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
  return <Dashboard expiresAt={expiresAt} />;
}
