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
export async function handler(
  event: Parameters<ReturnType<typeof createPaymentWorker>>[0],
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
        console.info(JSON.stringify(entry));
        if (
          entry.outcome === 'SETTLEMENT_INVARIANT' ||
          entry.errorCategory === 'SETTLEMENT_INVARIANT'
        )
          paymentMetrics('worker', { SettlementInvariantConflict: 1 });
      },
    );
    const run = createPaymentWorker(
      workflow,
      new StripeInbox(client, operations, scope, undefined, dispatch),
      process.env.PAYMENT_QUEUE_ARN ?? '',
    );
    const result = await run(event);
    paymentMetrics('worker', {
      WorkerBatchFailure: result.batchItemFailures.length,
    });
    return result;
  } catch {
    paymentMetrics('worker', { WorkerBatchFailure: event.Records.length });
    return {
      batchItemFailures: event.Records.map((r) => ({
        itemIdentifier: r.messageId,
      })),
    };
  }
}
