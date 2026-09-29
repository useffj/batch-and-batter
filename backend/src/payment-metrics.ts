import { z } from 'zod';
import { canonicalTime } from './cart-expiry';
import type { Execution } from './payment-execution-domain';
import type { Cart } from './cart-domain';
export const monitoringSchema = z.strictObject({
  committingDeadline: canonicalTime.optional(),
  captureVerifiedAt: canonicalTime.optional(),
  recoveryStartedAt: canonicalTime.optional(),
  consecutiveReadFailures: z.number().int().nonnegative(),
  unknownOutcome: z.boolean(),
});
export function monitoringProjection(e: Execution, cart: Cart) {
  return monitoringSchema.parse({
    ...(cart.committingDeadline
      ? { committingDeadline: cart.committingDeadline }
      : {}),
    ...(e.captureEvidence
      ? { captureVerifiedAt: e.captureEvidence.verifiedAt }
      : {}),
    ...(e.recoveryStartedAt ? { recoveryStartedAt: e.recoveryStartedAt } : {}),
    consecutiveReadFailures: e.consecutiveReadFailures ?? 0,
    unknownOutcome: !!e.recoveryRequired,
  });
}
export function paymentMetrics(
  component: 'worker' | 'webhook' | 'reconciler',
  values: Record<string, number>,
) {
  console.info(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'BatchAndBatter/Payments',
            Dimensions: [['Environment', 'Component']],
            Metrics: Object.keys(values).map((Name) => ({ Name })),
          },
        ],
      },
      Environment: 'dev',
      Component: component,
      ...values,
    }),
  );
}
export function financialGauges() {
  return {
    WorkflowOverdueMs: 0,
    UnknownOutcome: 0,
    CommittingOverdue: 0,
    CapturedUnfinalizedMs: 0,
    ConsecutiveReadFailures: 0,
    RecoveryAgeMs: 0,
  };
}
export function observeFinancial(
  g: ReturnType<typeof financialGauges>,
  row: Record<string, unknown>,
  now: number,
) {
  if (row.deadlineType !== 'PAYMENT_WORKFLOW') return;
  const due = canonicalTime.safeParse(row.deadline);
  if (due.success)
    g.WorkflowOverdueMs = Math.max(
      g.WorkflowOverdueMs,
      now - Date.parse(due.data),
    );
  const parsed = monitoringSchema.safeParse(row.monitoring);
  if (!parsed.success) return; // Legacy V2/V3 work remains readable; next transition adds projection.
  const m = parsed.data;
  g.UnknownOutcome = Math.max(g.UnknownOutcome, Number(m.unknownOutcome));
  g.CommittingOverdue = Math.max(
    g.CommittingOverdue,
    Number(!!m.committingDeadline && now >= Date.parse(m.committingDeadline)),
  );
  g.CapturedUnfinalizedMs = Math.max(
    g.CapturedUnfinalizedMs,
    m.captureVerifiedAt ? now - Date.parse(m.captureVerifiedAt) : 0,
  );
  g.ConsecutiveReadFailures = Math.max(
    g.ConsecutiveReadFailures,
    m.consecutiveReadFailures,
  );
  g.RecoveryAgeMs = Math.max(
    g.RecoveryAgeMs,
    m.recoveryStartedAt ? now - Date.parse(m.recoveryStartedAt) : 0,
  );
}
