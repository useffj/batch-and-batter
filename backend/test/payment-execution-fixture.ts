import { CartStore, pid, tokenHash } from './cart-store';
import { pickup, dropId } from './fixtures';
import { catalogKeys } from '../src/keys';
import { cartKey, etag } from '../src/cart-domain';
import { PaymentRepository } from '../src/payment-repository';
import { PaymentWorkflow, PaymentCustomer } from '../src/payment-workflow';
import { paymentMessage } from '../src/payment-execution-domain';
import { attemptKey } from '../src/payment-domain';
import { StripeInbox } from '../src/stripe-webhook';
import type {
  PaymentProvider,
  IntentSnapshot,
  CreateIntentCommand,
  ConfirmIntentCommand,
  TokenSnapshot,
} from '../src/payment-provider';
export class FixtureProvider implements PaymentProvider {
  intents = new Map<string, IntentSnapshot>();
  createKeys = new Map<string, string>();
  confirmKeys = new Map<string, IntentSnapshot>();
  calls: { kind: string; key?: string }[] = [];
  outcome: IntentSnapshot['status'] = 'requires_action';
  lostCreate = false;
  lostConfirm = false;
  timeoutCreate = false;
  onCreate?: () => void;
  onConfirm?: () => void;
  tokenResult?: Partial<TokenSnapshot>;
  tokenNow = 0;
  async retrieveConfirmationToken(id: string): Promise<TokenSnapshot> {
    return {
      id,
      livemode: false,
      expiresAt: this.tokenNow + 3600000,
      paymentIntent: null,
      setupIntent: null,
      type: 'card',
      ...this.tokenResult,
    };
  }
  async createIntent(c: CreateIntentCommand) {
    if (
      c.parameters.confirmationMethod !== 'automatic' ||
      c.parameters.captureMethod !== 'manual'
    )
      throw new Error('INVALID_CONFIRMATION_CONFIGURATION');
    this.calls.push({ kind: 'create', key: c.idempotencyKey });
    this.onCreate?.();
    if (this.timeoutCreate) throw new Error('synthetic provider timeout');
    let id = this.createKeys.get(c.idempotencyKey);
    if (!id) {
      id = `pi_Test${this.intents.size + 1}`;
      this.createKeys.set(c.idempotencyKey, id);
      this.intents.set(id, {
        id,
        amountCents: c.amountCents,
        currency: c.currency,
        amountReceivedCents: 0,
        amountCapturableCents: 0,
        status: 'requires_payment_method',
        captureMethod: 'manual',
        confirmationMethod: 'automatic',
        livemode: false,
        metadata: c.parameters.metadata,
      });
    }
    if (this.lostCreate) {
      this.lostCreate = false;
      throw new Error('synthetic lost response');
    }
    return structuredClone(this.intents.get(id)!);
  }
  async retrieveIntent(id: string) {
    this.calls.push({ kind: 'retrieve' });
    return structuredClone(this.intents.get(id)!);
  }
  async customerAction(id: string) {
    return {
      intent: await this.retrieveIntent(id),
      clientSecret:
        this.intents.get(id)?.status === 'requires_action'
          ? 'synthetic-action-secret'
          : null,
    };
  }
  async confirmIntent(c: ConfirmIntentCommand) {
    if (
      c.confirmationSequence !== 0 ||
      !c.confirmationTokenId ||
      this.intents.get(c.intentId)?.confirmationMethod !== 'automatic'
    )
      throw new Error('INVALID_INITIAL_CONFIRMATION');
    this.calls.push({ kind: 'confirm', key: c.idempotencyKey });
    this.onConfirm?.();
    if (!this.confirmKeys.has(c.idempotencyKey)) {
      const p = this.intents.get(c.intentId)!;
      p.status = this.outcome;
      p.amountCapturableCents =
        this.outcome === 'requires_capture' ? p.amountCents : 0;
      p.amountReceivedCents = this.outcome === 'succeeded' ? p.amountCents : 0;
      this.confirmKeys.set(c.idempotencyKey, structuredClone(p));
    }
    if (this.lostConfirm) {
      this.lostConfirm = false;
      throw new Error('synthetic lost response');
    }
    return structuredClone(this.confirmKeys.get(c.idempotencyKey)!);
  }
  async captureIntent(): Promise<IntentSnapshot> {
    throw new Error('CAPTURE_FORBIDDEN');
  }
  async cancelIntent(): Promise<IntentSnapshot> {
    throw new Error('CANCEL_FORBIDDEN');
  }
}
export async function paymentFixture(
  start = true,
  dispatch?: ConstructorParameters<typeof PaymentWorkflow>[6],
  products = 1,
  captureFixture = false,
) {
  const s = new CartStore().seed(products, captureFixture ? 20 : 100);
  if (captureFixture)
    s.row('catalog', catalogKeys.dropProduct(dropId, pid(2)))!.priceCents = 525;
  s.put('catalog', { ...pickup, ...catalogKeys.pickup(dropId, pickup.date) });
  const created = await s.repository().mutate(
    s.request(
      Array.from({ length: products }, (_, i) => ({
        productId: pid(i + 2),
        quantity: captureFixture ? 5 : 2,
      })),
    ),
    { attempts: 0 },
  );
  const client = { send: s.send.bind(s) } as unknown as ConstructorParameters<
    typeof PaymentRepository
  >[0];
  const provider = new FixtureProvider();
  provider.tokenNow = s.now;
  const scope = 'dev:acct_localfixture';
  const repo = new PaymentRepository(
    client,
    'catalog',
    'commerce',
    'operations',
    { fixture: 'DEVELOPMENT_ONLY_ZERO_TAX_ZERO_FEE', currency: 'usd' },
    { now: () => s.now, id: () => pid(++s.sequence) },
    provider,
    scope,
    true,
  );
  const request = {
    cartId: created.cart.cartId,
    tokenHash,
    key: s.keyValue(),
    ifMatch: etag(created.cart.updatedAt),
    confirmationTokenId: 'ctoken_LocalFixture',
    pickupDate: pickup.date,
    customer: {
      name: 'Private Fixture',
      email: 'private@example.test',
      phone: '+15555550123',
      smsTransactionalConsent: false,
    },
  };
  const cart = () => s.row('commerce', cartKey(created.cart.cartId))!;
  const attempt = () => s.row('commerce', attemptKey(cart().paymentAttemptId))!;
  const workflow = new PaymentWorkflow(
    client,
    'commerce',
    'operations',
    provider,
    scope,
    () => s.now,
    dispatch,
  );
  const customer = new PaymentCustomer(workflow, provider);
  const inbox = new StripeInbox(
    client,
    'operations',
    scope,
    () => s.now,
    dispatch,
  );
  const message = () => paymentMessage(attempt().execution.workflow);
  const run = () => workflow.run(message());
  const bind = async () => {
    await run();
    await run();
  };
  if (start) await repo.start(request);
  return {
    s,
    client,
    provider,
    repo,
    request,
    cart,
    attempt,
    workflow,
    customer,
    inbox,
    message,
    run,
    bind,
    scope,
  };
}
