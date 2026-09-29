import { monitoringSchema } from './payment-metrics';
import { z } from 'zod';
import { hash } from './cart-domain';
import { idSchema } from './domain';
import { canonicalTime, expiryShard } from './cart-expiry';

export const confirmationTokenId = z
  .string()
  .regex(/^ctoken_[a-zA-Z0-9]+$/)
  .max(255);
export const intentId = z
  .string()
  .regex(/^pi_[a-zA-Z0-9]+$/)
  .max(255);
export const providerStatus = z.enum([
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'processing',
  'requires_capture',
  'succeeded',
  'canceled',
]);
export const stages = z.enum([
  'CREATE_INTENT',
  'BIND_INTENT',
  'CONFIRM',
  'WAIT_FOR_CUSTOMER_ACTION',
  'VERIFY_AUTHORIZATION',
  'CLAIM_CAPTURE',
  'CAPTURE',
  'VERIFY_CAPTURE',
  'FINALIZE_ORDER',
  'RESOLVE_FAILURE',
  'CANCEL',
  'RECOVERY_REQUIRED',
]);
export const metadataSchema = z.strictObject({
  environment: z.literal('dev'),
  cartId: idSchema,
  orderId: idSchema,
  paymentAttemptId: idSchema,
  dropId: idSchema,
});
export const createParameters = z.strictObject({
  amountCents: z.number().int().min(50).max(99999999),
  currency: z.literal('usd'),
  captureMethod: z.literal('manual'),
  confirmationMethod: z.literal('manual'),
  paymentMethodTypes: z.tuple([z.literal('card')]),
  metadata: metadataSchema,
});
export const RETRY_HORIZON_MS = 23 * 3600000; // Local safety cutoff, not a Stripe retention guarantee.
export const commandSchema = z
  .strictObject({
    id: z.string().max(200),
    kind: z.enum(['CREATE', 'CONFIRM']),
    generation: z.number().int().nonnegative(),
    createdAt: canonicalTime,
    preparedAt: canonicalTime.optional(),
    retryUntil: canonicalTime,
    state: z.enum(['PREPARED', 'DISPATCHED', 'OBSERVED']),
    dispatchedAt: canonicalTime.optional(),
    observedAt: canonicalTime.optional(),
    outcome: providerStatus.optional(),
    intentId: intentId.optional(),
  })
  .refine(
    (c) =>
      Date.parse(c.retryUntil) - Date.parse(c.createdAt) === RETRY_HORIZON_MS &&
      (c.state === 'PREPARED' ? !c.dispatchedAt : !!c.dispatchedAt),
    'Invalid command timing',
  );
export const financialCommandSchema = z
  .strictObject({
    id: z.string().max(200),
    kind: z.enum(['CAPTURE', 'CANCEL']),
    intentId,
    amountCents: z.number().int().positive(),
    currency: z.literal('usd'),
    finalCapture: z.literal(true),
    preparedAt: canonicalTime,
    retryUntil: canonicalTime,
    state: z.enum(['PREPARED', 'DISPATCHED', 'OBSERVED']),
    dispatchedAt: canonicalTime.optional(),
    observedAt: canonicalTime.optional(),
    outcome: z.enum(['SUCCEEDED', 'CANCELED', 'UNKNOWN']).optional(),
  })
  .refine(
    (c) =>
      Date.parse(c.retryUntil) - Date.parse(c.preparedAt) ===
        RETRY_HORIZON_MS &&
      (c.state === 'PREPARED' ? !c.dispatchedAt : !!c.dispatchedAt),
  );
