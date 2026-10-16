import { worklistRelay } from '../../../../lib/admin/runtime';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(r: Request) {
  return worklistRelay(r, process.env);
}
