import { Login } from '../../../components/admin/login';
export const dynamic = 'force-dynamic';
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;
  return <Login reason={typeof reason === 'string' ? reason : ''} />;
}
