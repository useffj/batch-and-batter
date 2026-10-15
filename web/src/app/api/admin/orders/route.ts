import { orderRelay } from '../../../../lib/admin/runtime';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(r: Request) {
  return orderRelay(r, undefined, process.env);
}
