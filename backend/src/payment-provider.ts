import type { z } from 'zod';
import type {
  createParameters,
  metadataSchema,
} from './payment-execution-domain';
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
  amountCapturableCents: number;
  currency: string;
  captureMethod: 'manual';
  confirmationMethod: 'automatic';
  metadata: z.infer<typeof metadataSchema>;
  livemode: false;
  paymentFailed?: boolean;
}
export interface TokenSnapshot {
  id: string;
  livemode: false;
  expiresAt: number;
  paymentIntent: string | null;
  setupIntent: string | null;
  type: 'card';
}
export interface PaymentReader {
  retrieveConfirmationToken(id: string): Promise<TokenSnapshot>;
  retrieveIntent(id: string): Promise<IntentSnapshot>;
  customerAction(
    id: string,
  ): Promise<{ intent: IntentSnapshot; clientSecret: string | null }>;
}
export interface AuthorizedPaymentCommand {
  paymentAttemptId: string;
  orderId: string;
  amountCents: number;
  currency: string;
  idempotencyKey: string;
}
export interface CreateIntentCommand extends AuthorizedPaymentCommand {
  parameters: z.infer<typeof createParameters>;
}
export interface ConfirmIntentCommand extends AuthorizedPaymentCommand {
  intentId: string;
  confirmationSequence: number;
  confirmationTokenId?: string;
}
export interface PaymentProvider extends PaymentReader {
  createIntent(command: CreateIntentCommand): Promise<IntentSnapshot>;
  confirmIntent(command: ConfirmIntentCommand): Promise<IntentSnapshot>;
  captureIntent(
    command: AuthorizedPaymentCommand & { intentId: string },
  ): Promise<IntentSnapshot>;
  cancelIntent(
    command: AuthorizedPaymentCommand & { intentId: string },
  ): Promise<IntentSnapshot>;
}
export class ProviderError extends Error {
  constructor(
    readonly code: 'PROVIDER_UNKNOWN' | 'PROVIDER_INVALID' | 'PHASE_DISABLED',
  ) {
    super(code);
  }
}
