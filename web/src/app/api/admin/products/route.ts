import { productRelay } from '../../../../lib/admin/runtime';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const GET = (r: Request) => productRelay(r, undefined, process.env);
export const POST = GET;
