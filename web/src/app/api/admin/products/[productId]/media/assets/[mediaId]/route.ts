import { mediaRelay } from '../../../../../../../../lib/admin/runtime';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(
  request: Request,
  context: { params: Promise<{ productId: string; mediaId: string }> },
) {
  const p = await context.params;
  return mediaRelay(
    request,
    { productId: p.productId, kind: 'asset', itemId: p.mediaId },
    process.env,
  );
}
