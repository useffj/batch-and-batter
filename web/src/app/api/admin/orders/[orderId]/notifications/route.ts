import { notificationRelay } from '../../../../../../lib/admin/runtime';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(
  r: Request,
  context: { params: Promise<{ orderId: string }> },
) {
  return notificationRelay(r, (await context.params).orderId, process.env);
}
