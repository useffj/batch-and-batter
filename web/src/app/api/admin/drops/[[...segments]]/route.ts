import { weeklyDropRelay } from '../../../../../lib/admin/runtime';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(
  r: Request,
  context: { params: Promise<{ segments?: string[] }> },
) {
  return weeklyDropRelay(r, (await context.params).segments ?? [], process.env);
}
export const POST = GET;
export const PUT = GET;
