import type Stripe from 'stripe';
import {
  refundSnapshot,
  type RefundOperation,
  type RefundProvider,
  type RefundSnapshot,
} from './refund-domain';

// Injected only: no credential loading, environment switch or deployed entrypoint.
export class StripeRefundProvider implements RefundProvider {
  readonly environment = 'dev' as const;
  constructor(
    private stripe: Pick<Stripe, 'accounts' | 'refunds' | 'paymentIntents'>,
    readonly accountId: string,
  ) {
    if (!/^acct_[A-Za-z0-9]+$/.test(accountId))
      throw Error('REFUND_ACCOUNT_INVALID');
  }
  private async identity(o: RefundOperation) {
    if (
      o.accountId !== this.accountId ||
      o.environment !== this.environment ||
      (await this.stripe.accounts.retrieve(null)).id !== this.accountId
    )
      throw Error('REFUND_ACCOUNT_INVALID');
    const p = await this.stripe.paymentIntents.retrieve(o.intentId);
    if (
      p.id !== o.intentId ||
      p.livemode ||
      p.status !== 'succeeded' ||
      p.amount_received !== o.capturedCents ||
      p.amount_capturable !== 0 ||
      p.currency !== o.currency ||
      p.metadata.orderId !== o.orderId ||
      p.metadata.environment !== 'dev'
    )
      throw Error('REFUND_CAPTURE_INVALID');
  }
  private snapshot(r: Stripe.Refund, o: RefundOperation) {
    if (
      r.payment_intent !== o.intentId ||
      r.metadata?.refundOperationId !== o.operationId ||
      r.metadata?.orderId !== o.orderId ||
      r.metadata?.environment !== 'dev'
    )
      throw Error('REFUND_IDENTITY_INVALID');
    return refundSnapshot.parse({
      id: r.id,
      operationId: o.operationId,
      orderId: o.orderId,
      intentId: r.payment_intent,
      accountId: this.accountId,
      environment: 'dev',
      amountCents: r.amount,
      currency: r.currency,
      status: r.status,
    });
  }
  async create(o: RefundOperation) {
    await this.identity(o);
    let refunded = 0,
      after: string | undefined,
      complete = false;
    for (let page = 0; page < 20; page++) {
      const list = await this.stripe.refunds.list({
        payment_intent: o.intentId,
        limit: 100,
        ...(after ? { starting_after: after } : {}),
      });
      for (const r of list.data) {
        if (
          r.status === 'pending' ||
          r.status === 'requires_action' ||
          !r.status
        )
          throw Error('REFUND_PRIOR_PENDING');
        if (r.status === 'succeeded') refunded += r.amount;
      }
      if (!list.has_more) {
        complete = true;
        break;
      }
      if (!list.data.length) break;
      after = list.data.at(-1)!.id;
    }
    if (
      !complete ||
      refunded !== o.previousRefundedCents ||
      refunded + o.amountCents > o.capturedCents
    )
      throw Error('REFUND_PRIOR_CONFLICT');
    return this.snapshot(
      await this.stripe.refunds.create(
        {
          payment_intent: o.intentId,
          amount: o.amountCents,
          metadata: {
            refundOperationId: o.operationId,
            orderId: o.orderId,
            environment: 'dev',
          },
        },
        { idempotencyKey: o.idempotencyKey, maxNetworkRetries: 0 },
      ),
      o,
    );
  }
  async reconcile(o: RefundOperation) {
    await this.identity(o);
    if (o.providerId)
      return this.snapshot(await this.stripe.refunds.retrieve(o.providerId), o);
    // Bounded complete traversal. Never use the truncated refunds embedded in Charge.
    let after: string | undefined;
    let found: RefundSnapshot | null = null;
    for (let page = 0; page < 20; page++) {
      const r = await this.stripe.refunds.list({
        payment_intent: o.intentId,
        limit: 100,
        ...(after ? { starting_after: after } : {}),
      });
      for (const item of r.data)
        if (item.metadata?.refundOperationId === o.operationId) {
          if (found) throw Error('REFUND_DUPLICATE_PROVIDER_ID');
          found = this.snapshot(item, o);
        }
      if (!r.has_more) return found;
      if (!r.data.length) throw Error('REFUND_INCOMPLETE_PROVIDER_HISTORY');
      after = r.data.at(-1)!.id;
    }
    throw Error('REFUND_INCOMPLETE_PROVIDER_HISTORY');
  }
}
export class MockStripeRefundProvider implements RefundProvider {
  readonly environment = 'dev' as const;
  readonly refunds = new Map<string, RefundSnapshot>();
  calls = 0;
  loseAcknowledgement = false;
  unavailable = false;
  initialStatus: RefundSnapshot['status'] = 'pending';
  constructor(readonly accountId = 'acct_SYNTHETIC') {}
  async create(o: RefundOperation) {
    this.calls++;
    if (!this.refunds.has(o.operationId))
      this.refunds.set(o.operationId, {
        id: 're_' + o.operationId.replaceAll('-', ''),
        operationId: o.operationId,
        orderId: o.orderId,
        intentId: o.intentId,
        accountId: this.accountId,
        environment: 'dev',
        amountCents: o.amountCents,
        currency: o.currency,
        status: this.initialStatus,
      });
    if (this.loseAcknowledgement) throw Error('SYNTHETIC_LOST_ACK');
    return this.refunds.get(o.operationId)!;
  }
  async reconcile(o: RefundOperation) {
    if (this.unavailable) throw Error('SYNTHETIC_UNAVAILABLE');
    return this.refunds.get(o.operationId) ?? null;
  }
}
