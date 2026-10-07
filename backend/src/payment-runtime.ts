import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
export { paymentDispatch } from './payment-dispatch';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  paymentMessageSchema,
  type PaymentMessage,
} from './payment-execution-domain';
import {
  ProviderError,
  type PaymentProvider,
  type PaymentReader,
} from './payment-provider';
import {
  StripePaymentProvider,
  StripePaymentReader,
  stripeClient,
} from './stripe-provider';

export const paymentStartEnabled = (value?: string) => value === 'true';
// Failures are never cached. Values expire, including in warm execution environments.
export function secretLoader(
  client: Pick<SSMClient, 'send'>,
  name: string,
  now = () => Date.now(),
) {
  let cached: { value: string; until: number } | undefined;
  return async () => {
    if (cached && now() < cached.until) return cached.value;
    try {
      if (!name) throw new Error();
      const result = await client.send(
        new GetParameterCommand({ Name: name, WithDecryption: true }),
        { abortSignal: AbortSignal.timeout(2000) },
      );
      if (result.Parameter?.Type !== 'SecureString' || !result.Parameter.Value)
        throw new Error();
      cached = { value: result.Parameter.Value, until: now() + 60000 };
      return cached.value;
    } catch {
      throw new Error('PAYMENT_SECRET_UNAVAILABLE');
    }
  };
}
export function paymentIdentity(env: NodeJS.ProcessEnv = process.env) {
  const account = env.STRIPE_ACCOUNT_ID ?? '';
  const scope = env.STRIPE_LEDGER_NAMESPACE ?? '';
  const ledgerAccount = env.STRIPE_LEDGER_ACCOUNT_ID ?? '';
  if (
    env.STRIPE_ENVIRONMENT !== 'dev' ||
    !/^acct_[A-Za-z0-9]+$/.test(account) ||
    !/^dev:acct_[A-Za-z0-9]+$/.test(scope) ||
    scope.length > 100 ||
    ledgerAccount !== account
  )
    throw new ProviderError('PROVIDER_INVALID');
  // The namespace preserves ledger identity; it never grants Stripe account access.
  return { accountId: account, scope };
}
export function paymentScope() {
  return paymentIdentity().scope;
}
export const paymentClient = () =>
  DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 1 }));
export function lazyReader(): PaymentReader {
  const load = secretLoader(
    new SSMClient({ maxAttempts: 1 }),
    process.env.STRIPE_READ_KEY_PARAMETER ?? '',
  );
  const get = async () => {
    paymentScope();
    return new StripePaymentReader(stripeClient(await load()));
  };
  return {
    retrieveConfirmationToken: async (id) =>
      (await get()).retrieveConfirmationToken(id),
    retrieveIntent: async (id) => (await get()).retrieveIntent(id),
    customerAction: async (id) => (await get()).customerAction(id),
  };
}
export function lazyProvider(): PaymentProvider {
  const load = secretLoader(
    new SSMClient({ maxAttempts: 1 }),
    process.env.STRIPE_WORKER_KEY_PARAMETER ?? '',
  );
  const get = async () => {
    paymentScope();
    return new StripePaymentProvider(stripeClient(await load()));
  };
  return {
    retrieveConfirmationToken: async (id) =>
      (await get()).retrieveConfirmationToken(id),
    retrieveIntent: async (id) => (await get()).retrieveIntent(id),
    customerAction: async (id) => (await get()).customerAction(id),
    createIntent: async (c) => (await get()).createIntent(c),
    confirmIntent: async (c) => (await get()).confirmIntent(c),
    captureIntent: async (c) => (await get()).captureIntent(c),
    cancelIntent: async (c) => (await get()).cancelIntent(c),
  };
}
