import {
  sanitizedPaymentError,
  withPaymentDiagnostics,
} from './payment-diagnostics';
import { paymentMessageSchema } from './payment-execution-domain';
import { WorkflowError } from './payment-workflow';

export type PaymentRecord = {
  messageId: string;
  eventSource: string;
  eventSourceARN: string;
  body: string;
  attributes?: { ApproximateReceiveCount?: string };
};
export type PaymentEvent = { Records: PaymentRecord[] };
export type PaymentContext = { awsRequestId?: string };
export type TransportLog = (entry: Record<string, unknown>) => void;
const log: TransportLog = (entry) => console.info(JSON.stringify(entry));

// Telemetry cannot decide financial or transport outcomes.
export function bestEffortTelemetry(write: () => void) {
  try {
    write();
  } catch {
    // Do not recursively log a logging failure.
  }
}
const outcomes = new Set([
  'STALE_WORK',
  'COMPLETED',
  'SETTLED',
  'NOT_DUE',
  'LEGACY_TERMINAL',
  'CREATED',
  'BOUND',
  'OBSERVED',
  'RECONCILED',
  'TRANSFERRED',
  'QUARANTINED',
  'AWAITING_ASSOCIATION',
  'RECOVERY_REQUIRED',
  'PHASE_5B2B_REQUIRED',
  'SAFE_EXPIRY',
  'CANCEL',
  'CLAIMED',
  'RESCHEDULED',
  'PROVIDER_REQUEST_REJECTED',
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'processing',
  'requires_capture',
  'canceled',
  'succeeded',
]);
const safeId = (value: unknown) =>
  typeof value === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(value)
    ? value
    : null;
function metadata(record: PaymentRecord, context: PaymentContext) {
  const count = record.attributes?.ApproximateReceiveCount;
  const parsedCount =
    typeof count === 'string' && /^[1-9]\d{0,15}$/.test(count)
      ? Number(count)
      : NaN;
  const result = {
    messageId: safeId(record.messageId),
    receiveCount: Number.isSafeInteger(parsedCount) ? parsedCount : null,
    lambdaRequestId: safeId(context.awsRequestId),
    queueArn:
      /^arn:aws(?:-us-gov|-cn)?:sqs:[a-z0-9-]{1,32}:\d{12}:[A-Za-z0-9_-]{1,80}$/.test(
        record.eventSourceARN,
      )
        ? record.eventSourceARN
        : null,
    workType: null as string | null,
    revision: null as number | null,
    cartId: null as string | null,
    attemptId: null as string | null,
  };
  // Never serialize SK, PK, arbitrary attributes, or the original record.
  try {
    if (record.body.length > 4096) return result;
    const parsed = paymentMessageSchema.safeParse(JSON.parse(record.body));
    if (!parsed.success) return result;
    const m = parsed.data;
    result.workType = m.kind;
    result.revision = Number.isSafeInteger(m.revision) ? m.revision : null;
    const parts = m.SK.split('#');
    const id = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
    if (
      m.kind === 'WORKFLOW' &&
      parts.length === 4 &&
      parts[1] === 'PAYMENT_WORKFLOW' &&
      id.test(parts[2]) &&
      id.test(parts[3])
    ) {
      result.cartId = parts[2];
      result.attemptId = parts[3];
    } else if (
      m.kind === 'PAYMENT' &&
      parts.length === 3 &&
      parts[1] === 'PAYMENT' &&
      id.test(parts[2])
    ) {
      result.cartId = parts[2];
    }
  } catch {
    // Malformed bodies are classified by the existing processing boundary.
  }
  return result;
}

export async function paymentTransport(
  event: PaymentEvent,
  context: PaymentContext,
  process: (record: PaymentRecord) => Promise<string>,
  write: TransportLog = log,
) {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    let fields: Record<string, unknown> = {};
    bestEffortTelemetry(() => {
      fields = metadata(record, context);
    });
    bestEffortTelemetry(() =>
      write({ operation: 'paymentTransportDelivery', ...fields }),
    );
    let errorFields: Record<string, unknown> = {};
    let outcome: string;
    let disposition: 'ACK' | 'RETRY';
    try {
      const returned = await withPaymentDiagnostics(fields, write, () =>
        process(record),
      );
      outcome = outcomes.has(returned) ? returned : 'RETURNED';
      disposition = 'ACK';
    } catch (error) {
      errorFields = sanitizedPaymentError(error);
      outcome =
        error instanceof WorkflowError &&
        error.code === 'LEGACY_PAYMENT_CONTRACT'
          ? 'LEGACY_PAYMENT_CONTRACT'
          : 'RETRY';
      disposition = 'RETRY';
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
    bestEffortTelemetry(() =>
      write({
        operation: 'paymentTransportDisposition',
        ...fields,
        outcome,
        ...errorFields,
        disposition,
      }),
    );
  }
  return { batchItemFailures };
}
