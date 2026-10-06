import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { publicEndpoint } from '../storefront/client';
import {
  ETAG,
  identifier,
  messages,
  operation,
  parseCart,
  record,
  released,
  type CartCode,
  type Operation,
} from './contract';

type Config = Parameters<typeof publicEndpoint>[0];
interface Session {
  token: string;
  cartId?: string;
  pending?: { key: string; operation: Operation };
}
const MAX = 16384;
const secret = /^[A-Za-z0-9_-]{43}$/;
const keyPattern = /^v1\.\d{13}\.[A-Za-z0-9_-]{43}$/;
const cookieName = (config: Config) =>
  config.NODE_ENV === 'production' ? '__Host-bb-cart' : 'bb-cart-local';
const random = () => randomBytes(32).toString('base64url');
export function session(request: Request, config: Config): Session | undefined {
  const values = (request.headers.get('cookie') ?? '')
    .split(';')
    .map((v) => v.trim())
    .filter((v) => v.startsWith(cookieName(config) + '='));
  if (!values.length) return;
  if (values.length !== 1) throw new Error('Invalid session');
  const encoded = values[0].slice(cookieName(config).length + 1);
  if (encoded.length > 3800 || !/^[\w-]+$/.test(encoded))
    throw new Error('Invalid session');
  const s = record(
    JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')),
  );
  if (
    typeof s.token !== 'string' ||
    !secret.test(s.token) ||
    Buffer.from(s.token, 'base64url').toString('base64url') !== s.token
  )
    throw new Error('Invalid session');
  const result: Session = { token: s.token };
  if (s.cartId !== undefined) result.cartId = identifier(s.cartId);
  if (s.pending !== undefined) {
    const p = record(s.pending);
    if (
      typeof p.key !== 'string' ||
      !keyPattern.test(p.key) ||
      Buffer.from(p.key.split('.')[2], 'base64url').toString('base64url') !==
        p.key.split('.')[2]
    )
      throw new Error('Invalid session');
    const op = operation(p.operation);
    if (
      (op.kind === 'create' && result.cartId) ||
      (op.kind !== 'create' && op.cartId !== result.cartId)
    )
      throw new Error('Invalid session');
    result.pending = { key: p.key, operation: op };
  }
  if (!result.cartId && !result.pending) throw new Error('Invalid session');
  return result;
}
function output(body: unknown, status = 200, etag?: string) {
  return NextResponse.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store, private',
      Vary: 'Cookie',
      'X-Content-Type-Options': 'nosniff',
      ...(etag ? { ETag: etag } : {}),
    },
  });
}
function save(response: NextResponse, config: Config, s?: Session) {
  response.cookies.set(
    cookieName(config),
    s ? Buffer.from(JSON.stringify(s)).toString('base64url') : '',
    {
      httpOnly: true,
      secure: config.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge: s ? 7 * 86400 : 0,
    },
  );
  return response;
}
function fail(code: CartCode, status: number, pending = false) {
  return output({ code, message: messages[code], pending }, status);
}
export async function boundedJson(
  request: Request | Response,
): Promise<unknown> {
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      request.headers.get('content-type') ?? '',
    ) ||
    !request.body
  )
    throw new Error('Invalid body');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX) throw new Error('Body too large');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
