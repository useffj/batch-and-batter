import type { PaymentCustomer } from './payment-workflow';
// Shared HTTP contract; production construction keeps new admission disabled by default.
import { z } from 'zod';
import { CartError, secretHash } from './cart-domain';
import { idSchema } from './domain';
import { startPaymentSchema } from './payment-domain';
import type { PaymentRepository } from './payment-repository';
import type { ApiEvent, ApiResponse } from './api';
export async function localPaymentApi(
  event: ApiEvent,
  repository: Pick<PaymentRepository, 'start' | 'get'>,
  payment?: PaymentCustomer,
): Promise<ApiResponse> {
  const start = event.routeKey === 'POST /carts/{cartId}/payment/start';
  const confirm = event.routeKey === 'POST /carts/{cartId}/payment/confirm';
  const get = event.routeKey === 'GET /carts/{cartId}/payment';
  let code: string | undefined;
  let response: ApiResponse;
  const headers = {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  };
  const header = (name: string) => {
    const found = Object.entries(event.headers ?? {}).filter(
      ([k]) => k.toLowerCase() === name,
    );
    if (found.length > 1) throw new CartError('VALIDATION_ERROR');
    return found[0]?.[1];
  };
  try {
    if (
      (!start && !get && !confirm) ||
      event.routeKey.split(' ')[0] !== event.requestContext.http.method
    )
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ code: 'NOT_FOUND' }),
      };
    const tokenHash = secretHash(header('x-cart-token'));
    const cartId = idSchema.parse(event.pathParameters?.cartId);
    if (get && payment) {
      const result = await payment.get(cartId, tokenHash);
      response = {
        statusCode: 200,
        headers: { ...headers, etag: result.etag },
        body: JSON.stringify({ payment: result.payment }),
      };
    } else if (get)
      response = {
        statusCode: 200,
        headers,
        body: JSON.stringify(await repository.get(cartId, tokenHash)),
      };
    else {
      const ifMatch = header('if-match');
      if (!ifMatch || !/^"[a-f0-9]{64}"$/.test(ifMatch))
        throw new CartError('VALIDATION_ERROR');
      if (!event.body || event.body.length > 16384)
        throw new CartError('VALIDATION_ERROR');
      let parsed: unknown;
      try {
        parsed = JSON.parse(
          event.isBase64Encoded
            ? Buffer.from(event.body, 'base64').toString('utf8')
            : event.body,
        );
      } catch {
        throw new CartError('VALIDATION_ERROR');
      }
      if (confirm) {
        if (!payment) throw new CartError('INTERNAL_ERROR');
        const input = z
          .strictObject({
            continuationGeneration: z.number().int().min(1).max(7),
          })
          .parse(parsed);
        const result = await payment.confirm({
          ...input,
          cartId,
          tokenHash,
          ifMatch,
          key: header('idempotency-key') ?? '',
        });
        console.info(
          JSON.stringify({
            operation: 'confirmPayment',
            statusCode: result.status,
          }),
        );
        return {
          statusCode: result.status,
          headers,
          body: JSON.stringify({ accepted: true }),
        };
      }
      const input = startPaymentSchema.parse(parsed);
      const result = await repository.start({
        ...input,
        cartId,
        tokenHash,
        ifMatch,
        key: header('idempotency-key') ?? '',
      });
      response = {
        statusCode: result.status,
        headers,
        body: JSON.stringify({ cart: result.cart }),
      };
    }
  } catch (error) {
    const safe =
      error instanceof CartError
        ? error
        : new CartError(
            error instanceof z.ZodError ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR',
          );
    code = safe.code;
    response = {
      statusCode: safe.status,
      headers,
      body: JSON.stringify({
        code,
        message: safe.message,
        requestId: event.requestContext.requestId,
      }),
    };
  }
  console.info(
    JSON.stringify({
      operation: start
        ? 'beginPayment'
        : confirm
          ? 'confirmPayment'
          : 'getPayment',
      statusCode: response.statusCode,
      ...(code ? { code } : {}),
    }),
  );
  return response;
}
