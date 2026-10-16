import { waitlistRelay } from '../../../../lib/waitlist/relay';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function POST(
  request: Request,
  context: { params: Promise<{ action: string }> },
) {
  return waitlistRelay(request, (await context.params).action, process.env);
}
