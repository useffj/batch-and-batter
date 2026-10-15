import { fulfillmentRelay } from '../../../../../../lib/admin/runtime';
export const runtime = 'nodejs';
export async function POST(
  request: Request,
  context: { params: Promise<{ orderId: string }> },
) {
  return fulfillmentRelay(request, (await context.params).orderId, process.env);
}
