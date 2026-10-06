import { NextResponse } from 'next/server';
import { boundedJson, sameOrigin, session } from '../cart/relay';
import { parseCart, record } from '../cart/contract';
import { loadStorefront, publicEndpoint } from '../storefront/client';
import {
  exact,
  payment,
  pickupAllowed,
  revision,
  startBody,
  type CheckoutSnapshot,
} from './contract';
import {
  pricingEnabled,
  projectPricing,
  publishableKey,
  type PricingConfig,
} from './pricing';
type Config = Parameters<typeof publicEndpoint>[0] &
  PricingConfig & { NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY?: string };
const statuses: Record<string, number> = {
  VALIDATION_ERROR: 400,
  INVALID_PICKUP_DATE: 400,
  UNAUTHORIZED: 401,
  RESERVATION_EXPIRED: 410,
  PAYMENT_ALREADY_STARTED: 409,
  CART_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  IDEMPOTENCY_KEY_EXPIRED: 409,
  DROP_NOT_OPEN: 409,
  STOREFRONT_CONFLICT: 409,
  PRODUCT_NOT_AVAILABLE: 409,
  INSUFFICIENT_INVENTORY: 409,
  QUANTITY_LIMIT_EXCEEDED: 409,
  PAYMENTS_DISABLED: 503,
  CART_BUSY: 503,
  INTERNAL_ERROR: 500,
};
function output(value: unknown, status = 200) {
  return NextResponse.json(value, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Vary: 'Cookie',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
class Upstream extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super('Payment request failed');
  }
}
export async function checkoutRelay(
  request: Request,
  action: 'read' | 'start' | 'continue',
  config: Config,
  backend: typeof fetch = fetch,
) {
  if (
    (action !== 'read' && !sameOrigin(request)) ||
    (request.headers.has('origin') && !sameOrigin(request)) ||
    (request.headers.has('sec-fetch-site') &&
      request.headers.get('sec-fetch-site') !== 'same-origin')
  )
    return output({ code: 'FORBIDDEN' }, 403);
  let s;
  try {
    s = session(request, config);
  } catch {
    return output({ code: 'UNAUTHORIZED' }, 401);
  }
  if (!s?.cartId || s.pending)
    return output(
      { code: s?.pending ? 'CART_CONFLICT' : 'UNAUTHORIZED' },
      s?.pending ? 409 : 401,
    );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  async function call(
    suffix: '' | '/payment' | '/payment/start' | '/payment/confirm',
    body?: unknown,
    headers?: Record<string, string>,
  ) {
    const endpoint = publicEndpoint(config);
    endpoint.pathname = endpoint.pathname.replace(
      /\/drops\/current$/,
      `/carts/${s!.cartId}${suffix}`,
    );
    const result = await backend(endpoint, {
      method: body === undefined ? 'GET' : 'POST',
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'X-Cart-Token': s!.token,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = record(await boundedJson(result));
    if (!result.ok) {
      const code =
        typeof data.code === 'string' && statuses[data.code] === result.status
          ? data.code
          : 'INTERNAL_ERROR';
      throw new Upstream(code, statuses[code]);
    }
    return { result, data };
  }
  try {
    if (action === 'read') {
      const c = await call('');
      if (c.result.status !== 200) throw new Error();
      const cart = parseCart(c.data.cart);
      if (cart.cartId !== s.cartId || typeof c.data.expired !== 'boolean')
        throw new Error();
      const etag = revision(c.result.headers.get('etag'));
      const raw = record(c.data.cart);
      let p = null,
        paymentEtag = null;
      if (raw.paymentAttemptId !== undefined) {
        const r = await call('/payment');
        if (r.result.status !== 200) throw new Error();
        p = payment(r.data.payment);
        paymentEtag = revision(r.result.headers.get('etag'));
        if (
          p.paymentAttemptId !== raw.paymentAttemptId ||
          p.orderId !== raw.orderId ||
          p.paymentDeadline !== raw.paymentDeadline
        )
          throw new Error();
      } else if (
        ['PAYMENT_PENDING', 'PAYMENT_COMMITTING', 'CONVERTED'].includes(
          cart.status,
        )
      )
        throw new Error();
      const stamp = Date.parse(c.result.headers.get('date') ?? '');
      const serverNow = Number.isFinite(stamp) ? stamp : Date.now();
      // Current Drop presentation is not a frozen paid-Order snapshot.
      const store = await loadStorefront(config, backend);
      const drop =
        store.kind === 'ready' && store.drop?.id === cart.dropId
          ? store.drop
          : null;
      const summary = projectPricing(cart, config);
      const value: CheckoutSnapshot = {
        cart,
        etag,
        payment: p,
        paymentEtag,
        serverNow,
        summary,
        drop,
        available:
          !p &&
          cart.status === 'ACTIVE' &&
          !c.data.expired &&
          Date.parse(cart.shoppingExpiresAt) > serverNow &&
          !!summary &&
          !!publishableKey(config.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY) &&
          drop?.status === 'OPEN' &&
          drop.pickupDates.some((p) => pickupAllowed(p, serverNow)),
      };
      return output(value);
    }
    let body: unknown, key: string, etag: string;
    try {
      key = request.headers.get('idempotency-key') ?? '';
      if (
        !/^v1\.\d{13}\.[A-Za-z0-9_-]{43}$/.test(key) ||
        Buffer.from(key.split('.')[2], 'base64url').toString('base64url') !==
          key.split('.')[2]
      )
        throw new Error();
      etag = revision(request.headers.get('if-match'));
      const data = record(await boundedJson(request));
      if (action === 'start') body = startBody(data);
      else {
        exact(data, ['continuationGeneration']);
        if (
          !Number.isInteger(data.continuationGeneration) ||
          Number(data.continuationGeneration) < 1 ||
          Number(data.continuationGeneration) > 7
        )
          throw new Error();
        body = { continuationGeneration: data.continuationGeneration };
      }
    } catch {
      return output({ code: 'VALIDATION_ERROR' }, 400);
    }
    if (
      action === 'start' &&
      (!pricingEnabled(config) ||
        !publishableKey(config.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY))
    )
      return output({ code: 'CHECKOUT_UNAVAILABLE' }, 503);
    const { result, data } = await call(
      action === 'start' ? '/payment/start' : '/payment/confirm',
      body,
      { 'If-Match': etag, 'Idempotency-Key': key },
    );
    if (result.status !== (action === 'start' ? 201 : 202)) throw new Error();
    if (action === 'start') {
      const cart = parseCart(data.cart);
      if (cart.cartId !== s.cartId || cart.status !== 'PAYMENT_PENDING')
        throw new Error();
    } else if (data.accepted !== true) throw new Error();
    // Do not return an idempotency receipt as current state. Client must reread.
    return output({ accepted: true }, result.status);
  } catch (error) {
    return error instanceof Upstream
      ? output({ code: error.code }, error.status)
      : output({ code: 'RECOVERY_REQUIRED' }, 503);
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}
export const checkoutConfig = () => ({
  NODE_ENV: process.env.NODE_ENV,
  STOREFRONT_API_BASE_URL: process.env.STOREFRONT_API_BASE_URL,
  STOREFRONT_CURRENCY: process.env.STOREFRONT_CURRENCY,
  CHECKOUT_PRICING_MODE: process.env.CHECKOUT_PRICING_MODE,
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY:
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
});
