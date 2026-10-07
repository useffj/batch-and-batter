import { paymentDiagnostic } from './payment-diagnostics';
import { FinancialWorkflow } from './payment-settlement';
import { StripeInbox } from './stripe-webhook';
import { createPaymentWorker } from './payment-worker';
import {
  lazyProvider,
  paymentClient,
  paymentDispatch,
  paymentScope,
} from './payment-runtime';
import { paymentMetrics } from './payment-metrics';
import {
  bestEffortTelemetry,
  paymentTransport,
  type PaymentContext,
} from './payment-transport';
export async function handler(
  event: Parameters<ReturnType<typeof createPaymentWorker>>[0],
  context: PaymentContext = {},
) {
  try {
    const scope = paymentScope(),
      client = paymentClient(),
      dispatch = paymentDispatch();
    const operations = process.env.OPERATIONS_TABLE_NAME ?? '';
    const workflow = new FinancialWorkflow(
      client,
      process.env.COMMERCE_TABLE_NAME ?? '',
      operations,
      lazyProvider(),
      scope,
      process.env.CATALOG_TABLE_NAME ?? '',
      undefined,
      dispatch,
      undefined,
      undefined,
      (entry) => {
        bestEffortTelemetry(() => console.info(JSON.stringify(entry)));
        if (
          entry.outcome === 'SETTLEMENT_INVARIANT' ||
          entry.errorCategory === 'SETTLEMENT_INVARIANT'
        )
          bestEffortTelemetry(() =>
            paymentMetrics('worker', { SettlementInvariantConflict: 1 }),
          );
      },
    );
    const run = createPaymentWorker(
      workflow,
      new StripeInbox(client, operations, scope, undefined, dispatch),
      process.env.PAYMENT_QUEUE_ARN ?? '',
    );
    const result = await run(event, context);
    bestEffortTelemetry(() =>
      paymentMetrics('worker', {
        WorkerBatchFailure: result.batchItemFailures.length,
      }),
    );
    return result;
  } catch (error) {
    bestEffortTelemetry(() =>
      paymentMetrics('worker', { WorkerBatchFailure: event.Records.length }),
    );
    return paymentTransport(event, context, async () => {
      paymentDiagnostic('workerSetup', error, 'RETHROW');
      throw new Error('WORKER_SETUP_FAILED');
    });
  }
}
