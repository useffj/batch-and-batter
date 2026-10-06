import type {
  Stripe,
  StripeElements,
  StripeElementsOptions,
  StripeExpressCheckoutElementOptions,
} from '@stripe/stripe-js';
import { parseCart, record, total } from '../cart/contract';
import type { Lock } from '../cart/client';
import {
  customer,
  date,
  payment,
  pickupAllowed,
  recoveryMessage,
  revision,
  startBody,
  type CheckoutSnapshot,
  type Customer,
} from './contract';
export const markerKey = (cartId: string) => `bb-payment-unresolved:${cartId}`;
export type MarkerStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export const expressOptions: StripeExpressCheckoutElementOptions = {
  paymentMethods: {
    applePay: 'auto',
    googlePay: 'auto',
    amazonPay: 'never',
    link: 'never',
    paypal: 'never',
    klarna: 'never',
  },
  layout: { maxColumns: 1, maxRows: 2, overflow: 'auto' },
};
export function elementsOptions(
  summary: NonNullable<CheckoutSnapshot['summary']>,
): StripeElementsOptions {
  return {
    mode: 'payment',
    amount: summary.total,
    currency: summary.currency.toLowerCase(),
    captureMethod: 'manual',
    allowedPaymentMethodTypes: ['card'],
    paymentMethodCreation: 'manual',
  };
}
export class CheckoutFailure extends Error {
  constructor(readonly code: string) {
    super(
      code === 'PAYMENTS_DISABLED' || code === 'CHECKOUT_UNAVAILABLE'
        ? 'Online payment is not available right now.'
        : code === 'VALIDATION_ERROR'
          ? 'Check your contact, pickup and payment information.'
          : code === 'INVALID_PICKUP_DATE'
            ? 'Choose an available pickup date.'
            : code === 'UNAUTHORIZED'
              ? 'Your Cart is not available. Return to the store.'
              : code === 'UNSUPPORTED_BROWSER'
                ? 'This browser cannot safely submit payment. Please use a current browser.'
                : code === 'PAYMENT_DETAILS'
                  ? 'Check your payment details in the secure payment form.'
                  : code === 'CART_CONFLICT' ||
                      code === 'RESERVATION_EXPIRED' ||
                      code === 'DROP_NOT_OPEN'
                    ? 'Your Cart or pickup availability changed. Review the latest status.'
                    : recoveryMessage,
    );
  }
}
export function parseCheckout(value: unknown): CheckoutSnapshot {
  const v = record(value);
  const cart = v.cart === null ? null : parseCart(v.cart);
  const p = v.payment === null ? null : payment(v.payment);
  if (typeof v.available !== 'boolean' || !Number.isFinite(v.serverNow))
    throw new Error();
  let summary = null;
  if (v.summary !== null) {
    const s = record(v.summary);
    if (
      !cart ||
      s.currency !== 'USD' ||
      s.tax !== 0 ||
      s.fees !== 0 ||
      s.subtotal !== total(cart, 'priceCents') ||
      s.total !== s.subtotal
    )
      throw new Error();
    summary = {
      currency: 'USD' as const,
      subtotal: s.subtotal as number,
      tax: 0 as const,
      fees: 0 as const,
      total: s.total as number,
    };
  }
  return {
    cart,
    payment: p,
    etag: cart ? revision(v.etag) : null,
    paymentEtag: p ? revision(v.paymentEtag) : null,
    summary,
    serverNow: Number(v.serverNow),
    available:
      v.available && !!cart && cart.status === 'ACTIVE' && !p && !!summary,
    drop: v.drop as CheckoutSnapshot['drop'],
  };
}
function identity(now: number) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const random = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `v1.${Math.floor(now)}.${random}`;
}
export class CheckoutClient {
  private busy = false;
  private deadline?: string;
  private attempt?: string;
  constructor(
    private lock: Lock | null,
    private store: MarkerStore | null,
    private request: typeof fetch = (input, init) => fetch(input, init),
  ) {}
  private async call(
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) {
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 12000);
    const began = performance.now();
    try {
      const response = await this.request(path, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
        ...(body === undefined
          ? {}
          : {
              headers: { 'Content-Type': 'application/json', ...headers },
              body: JSON.stringify(body),
            }),
      });
      const text = await response.text();
      if (
        text.length > 65536 ||
        !/^application\/json(?:\s*;|$)/i.test(
          response.headers.get('content-type') ?? '',
        )
      )
        throw new Error();
      const data = record(JSON.parse(text));
      if (!response.ok)
        throw new CheckoutFailure(
          typeof data.code === 'string' ? data.code : 'RECOVERY_REQUIRED',
        );
      if (typeof data.serverNow === 'number')
        data.serverNow += performance.now() - began + 1000;
      return data;
    } catch (error) {
      throw error instanceof CheckoutFailure
        ? error
        : new CheckoutFailure('RECOVERY_REQUIRED');
    } finally {
      clearTimeout(timer);
    }
  }
  private async read() {
    const value = parseCheckout(await this.call('/api/checkout'));
    if (value.payment) {
      if (
        this.attempt === value.payment.paymentAttemptId &&
        this.deadline !== value.payment.paymentDeadline
      )
        throw new CheckoutFailure('RECOVERY_REQUIRED');
      this.attempt = value.payment.paymentAttemptId;
      this.deadline = value.payment.paymentDeadline;
    }
    if (value.cart && !value.payment) {
      try {
        if (
          !this.lock ||
          !this.store ||
          this.store.getItem(markerKey(value.cart.cartId))
        )
          value.available = false;
      } catch {
        value.available = false;
      }
    }
    return value;
  }
  restore() {
    return this.lock ? this.lock(() => this.read()) : this.read();
  }
  async submit(
    expected: CheckoutSnapshot,
    contact: Customer,
    pickup: string,
    stripe: Pick<Stripe, 'createConfirmationToken'>,
    elements: Pick<StripeElements, 'submit'>,
  ) {
    if (this.busy) throw new CheckoutFailure('RECOVERY_REQUIRED');
    if (!this.lock || !this.store)
      throw new CheckoutFailure('UNSUPPORTED_BROWSER');
    this.busy = true;
    try {
      return await this.lock(async () => {
        const c = customer(contact),
          pickupDate = date(pickup);
        const current = await this.read();
        if (
          !current.available ||
          !current.cart ||
          current.cart.cartId !== expected.cart?.cartId ||
          current.etag !== expected.etag ||
          current.summary?.total !== expected.summary?.total ||
          !current.drop?.pickupDates.some(
            (p) => p.date === pickupDate && pickupAllowed(p, current.serverNow),
          )
        )
          throw new CheckoutFailure('CART_CONFLICT');
        const marker = markerKey(current.cart.cartId);
        try {
          this.store!.setItem(marker, 'unresolved');
          if (this.store!.getItem(marker) !== 'unresolved') throw new Error();
        } catch {
          throw new CheckoutFailure('UNSUPPORTED_BROWSER');
        }
        // Only explicit submission reaches Elements validation and token creation.
        let token: string;
        try {
          if ((await elements.submit()).error)
            throw new CheckoutFailure('PAYMENT_DETAILS');
          const result = await stripe.createConfirmationToken({
            elements: elements as StripeElements,
          });
          if (result.error || !result.confirmationToken)
            throw new CheckoutFailure('PAYMENT_DETAILS');
          token = result.confirmationToken.id;
        } catch {
          this.store!.removeItem(marker); // No backend start was sent.
          throw new CheckoutFailure('PAYMENT_DETAILS');
        }
        const body = startBody({
          confirmationTokenId: token,
          pickupDate,
          customer: c,
        });
        const key = identity(current.serverNow);
        try {
          await this.call('/api/checkout/start', body, {
            'If-Match': current.etag!,
            'Idempotency-Key': key,
          });
        } catch (error) {
          // Only explicit, non-ambiguous rejection permits a later customer submission.
          if (
            error instanceof CheckoutFailure &&
            [
              'PAYMENTS_DISABLED',
              'CHECKOUT_UNAVAILABLE',
              'VALIDATION_ERROR',
              'INVALID_PICKUP_DATE',
              'RESERVATION_EXPIRED',
              'DROP_NOT_OPEN',
              'STOREFRONT_CONFLICT',
              'PRODUCT_NOT_AVAILABLE',
              'QUANTITY_LIMIT_EXCEEDED',
            ].includes(error.code)
          )
            this.store!.removeItem(marker);
          // Never retry the start or mint another token. UI performs a separate read.
          throw error;
        }
        return this.read();
      });
    } finally {
      this.busy = false;
    }
  }
  async authenticate(stripe: Pick<Stripe, 'handleNextAction'>) {
    if (this.busy || !this.lock) throw new CheckoutFailure('RECOVERY_REQUIRED');
    this.busy = true;
    try {
      return await this.lock(async () => {
        const current = await this.read(),
          p = current.payment;
        if (
          !p ||
          p.status !== 'action_required' ||
          !p.clientSecret ||
          Date.parse(p.paymentDeadline) <= current.serverNow
        )
          return current;
        // Browser outcome is never a settlement decision. Secret stays in memory.
        const action = await stripe
          .handleNextAction({ clientSecret: p.clientSecret })
          .catch(() => ({ error: true }));
        const next = await this.read();
        // Webhooks normally advance this automatically. Conditional wake-up only if
        // the same attempt still requests action after the browser interaction.
        if (
          !action.error &&
          next.payment?.status === 'action_required' &&
          next.payment.paymentAttemptId === p.paymentAttemptId &&
          next.payment.continuationGeneration > 0 &&
          Date.parse(next.payment.paymentDeadline) > next.serverNow
        ) {
          try {
            await this.call(
              '/api/checkout/continue',
              { continuationGeneration: next.payment.continuationGeneration },
              {
                'If-Match': next.paymentEtag!,
                'Idempotency-Key': identity(next.serverNow),
              },
            );
          } catch {
            /* A conflict/ambiguous wake-up is resolved by GET, never reconfirm. */
          }
          return this.read();
        }
        return next;
      });
    } finally {
      this.busy = false;
    }
  }
}
