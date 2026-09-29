import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  paymentMessageSchema,
  type PaymentMessage,
} from './payment-execution-domain';
export function paymentDispatch() {
  const client = new SQSClient({ maxAttempts: 1 });
  return async (message: PaymentMessage, timeoutMs = 1000) => {
    const parsed = paymentMessageSchema.parse(message);
    const due = Date.parse(parsed.SK.split('#')[0]);
    await client.send(
      new SendMessageCommand({
        QueueUrl: process.env.PAYMENT_QUEUE_URL ?? '',
        MessageBody: JSON.stringify(parsed),
        DelaySeconds: Math.min(
          900,
          Math.max(0, Math.ceil((due - Date.now()) / 1000)),
        ),
      }),
      { abortSignal: AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs))) },
    );
  };
}