export function sameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  // Trust only the actual Host, never caller-supplied forwarded host/origin.
  const url = new URL(request.url);
  const host = request.headers.get('host') ?? url.host;
  return (
    origin === `${url.protocol}//${host}` &&
    (!request.headers.has('sec-fetch-site') ||
      request.headers.get('sec-fetch-site') === 'same-origin')
  );
}
export async function cartRelay(
  request: Request,
  action: 'read' | 'prepare' | 'execute',
  config: Config,
  backend: typeof fetch = fetch,
): Promise<NextResponse> {
  if (action !== 'read' && !sameOrigin(request))
    return output(
      { message: 'This request must come from this storefront.' },
      403,
    );
  let s: Session | undefined;
  try {
    s = session(request, config);
  } catch {
    return save(fail('UNAUTHORIZED', 401), config);
  }
  if (action === 'prepare') {
    // Never replace a pending operation, including an ambiguous bootstrap.
    if (s?.pending) return output({ pending: true });
    let op: Operation;
    try {
      op = operation(await boundedJson(request));
    } catch {
      return fail('VALIDATION_ERROR', 400);
    }
    if (
      (op.kind === 'create' && s?.cartId) ||
      (op.kind !== 'create' && op.cartId !== s?.cartId)
    )
      return fail('CART_CONFLICT', 409);
    // No backend mutation until this cookie is sent back on a separate request.
    return save(output({ pending: true }), config, {
      token: s?.token ?? random(),
      ...(s?.cartId ? { cartId: s.cartId } : {}),
      pending: { key: `v1.${Date.now()}.${random()}`, operation: op },
    });
  }
  if (action === 'read' && (!s || s.pending))
    return output({
      cart: null,
      expired: false,
      pending: !!s?.pending,
      etag: null,
      serverNow: Date.now(),
    });
  if (action === 'execute') {
    try {
      const body = record(await boundedJson(request));
      if (Object.keys(body).length) throw new Error();
    } catch {
      return fail('VALIDATION_ERROR', 400, !!s?.pending);
    }
  }
  if (action === 'execute' && !s?.pending) return fail('CART_CONFLICT', 409);
  if (!s) return fail('UNAUTHORIZED', 401);
  const pending = action === 'execute' ? s.pending : undefined;
  const op = pending?.operation;
  const method = !op
    ? 'GET'
    : op.kind === 'create'
      ? 'POST'
      : op.kind === 'replace'
        ? 'PUT'
        : 'DELETE';
  const path =
    op?.kind === 'create'
      ? '/carts'
      : `/carts/${s.cartId}${op?.kind === 'replace' ? '/items' : ''}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const endpoint = publicEndpoint(config);
    endpoint.pathname = endpoint.pathname.replace(/\/drops\/current$/, path);
    const response = await backend(endpoint, {
      method,
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'X-Cart-Token': s.token,
        ...(pending ? { 'Idempotency-Key': pending.key } : {}),
        ...(op?.kind === 'replace' ? { 'If-Match': op.ifMatch } : {}),
        ...(op && op.kind !== 'release'
          ? { 'Content-Type': 'application/json' }
          : {}),
      },
      ...(op && op.kind !== 'release'
        ? {
            body: JSON.stringify(
              op.kind === 'create'
                ? { dropId: op.dropId, items: op.items }
                : { items: op.items },
            ),
          }
        : {}),
    });
    const data = record(await boundedJson(response));
    if (!response.ok) {
      const code =
        typeof data.code === 'string' && Object.hasOwn(messages, data.code)
          ? (data.code as CartCode)
          : 'INTERNAL_ERROR';
      // 5xx, malformed and transport failures may conceal a committed mutation.
      if (
        response.status >= 500 ||
        code === 'CART_BUSY' ||
        code === 'INTERNAL_ERROR'
      )
        return fail(code, 503, !!pending);
      const expected =
        code === 'UNAUTHORIZED'
          ? 401
          : code === 'VALIDATION_ERROR'
            ? 400
            : code === 'RESERVATION_EXPIRED'
              ? 410
              : 409;
      if (response.status !== expected)
        return fail('INTERNAL_ERROR', 503, !!pending);
      return save(
        fail(code, expected),
        config,
        code === 'UNAUTHORIZED' || !s.cartId
          ? undefined
          : { token: s.token, cartId: s.cartId },
      );
    }
    if (response.status !== (method === 'POST' ? 201 : 200))
      throw new Error('Invalid response');
    const cart = parseCart(data.cart);
    const etag = response.headers.get('etag');
    if (
      !etag ||
      !ETAG.test(etag) ||
      (s.cartId && cart.cartId !== s.cartId) ||
      (op?.kind === 'create' && cart.dropId !== op.dropId) ||
      (!op && typeof data.expired !== 'boolean')
    )
      throw new Error('Invalid response');
    // API Gateway Date is preferred. Relay receipt time is a server-clock fallback.
    const date = Date.parse(response.headers.get('date') ?? '');
    const serverNow = Number.isFinite(date) ? date : Date.now();
    const result = output(
      {
        cart,
        expired:
          typeof data.expired === 'boolean'
            ? data.expired
            : cart.status === 'EXPIRED',
        pending: false,
        etag,
        serverNow,
      },
      200,
      etag,
    );
    return save(
      result,
      config,
      released(cart) ? undefined : { token: s.token, cartId: cart.cartId },
    );
  } catch {
    return fail('INTERNAL_ERROR', 503, !!pending);
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}
