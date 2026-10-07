import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { Execution } from './payment-execution-domain';

type Fields = Record<string, unknown>;
const delivery = new AsyncLocalStorage<{
  fields: Fields;
  write: (e: Fields) => void;
}>();
const codes = new Set([
  'STALE_WORK',
  'INVALID_AUTHORITY',
  'PAYMENT_BUSY',
  'LEGACY_PAYMENT_CONTRACT',
  'PROVIDER_UNKNOWN',
  'PROVIDER_INVALID',
  'PHASE_DISABLED',
  'PROVIDER_REQUEST_REJECTED',
]);
const names = new Set([
  'TransactionCanceledException',
  'ConditionalCheckFailedException',
  'TransactionConflictException',
  'ProvisionedThroughputExceededException',
  'ThrottlingException',
  'AccessDeniedException',
  'ResourceNotFoundException',
  'TimeoutError',
  'AbortError',
  'ZodError',
]);
const cancellations = new Set([
  'None',
  'ConditionalCheckFailed',
  'TransactionConflict',
  'ProvisionedThroughputExceeded',
  'ThrottlingError',
  'ValidationError',
  'ItemCollectionSizeLimitExceeded',
]);
export function sanitizedPaymentError(error: unknown): Fields {
  try {
    const e = error as {
      name?: string;
      code?: string;
      $metadata?: { requestId?: string };
      CancellationReasons?: { Code?: string }[];
    } | null;
    return {
      errorClassification: names.has(e?.name ?? '') ? e!.name : 'UNCLASSIFIED',
      errorCode: codes.has(e?.code ?? '') ? e!.code : 'UNKNOWN',
      awsRequestId: /^[a-zA-Z0-9-]{1,100}$/.test(e?.$metadata?.requestId ?? '')
        ? e!.$metadata!.requestId
        : null,
      cancellationCodes: Array.isArray(e?.CancellationReasons)
        ? e.CancellationReasons.slice(0, 100).map((r) =>
            cancellations.has(r?.Code ?? '') ? r.Code : 'UNKNOWN',
          )
        : [],
    };
  } catch {
    return { errorClassification: 'UNCLASSIFIED', errorCode: 'UNKNOWN' };
  }
}
export function withPaymentDiagnostics<T>(
  fields: Fields,
  write: (e: Fields) => void,
  run: () => Promise<T>,
) {
  return delivery.run({ fields, write }, run);
}
export function paymentDiagnosticState(e: Execution, attemptId?: string) {
  try {
    const context = delivery.getStore();
    if (!context) return;
    if (attemptId && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(attemptId))
      context.fields.attemptId = attemptId;
    const command =
      e.stage === 'CREATE_INTENT'
        ? e.create
        : e.stage === 'CONFIRM'
          ? e.confirmations.at(-1)
          : e.stage === 'CAPTURE' || e.stage === 'FINALIZE_ORDER'
            ? e.capture
            : e.stage === 'CANCEL'
              ? e.cancel
              : undefined;
    Object.assign(context.fields, {
      phase: e.stage,
      executionRevision: e.revision,
      // Command IDs are provider idempotency keys: correlate only by digest.
      commandIdSha256: command
        ? createHash('sha256').update(command.id).digest('hex')
        : null,
    });
  } catch {
    /* Diagnostics never affect payment processing. */
  }
}
export function paymentDiagnostic(
  operation:
    | 'workflowAdvance'
    | 'financialTransition'
    | 'transitionReread'
    | 'workerSetup'
    | 'providerConfirm'
    | 'providerRead'
    | 'settlementWrite',
  error: unknown,
  disposition: 'RETHROW' | 'REREAD',
  revisions?: { expectedRevision: number },
) {
  try {
    const context = delivery.getStore();
    context?.write({
      ...context.fields,
      operation,
      ...sanitizedPaymentError(error),
      ...revisions,
      disposition,
    });
  } catch {
    /* Diagnostics never affect payment processing. */
  }
}
