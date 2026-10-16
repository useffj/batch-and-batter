import { accessRelay } from '../../../../../../../lib/admin/runtime';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function POST(
  request: Request,
  context: { params: Promise<{ orderId: string }> },
) {
  return accessRelay(
    request,
    (await context.params).orderId,
    'review',
    process.env,
  );
}
