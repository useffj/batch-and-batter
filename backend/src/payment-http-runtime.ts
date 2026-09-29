import { localPaymentApi } from './payment-api';
import { PaymentRepository } from './payment-repository';
import { PaymentCustomer, PaymentWorkflow } from './payment-workflow';
import { ProviderError, type PaymentProvider } from './payment-provider';
import {
  lazyReader,
  paymentClient,
  paymentDispatch,
  paymentStartEnabled,
} from './payment-runtime';
import type { ApiEvent } from './api';
// No credentials are loaded by construction. Missing account is a closed bootstrap state.
export function createPaymentHttp() {
  const client = paymentClient(),
    reader = lazyReader(),
    dispatch = paymentDispatch();
  const scope = `dev:${process.env.STRIPE_ACCOUNT_ID ?? ''}`;
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
    { fixture: 'DEVELOPMENT_ONLY_ZERO_TAX_ZERO_FEE', currency: 'usd' },
    undefined,
    reader,
    scope,
    paymentStartEnabled(process.env.PAYMENT_START_ENABLED),
    dispatch,
  );
  const customer = new PaymentCustomer(workflow, reader);
  return (event: ApiEvent) => localPaymentApi(event, repository, customer);
}
