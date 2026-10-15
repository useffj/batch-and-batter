import { customerRelay } from '../../../../../lib/admin/runtime';
export const runtime = 'nodejs';
export function POST(request: Request) {
  return customerRelay(request, 'search', process.env);
}
