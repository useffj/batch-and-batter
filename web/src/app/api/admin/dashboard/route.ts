import { adminRelay } from '../../../../lib/admin/server';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  return adminRelay(request, 'dashboard', process.env);
}
