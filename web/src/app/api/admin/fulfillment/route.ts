import { fulfillmentRelay } from '../../../../lib/admin/runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  return fulfillmentRelay(request, undefined, process.env);
}
