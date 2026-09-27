import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { ApiEvent, ApiResponse } from './api';
import { idSchema } from './domain';
import {
  CartError,
  secretHash,
  createCartSchema,
  replaceCartSchema,
  etag,
  parseKey,
  type CartRequest,
  type CartMetrics,
} from './cart-domain';
import type { CartService } from './cart-repository';
import { logCompletion, type InvocationContext } from './request-logging';

export const cartRoutes = [
  'POST /carts',
  'GET /carts/{cartId}',
  'PUT /carts/{cartId}/items',
  'DELETE /carts/{cartId}',
];
function header(event: ApiEvent, name: string): string | undefined {
  const matches = Object.entries(event.headers ?? {}).filter(
    ([k]) => k.toLowerCase() === name,
  );
  if (matches.length > 1) throw new CartError('VALIDATION_ERROR');
  return matches[0]?.[1];
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new CartError('VALIDATION_ERROR');
  return result.data;
}
function jsonBody(event: ApiEvent): unknown {
  try {
    if (typeof event.body !== 'string' || event.body.length > 16384)
      throw new Error();
    return JSON.parse(
      event.isBase64Encoded
        ? Buffer.from(event.body, 'base64').toString('utf8')
        : event.body,
    );
  } catch {
    throw new CartError('VALIDATION_ERROR');
  }
}
export async function cartApi(
  event: ApiEvent,
  getService: () => CartService,
  context?: InvocationContext,
): Promise<ApiResponse> {
  const started = performance.now();
  const metrics: CartMetrics = { attempts: 0 };
  let code: string | undefined;
  let response: ApiResponse;
  try {
    const tokenHash = secretHash(header(event, 'x-cart-token'));
    const create = event.routeKey === 'POST /carts';
    const get = event.routeKey === 'GET /carts/{cartId}';
    const release = event.routeKey === 'DELETE /carts/{cartId}';
    const cartId = create
      ? undefined
      : parse(idSchema, event.pathParameters?.cartId);
    let result;
    if (get) result = await getService().get(cartId!, tokenHash);
    else {
      const key = parseKey(header(event, 'idempotency-key')).raw;
      let request: CartRequest;
      if (create) {
        const input = parse(createCartSchema, jsonBody(event));
        request = { operation: 'create', tokenHash, key, ...input };
      } else if (release) {
        if (event.body !== undefined && event.body !== '')
          parse(z.strictObject({}), jsonBody(event));
        request = { operation: 'release', cartId, tokenHash, key };
      } else {
        const input = parse(replaceCartSchema, jsonBody(event));
        const ifMatch = header(event, 'if-match');
        if (!ifMatch || !/^"[a-f0-9]{64}"$/.test(ifMatch))
          throw new CartError('VALIDATION_ERROR');
        request = {
          operation: 'replace',
          cartId,
          tokenHash,
          key,
          ifMatch,
          ...input,
        };
      }
      result = await getService().mutate(
        request,
        metrics,
        context?.getRemainingTimeInMillis
          ? () => context.getRemainingTimeInMillis!()
          : undefined,
      );
    }
    response = {
      statusCode: result.status,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        etag: etag(result.cart.updatedAt),
      },
      body: JSON.stringify({
        cart: result.cart,
        ...(result.expired === undefined ? {} : { expired: result.expired }),
      }),
    };
  } catch (error) {
    const safe =
      error instanceof CartError ? error : new CartError('INTERNAL_ERROR');
    code = safe.code;
    response = {
      statusCode: safe.status,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        ...(safe.code === 'CART_BUSY' ? { 'retry-after': '1' } : {}),
      },
      body: JSON.stringify({
        code: safe.code,
        message: safe.message,
        requestId: event.requestContext.requestId,
      }),
    };
  }
  logCompletion(event, context, response, code, {
    attempts: metrics.attempts,
    durationMs: Math.round(performance.now() - started),
  });
  return response;
}
