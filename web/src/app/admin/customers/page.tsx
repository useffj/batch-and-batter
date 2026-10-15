import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { authorize } from '../../../lib/admin/runtime';
import { Customers } from '../../../components/admin/customers';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export default async function Page() {
  let expiresAt: number;
  try {
    expiresAt = (await authorize((await cookies()).toString(), process.env))
      .expiresAt;
  } catch {
    redirect('/admin/login?reason=expired');
  }
  return <Customers expiresAt={expiresAt} />;
}
