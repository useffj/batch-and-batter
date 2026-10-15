import { mediaRelay } from '../../../../../../../lib/admin/runtime';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function POST(
  request: Request,
  context: { params: Promise<{ productId: string }> },
) {
  const p = await context.params;
  return mediaRelay(
    request,
    { productId: p.productId, kind: 'uploads' },
    process.env,
  );
}
