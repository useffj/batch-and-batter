import { accessRelay } from '../../../../../../../lib/admin/runtime';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function POST(
  r: Request,
  context: { params: Promise<{ orderId: string; action: string }> },
) {
  const p = await context.params;
  if (p.action !== 'reissue' && p.action !== 'revoke')
    return new Response(null, {
      status: 404,
      headers: { 'Cache-Control': 'no-store' },
    });
  return accessRelay(r, p.orderId, p.action, process.env);
}
