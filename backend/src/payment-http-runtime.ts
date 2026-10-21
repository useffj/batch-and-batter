import { CartError } from './cart-domain';
import { localPaymentApi } from './payment-api';
import { PaymentRepository } from './payment-repository';
import { PaymentCustomer, PaymentWorkflow } from './payment-workflow';
import { ProviderError, type PaymentProvider } from './payment-provider';
import {
  lazyReader,
  paymentClient,
  paymentDispatch,
  paymentScope,
  paymentStartEnabled,
} from './payment-runtime';
import type { ApiEvent } from './api';
// No credentials are loaded by construction. Missing account is a closed bootstrap state.
function createServices() {
  let scope: string;
  try {
    scope = paymentScope();
  } catch {
    throw new CartError('PAYMENT_UNAVAILABLE');
  }
  const client = paymentClient(),
    reader = lazyReader(),
    dispatch = paymentDispatch();
  const catalog = process.env.CATALOG_TABLE_NAME ?? '';
  const commerce = process.env.COMMERCE_TABLE_NAME ?? '';
  const operations = process.env.OPERATIONS_TABLE_NAME ?? '';
  const deny = async (): Promise<never> => {
    throw new ProviderError('PHASE_DISABLED');
  };
  const noCommands: PaymentProvider = {
    ...reader,
    createIntent: deny,
    confirmIntent: deny,
    captureIntent: deny,
    cancelIntent: deny,
  };
  const workflow = new PaymentWorkflow(
    client,
    commerce,
    operations,
    noCommands,
    scope,
    undefined,
    dispatch,
  );
  const repository = new PaymentRepository(
    client,
    catalog,
    commerce,
    operations,
    {
      fixture: 'DEVELOPMENT_ONLY_ZERO_TAX_ZERO_FEE',
      currency: 'usd',
      version: '1',
    },
    undefined,
    reader,
    scope,
    paymentStartEnabled(process.env.PAYMENT_START_ENABLED),
    dispatch,
  );
  const customer = new PaymentCustomer(workflow, reader);
  return { repository, payment: customer };
}
export function createPaymentHttp() {
  let services: ReturnType<typeof createServices> | undefined;
  return (event: ApiEvent) =>
    localPaymentApi(event, () => (services ??= createServices()));
}
