import { SSMClient } from '@aws-sdk/client-ssm';
import { StripeInbox, createStripeWebhook } from './stripe-webhook';
import {
  paymentClient,
  paymentDispatch,
  paymentIdentity,
  secretLoader,
} from './payment-runtime';
import { paymentMetrics } from './payment-metrics';
import type { ApiEvent } from './api';
export function webhookEntrypoint(
  load: () => Promise<string>,
  create: (secret: string) => ReturnType<typeof createStripeWebhook>,
) {
  return async (event: ApiEvent) => {
    try {
      if (
        event.routeKey !== 'POST /webhooks/stripe' ||
        event.requestContext.http.method !== 'POST'
      )
        return { statusCode: 404, body: '{}' };
      const result = await create(await load())(event);
      paymentMetrics('webhook', {
        WebhookDurableAcceptanceFailure: result.statusCode === 503 ? 1 : 0,
      });
      return result;
    } catch {
      paymentMetrics('webhook', { WebhookDurableAcceptanceFailure: 1 });
      return {
        statusCode: 503,
        headers: {
          'cache-control': 'no-store',
          'content-type': 'application/json',
        },
        body: '{"received":false}',
      };
    }
  };
}
const load = secretLoader(
  new SSMClient({ maxAttempts: 1 }),
  process.env.STRIPE_WEBHOOK_SECRET_PARAMETER ?? '',
);
export const handler = webhookEntrypoint(load, (secret) => {
  const { scope, accountId } = paymentIdentity();
  return createStripeWebhook(
    new StripeInbox(
      paymentClient(),
      process.env.OPERATIONS_TABLE_NAME ?? '',
      scope,
      undefined,
      paymentDispatch(),
    ),
    {
      signingSecret: secret,
      scope,
      accountId,
      toleranceSeconds: 300,
    },
  );
});
