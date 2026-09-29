// Domain port only. Phase 5B1 has no Stripe SDK, runtime implementation or network calls.
export type ProviderStatus =
  | 'requires_payment_method'
  | 'requires_confirmation'
  | 'requires_action'
  | 'processing'
  | 'requires_capture'
  | 'succeeded'
  | 'canceled';
export interface IntentSnapshot {
  id: string;
  status: ProviderStatus;
  amountCents: number;
  amountReceivedCents: number;
  currency: string;
  captureMethod: 'manual';
}
export interface AuthorizedPaymentCommand {
  paymentAttemptId: string;
  orderId: string;
  amountCents: number; // Persisted attempt authority, never request-body amount.
  currency: string;
  idempotencyKey: string; // Backend-generated external command key; never logged.
}
export interface PaymentProvider {
  createIntent(command: AuthorizedPaymentCommand): Promise<IntentSnapshot>;
  retrieveIntent(id: string): Promise<IntentSnapshot>;
  confirmIntent(
    command: AuthorizedPaymentCommand & {
      intentId: string;
      confirmationSequence: number;
    },
  ): Promise<IntentSnapshot>;
  captureIntent(
    command: AuthorizedPaymentCommand & { intentId: string },
  ): Promise<IntentSnapshot>;
  cancelIntent(
    command: AuthorizedPaymentCommand & { intentId: string },
  ): Promise<IntentSnapshot>;
}
