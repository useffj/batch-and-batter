import { mediaRelay } from '../../../../../../lib/admin/runtime';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(
  request: Request,
  context: { params: Promise<{ productId: string }> },
) {
  const p = await context.params;
  return mediaRelay(
    request,
    new URL(request.url).searchParams.get('view') === 'ready'
      ? {
          productId: p.productId,
          kind: 'ready',
          after: new URL(request.url).searchParams.get('after') ?? undefined,
        }
      : { productId: p.productId, kind: 'manifest' },
    process.env,
  );
}
export const PUT = GET;
