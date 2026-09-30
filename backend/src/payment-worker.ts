import { paymentMessageSchema } from './payment-execution-domain';
import type { PaymentWorkflow } from './payment-workflow';
import type { StripeInbox } from './stripe-webhook';
import {
  paymentTransport,
  type PaymentEvent,
  type PaymentContext,
  type TransportLog,
} from './payment-transport';
// Queue factory shared by tests and the dedicated financial entrypoint.
export function createPaymentWorker(
  workflow: PaymentWorkflow,
  inbox: StripeInbox,
  queueArn: string,
  write?: TransportLog,
) {
  return async (event: PaymentEvent, context: PaymentContext = {}) =>
    paymentTransport(
      event,
      context,
      async (record) => {
        if (
          record.eventSource !== 'aws:sqs' ||
          record.eventSourceARN !== queueArn ||
          record.body.length > 4096
        )
          throw new Error('INVALID_MESSAGE');
        const message = paymentMessageSchema.parse(JSON.parse(record.body));
        return message.kind !== 'STRIPE_EVENT'
          ? workflow.run(message)
          : inbox.process(message, workflow);
      },
      write,
    );
}
