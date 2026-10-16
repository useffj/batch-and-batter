import { waitlistsRelay } from '../../../../../lib/admin/runtime';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(
  request: Request,
  context: { params: Promise<{ action: string }> },
) {
  return waitlistsRelay(request, (await context.params).action, process.env);
}
export const POST = GET;
