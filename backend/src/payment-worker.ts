import { paymentMessageSchema } from './payment-execution-domain';
import type { PaymentWorkflow } from './payment-workflow';
import type { StripeInbox } from './stripe-webhook';
// Factory intentionally absent from all deployed entrypoints/build assets.
export function createPaymentWorker(
  workflow: PaymentWorkflow,
  inbox: StripeInbox,
  queueArn: string,
) {
  return async (event: {
    Records: {
      messageId: string;
      eventSource: string;
      eventSourceARN: string;
      body: string;
    }[];
  }) => {
    const batchItemFailures: { itemIdentifier: string }[] = [];
    for (const record of event.Records) {
      try {
        if (
          record.eventSource !== 'aws:sqs' ||
          record.eventSourceARN !== queueArn ||
          record.body.length > 4096
        )
          throw new Error('INVALID_MESSAGE');
        const message = paymentMessageSchema.parse(JSON.parse(record.body));
        const outcome =
          message.kind !== 'STRIPE_EVENT'
            ? await workflow.run(message)
            : await inbox.process(message, workflow);
        console.info(JSON.stringify({ operation: 'paymentWorkflow', outcome }));
      } catch {
        // Raw exception objects can contain provider request/response secrets.
        console.info(
          JSON.stringify({ operation: 'paymentWorkflow', outcome: 'RETRY' }),
        );
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  };
}
