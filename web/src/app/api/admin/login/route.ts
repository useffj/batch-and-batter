import { adminRelay } from '../../../../lib/admin/server';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  return adminRelay(request, 'login', process.env);
}
