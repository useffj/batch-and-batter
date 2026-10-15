import { mediaRelay } from '../../../../../../../../lib/admin/runtime';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(
  request: Request,
  context: { params: Promise<{ productId: string; uploadId: string }> },
) {
  const p = await context.params;
  return mediaRelay(
    request,
    { productId: p.productId, kind: 'status', itemId: p.uploadId },
    process.env,
  );
}
