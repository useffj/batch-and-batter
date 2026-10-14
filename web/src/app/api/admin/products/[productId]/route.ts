import { productRelay } from '../../../../../lib/admin/runtime';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(
  r: Request,
  context: { params: Promise<{ productId: string }> },
) {
  return productRelay(r, (await context.params).productId, process.env);
}
export const PUT = GET;
