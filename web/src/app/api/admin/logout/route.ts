import { adminRelay } from '../../../../lib/admin/runtime';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  return adminRelay(request, 'logout', process.env);
}