export const captureEvidenceSchema = z.strictObject({
  scope: z.string(),
  intentId,
  amountCents: z.number().int().positive(),
  amountReceivedCents: z.number().int().positive(),
  currency: z.literal('usd'),
  status: z.literal('succeeded'),
  verifiedAt: canonicalTime,
  commandId: z.string(),
});
export const settlementSchema = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  lineDigest: z.string().regex(/^[a-f0-9]{64}$/),
  outcome: z.enum(['PAID', 'EXPIRED', 'FAILED', 'CANCELLED']),
  intentId: intentId.optional(),
  amountCents: z.number().int().positive(),
});
export const workPointer = z.strictObject({
  PK: z.string(),
  SK: z.string(),
  revision: z.number().int().nonnegative(),
});
export const executionSchema = z
  .strictObject({
    scope: z
      .string()
      .regex(/^dev:[a-zA-Z0-9_-]+$/)
      .max(100),
    confirmationTokenId,
    revision: z.number().int().nonnegative(),
    parameters: createParameters,
    create: commandSchema,
    confirmations: z.array(commandSchema).max(8),
    capture: financialCommandSchema.optional(),
    cancel: financialCommandSchema.optional(),
    captureEvidence: captureEvidenceSchema.optional(),
    releaseEvidence: z.enum(['NEVER_DISPATCHED', 'CANCELED']).optional(),
    terminalReason: z.enum(['EXPIRED', 'FAILED', 'CANCELLED']).optional(),
    financialMode: z.enum(['NORMAL', 'CANCEL_ONLY', 'READ_ONLY']).optional(),
    admissionClosedAt: canonicalTime.optional(),
    recoveryRequired: z.literal(true).optional(),
    recoveryStartedAt: canonicalTime.optional(),
    lastVerifiedProviderStatus: providerStatus.optional(),
    lastVerifiedAt: canonicalTime.optional(),
    consecutiveReadFailures: z.number().int().nonnegative().optional(),
    readClaimId: z.string().uuid().optional(),
    recoveryPollCount: z.number().int().nonnegative().optional(),
    nextCheckAt: canonicalTime.optional(),
    intentId: intentId.optional(),
    candidateIntentId: intentId.optional(),
    observedStatus: providerStatus.optional(),
    stage: stages,
    workflow: workPointer,
    recoveryReason: z
      .enum([
        'ASSOCIATION_CONFLICT',
        'RETRY_HORIZON',
        'DEADLINE',
        'PROVIDER_CONFLICT',
        'PROVIDER_UNKNOWN',
        'SETTLEMENT_INVARIANT',
      ])
      .optional(),
  })
  .refine(
    (e) =>
      (!e.capture || e.capture.kind === 'CAPTURE') &&
      (!e.cancel || e.cancel.kind === 'CANCEL') &&
      [e.capture, e.cancel].every(
        (c) =>
          !c ||
          (c.intentId === e.intentId &&
            c.id ===
              `payment-${c.kind.toLowerCase()}:${e.parameters.metadata.paymentAttemptId}` &&
            c.amountCents === e.parameters.amountCents &&
            c.currency === e.parameters.currency),
      ) &&
      (!e.captureEvidence ||
        (!!e.capture &&
          e.capture.state === 'OBSERVED' &&
          e.captureEvidence.commandId === e.capture.id &&
          e.captureEvidence.intentId === e.intentId &&
          e.captureEvidence.scope === e.scope &&
          e.captureEvidence.amountCents === e.parameters.amountCents &&
          e.captureEvidence.amountReceivedCents ===
            e.parameters.amountCents)) &&
      e.create.kind === 'CREATE' &&
      e.create.generation === 0 &&
      e.create.id ===
        `payment-create:${e.parameters.metadata.paymentAttemptId}` &&
      !e.create.intentId &&
      e.workflow.revision === e.revision &&
      e.confirmations.every(
        (c, i) =>
          c.kind === 'CONFIRM' &&
          c.generation === i &&
          c.id ===
            `payment-confirm:${e.parameters.metadata.paymentAttemptId}:${i}` &&
          !!e.intentId &&
          c.intentId === e.intentId,
      ),
    'Invalid immutable command identity',
  );
export type Execution = z.infer<typeof executionSchema>;
export type Command = z.infer<typeof commandSchema>;
export const workflowSchema = z.strictObject({
  monitoring: monitoringSchema.optional(),
  schemaVersion: z.literal(3),
  deadlineType: z.literal('PAYMENT_WORKFLOW'),
  cartId: idSchema,
  paymentAttemptId: idSchema,
  deadline: canonicalTime,
  createdAt: canonicalTime,
  revision: z.number().int().positive(),
  step: stages,
});
export const associationSchema = z.strictObject({
  scope: executionSchema.shape.scope,
  intentId,
  cartId: idSchema,
  orderId: idSchema,
  paymentAttemptId: idSchema,
  environment: z.literal('dev'),
  createdAt: canonicalTime,
});
export const associationKey = (scope: string, id: string) => ({
  PK: `STRIPE_PAYMENT_INTENT#${executionSchema.shape.scope.parse(scope)}#${intentId.parse(id)}`,
  SK: 'META',
});
export const paymentMessageSchema = z.strictObject({
  schemaVersion: z.literal(1),
  source: z.literal('batch-and-batter.payment'),
  kind: z.enum(['WORKFLOW', 'STRIPE_EVENT', 'PAYMENT']),
  PK: z.string().regex(/^CART_EXPIRY#V1#0[0-9A-F]$/),
  SK: z.string().max(255),
  revision: z.number().int().nonnegative(),
});
export type PaymentMessage = z.infer<typeof paymentMessageSchema>;
export const paymentMessage = (
  work: z.infer<typeof workPointer>,
  kind: PaymentMessage['kind'] = 'WORKFLOW',
): PaymentMessage => ({
  schemaVersion: 1,
  source: 'batch-and-batter.payment',
  kind,
  PK: work.PK,
  SK: work.SK,
  revision: work.revision,
});
export const paymentEtag = (
  cartUpdatedAt: string,
  attemptUpdatedAt: string,
  revision: number,
) => `"${hash(JSON.stringify([cartUpdatedAt, attemptUpdatedAt, revision]))}"`;
export function command(
  kind: Command['kind'],
  attempt: string,
  generation: number,
  now: number,
  id?: string,
): Command {
  return commandSchema.parse({
    kind,
    generation,
    id:
      kind === 'CREATE'
        ? `payment-create:${attempt}`
        : `payment-confirm:${attempt}:${generation}`,
    createdAt: new Date(now).toISOString(),
    preparedAt: new Date(now).toISOString(),
    retryUntil: new Date(now + RETRY_HORIZON_MS).toISOString(),
    state: 'PREPARED',
    ...(id ? { intentId: id } : {}),
  });
}
export const nextWorkflow = (
  cartId: string,
  attempt: string,
  revision: number,
  step: z.infer<typeof stages>,
  now: number,
  createdAt: string,
  monitoring?: z.infer<typeof monitoringSchema>,
) => {
  const deadline = new Date(now).toISOString();
  return {
    ...workflowSchema.parse({
      ...(monitoring ? { monitoring } : {}),
      schemaVersion: 3,
      deadlineType: 'PAYMENT_WORKFLOW',
      cartId,
      paymentAttemptId: attempt,
      deadline,
      createdAt,
      revision,
      step,
    }),
    PK: `CART_EXPIRY#V1#${expiryShard(cartId)}`,
    SK: `${deadline}#PAYMENT_WORKFLOW#${cartId}#${attempt}`,
  };
};
