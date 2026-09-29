import Stripe from 'stripe';
import {
  confirmationTokenId,
  intentId,
  createParameters,
  metadataSchema,
  providerStatus,
} from './payment-execution-domain';
import {
  ProviderError,
  type PaymentReader,
  type PaymentProvider,
  type IntentSnapshot,
  type CreateIntentCommand,
  type ConfirmIntentCommand,
} from './payment-provider';

// Matches the generated API types in stripe@22.6.2. Never use the account default.
export const STRIPE_API_VERSION = '2026-08-26.dahlia' as const;
export type StripeTransport = Pick<
  Stripe,
  'paymentIntents' | 'confirmationTokens'
>;
export function stripeClient(key: string, httpClient?: Stripe.HttpClient) {
  if (!/^rk_test_[A-Za-z0-9]+$/.test(key))
    throw new ProviderError('PROVIDER_INVALID');
  return new Stripe(key, {
    apiVersion: STRIPE_API_VERSION,
    maxNetworkRetries: 0,
    timeout: 3000,
    ...(httpClient ? { httpClient } : {}),
  });
}
function snapshot(p: Stripe.PaymentIntent): IntentSnapshot {
  if (
    p.livemode !== false ||
    p.capture_method !== 'manual' ||
    p.confirmation_method !== 'manual' ||
    p.payment_method_types.length !== 1 ||
    p.payment_method_types[0] !== 'card'
  )
    throw new ProviderError('PROVIDER_INVALID');
  return {
    id: intentId.parse(p.id),
    status: providerStatus.parse(p.status),
    amountCents: p.amount,
    amountReceivedCents: p.amount_received,
    amountCapturableCents: p.amount_capturable,
    currency: p.currency,
    captureMethod: 'manual',
    confirmationMethod: 'manual',
    livemode: false,
    metadata: metadataSchema.parse(p.metadata),
    paymentFailed: !!p.last_payment_error,
  };
}
async function safe<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    // Never retain/copy raw SDK errors: request bodies can contain submission secrets.
    throw new ProviderError(
      e instanceof ProviderError ? e.code : 'PROVIDER_UNKNOWN',
    );
  }
}
export class StripePaymentReader implements PaymentReader {
  constructor(protected readonly stripe: StripeTransport) {}
  retrieveConfirmationToken(id: string) {
    return safe(async () => {
      const t = await this.stripe.confirmationTokens.retrieve(
        confirmationTokenId.parse(id),
      );
      if (
        t.id !== id ||
        t.livemode ||
        t.payment_method_preview?.type !== 'card' ||
        !t.expires_at ||
        t.setup_future_usage
      )
        throw new ProviderError('PROVIDER_INVALID');
      return {
        id: t.id,
        livemode: false as const,
        expiresAt: t.expires_at * 1000,
        paymentIntent: t.payment_intent,
        setupIntent: t.setup_intent,
        type: 'card' as const,
      };
    });
  }
  retrieveIntent(id: string) {
    return safe(async () => {
      const p = await this.stripe.paymentIntents.retrieve(intentId.parse(id));
      if (p.id !== id) throw new ProviderError('PROVIDER_INVALID');
      return snapshot(p);
    });
  }
  customerAction(id: string) {
    return safe(async () => {
      const p = await this.stripe.paymentIntents.retrieve(intentId.parse(id));
      if (p.id !== id) throw new ProviderError('PROVIDER_INVALID');
      return {
        intent: snapshot(p),
        clientSecret: p.status === 'requires_action' ? p.client_secret : null,
      };
    });
  }
}
export class StripePaymentProvider
  extends StripePaymentReader
  implements PaymentProvider
{
  createIntent(c: CreateIntentCommand) {
    return safe(async () => {
      const p = createParameters.parse(c.parameters);
      if (
        c.idempotencyKey !== `payment-create:${p.metadata.paymentAttemptId}` ||
        c.paymentAttemptId !== p.metadata.paymentAttemptId ||
        c.orderId !== p.metadata.orderId ||
        c.amountCents !== p.amountCents ||
        c.currency !== p.currency
      )
        throw new ProviderError('PROVIDER_INVALID');
      return snapshot(
        await this.stripe.paymentIntents.create(
          {
            amount: p.amountCents,
            currency: p.currency,
            capture_method: p.captureMethod,
            confirmation_method: p.confirmationMethod,
            payment_method_types: p.paymentMethodTypes,
            metadata: p.metadata,
            confirm: false,
          },
          { idempotencyKey: c.idempotencyKey },
        ),
      );
    });
  }
  confirmIntent(c: ConfirmIntentCommand) {
    return safe(async () => {
      if (
        !Number.isInteger(c.confirmationSequence) ||
        c.confirmationSequence < 0 ||
        c.idempotencyKey !==
          `payment-confirm:${c.paymentAttemptId}:${c.confirmationSequence}` ||
        (c.confirmationSequence === 0) !== !!c.confirmationTokenId
      )
        throw new ProviderError('PROVIDER_INVALID');
      return snapshot(
        await this.stripe.paymentIntents.confirm(
          intentId.parse(c.intentId),
          {
            use_stripe_sdk: true,
            ...(c.confirmationTokenId
              ? {
                  confirmation_token: confirmationTokenId.parse(
                    c.confirmationTokenId,
                  ),
                }
              : {}),
          },
          { idempotencyKey: c.idempotencyKey },
        ),
      );
    });
  }
  async captureIntent(): Promise<IntentSnapshot> {
    throw new ProviderError('PHASE_DISABLED');
  }
  async cancelIntent(): Promise<IntentSnapshot> {
    throw new ProviderError('PHASE_DISABLED');
  }
}
