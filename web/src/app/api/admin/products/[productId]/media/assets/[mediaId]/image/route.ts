import { imageRelay } from '../../../../../../../../../lib/admin/runtime';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(
  request: Request,
  context: { params: Promise<{ productId: string; mediaId: string }> },
) {
  const p = await context.params;
  return imageRelay(request, p.productId, p.mediaId, process.env);
}
