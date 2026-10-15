import { orderRelay } from '../../../../../lib/admin/runtime';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(
  r: Request,
  context: { params: Promise<{ orderId: string }> },
) {
  return orderRelay(r, (await context.params).orderId, process.env);
}
