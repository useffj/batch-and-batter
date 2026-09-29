import { monitoringProjection } from './payment-metrics';
// Local-only financial coordinator. No environment/client creation or deployed entrypoint imports.
import {
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  PaymentWorkflow,
  readPayment,
  validIntent,
  WorkflowError,
  type PaymentClient,
} from './payment-workflow';
import { cartKey, cartSchema, hash, type Cart } from './cart-domain';
import { inventorySchema } from './domain';
import { catalogKeys } from './keys';
import {
  attemptKey,
  orderKey,
  orderSchema,
  paymentAttemptSchema,
  paymentWork,
  paymentWorkSchema,
  modelCommitting,
} from './payment-domain';
import {
  associationKey,
  associationSchema,
  executionSchema,
  financialCommandSchema,
  nextWorkflow,
  paymentMessage,
  paymentMessageSchema,
  RETRY_HORIZON_MS,
  type Execution,
  type PaymentMessage,
} from './payment-execution-domain';
import type { IntentSnapshot, PaymentProvider } from './payment-provider';

type State = NonNullable<Awaited<ReturnType<PaymentWorkflow['load']>>>;
type Actions = NonNullable<TransactWriteCommandInput['TransactItems']>;
type Outcome = 'PAID' | 'EXPIRED' | 'FAILED' | 'CANCELLED';
const iso = (n: number) => new Date(n).toISOString();
const updated = (old: string, now: number) =>
  iso(Math.max(Date.parse(old) + 1, now));
const guard = (fields: Record<string, unknown>) => ({
  ConditionExpression: Object.keys(fields)
    .map((k) => `#${k} = :${k}`)
    .join(' AND '),
  ExpressionAttributeNames: Object.fromEntries(
    Object.keys(fields).map((k) => [`#${k}`, k]),
  ),
  ExpressionAttributeValues: Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [`:${k}`, v]),
  ),
});
export const recoveryDelay = (count: number, random: () => number) => {
  const base = [60000, 120000, 300000, 900000][Math.min(3, Math.max(0, count))];
  return Math.min(
    900000,
    Math.floor(base * (1 + Math.max(0, Math.min(1, random())) * 0.2)),
  );
};
export const paidEventKey = (id: string) => ({
  PK: `ORDER_EVENT#${id}#PAID`,
  SK: 'META',
});
export const paidEventSchema = z.strictObject({
  schemaVersion: z.literal(1),
  eventType: z.literal('PAID'),
  orderId: z.string(),
  cartId: z.string(),
  paymentAttemptId: z.string(),
  dropId: z.string(),
  settlementId: z.string(),
  createdAt: z.string(),
});
export function settlementIdentity(cart: Cart, e: Execution, outcome: Outcome) {
  const lineDigest = hash(
    JSON.stringify(
      [...cart.items]
        .sort((a, b) => a.productId.localeCompare(b.productId))
        .map((i) => [i.productId, i.quantity]),
    ),
  );
  return {
    id: hash(
      JSON.stringify([
        cart.cartId,
        cart.dropId,
        cart.orderId,
        cart.paymentAttemptId,
        e.scope,
        e.intentId ?? null,
        e.parameters.amountCents,
        e.parameters.currency,
        lineDigest,
        outcome,
      ]),
    ),
    lineDigest,
    outcome,
    ...(e.intentId ? { intentId: e.intentId } : {}),
    amountCents: e.parameters.amountCents,
  };
}
export function paymentRecoveryProjection(
  cart: Cart,
  a: z.infer<typeof paymentAttemptSchema>,
  now: number,
) {
  const e = a.execution!;
  return {
    orderId: a.orderId,
    cartId: a.cartId,
    paymentAttemptId: a.paymentAttemptId,
    intentId: e.intentId,
    stage: e.stage,
    financialMode: e.financialMode ?? 'NORMAL',
    lastVerifiedProviderStatus: e.lastVerifiedProviderStatus,
    lastVerifiedAt: e.lastVerifiedAt,
    committingDeadline: cart.committingDeadline,
    recoveryStartedAt: e.recoveryStartedAt,
    recoveryAgeMs: e.recoveryStartedAt
      ? Math.max(0, now - Date.parse(e.recoveryStartedAt))
      : 0,
    errorCategory: e.recoveryReason,
    nextCheckAt: e.nextCheckAt,
  };
}
export type FinancialLog = (event: {
  operation: string;
  outcome: string;
  cartId: string;
  orderId: string;
  paymentAttemptId: string;
  stage: string;
  revision: number;
  errorCategory?: string;
}) => void;
export class FinancialWorkflow extends PaymentWorkflow {
  constructor(
    client: PaymentClient,
    commerce: string,
    operations: string,
    provider: PaymentProvider,
    scope: string,
    readonly catalog: string,
    now = () => Date.now(),
    dispatch?: (m: PaymentMessage) => Promise<void>,
    readonly random = () => Math.random(),
    readonly sleep = (ms: number) =>
      new Promise<void>((r) => setTimeout(r, ms)),
    readonly log: FinancialLog = (event) => console.info(JSON.stringify(event)),
  ) {
    super(client, commerce, operations, provider, scope, now, dispatch);
  }
  private event(s: State, operation: string, outcome: string) {
    this.log({
      operation,
      outcome,
      cartId: s.a.cartId,
      orderId: s.a.orderId,
      paymentAttemptId: s.a.paymentAttemptId,
      stage: s.e.stage,
      revision: s.e.revision,
      ...(s.e.recoveryReason ? { errorCategory: s.e.recoveryReason } : {}),
    });
  }
  private cartGuard(s: State) {
    return guard({
      updatedAt: s.cart.updatedAt,
      status: s.cart.status,
      paymentAttemptId: s.a.paymentAttemptId,
      orderId: s.a.orderId,
      paymentDeadline: s.cart.paymentDeadline,
    });
  }
  private attemptGuard(s: State) {
    return guard({
      updatedAt: s.a.updatedAt,
      status: s.a.status,
      execution: s.e,
    });
  }
  private orderGuard(s: State) {
    return guard({
      updatedAt: s.order.updatedAt,
      status: 'PAYMENT_PENDING',
      paymentStatus: 'CREATED',
      paymentAttemptId: s.a.paymentAttemptId,
      cartId: s.a.cartId,
      totalCents: s.a.amountCents,
      currency: s.a.currency,
    });
  }
  private workGuard(s: State) {
    return 'revision' in s.work
      ? guard({
          revision: s.work.revision,
          step: s.work.step,
          paymentAttemptId: s.a.paymentAttemptId,
        })
      : guard({
          createdAt: s.work.createdAt,
          step: s.work.step,
          paymentAttemptId: s.a.paymentAttemptId,
        });
  }
  private deadlineDelete(s: State): Actions[number] {
    const w = paymentWork(s.cart).deadline;
    const g = guard({
      cartId: w.cartId,
      paymentAttemptId: w.paymentAttemptId,
      deadline: w.deadline,
      createdAt: w.createdAt,
    });
    return {
      Delete: {
        TableName: this.operations,
        Key: { PK: w.PK, SK: w.SK },
        ...g,
        ConditionExpression: `attribute_not_exists(PK) OR (${g.ConditionExpression})`,
      },
    };
  }
  // All financial transitions compare the complete prior execution map as well as revision.
  async transition(
    s: State,
    next: Execution,
    opts: {
      cart?: Cart;
      status?: State['a']['status'];
      due?: number;
      claim?: boolean;
    } = {},
  ) {
    if (
      s.cart.committingStartedAt &&
      opts.cart &&
      (opts.cart.committingStartedAt !== s.cart.committingStartedAt ||
        opts.cart.committingDeadline !== s.cart.committingDeadline)
    )
      throw new WorkflowError('INVALID_AUTHORITY');
    if (
      next.scope !== s.e.scope ||
      JSON.stringify(next.parameters) !== JSON.stringify(s.e.parameters) ||
      next.confirmationTokenId !== s.e.confirmationTokenId ||
      next.intentId !== s.e.intentId ||
      JSON.stringify(next.create) !== JSON.stringify(s.e.create) ||
      JSON.stringify(
        next.confirmations.map((c) => ({
          ...c,
          state: undefined,
          observedAt: undefined,
          outcome: undefined,
        })),
      ) !==
        JSON.stringify(
          s.e.confirmations.map((c) => ({
            ...c,
            state: undefined,
            observedAt: undefined,
            outcome: undefined,
          })),
        )
    )
      throw new WorkflowError('INVALID_AUTHORITY');
    for (const kind of ['capture', 'cancel'] as const) {
      const old = s.e[kind],
        n = next[kind];
      if (
        old &&
        (!n ||
          [
            'id',
            'intentId',
            'amountCents',
            'currency',
            'preparedAt',
            'retryUntil',
            'finalCapture',
          ].some(
            (k) => old[k as keyof typeof old] !== n[k as keyof typeof n],
          ) ||
          (!!old.dispatchedAt && old.dispatchedAt !== n.dispatchedAt) ||
          (!!old.observedAt && old.observedAt !== n.observedAt) ||
          ['PREPARED', 'DISPATCHED', 'OBSERVED'].indexOf(n.state) <
            ['PREPARED', 'DISPATCHED', 'OBSERVED'].indexOf(old.state))
      )
        throw new WorkflowError('INVALID_AUTHORITY');
    }
    if (
      s.e.captureEvidence &&
      JSON.stringify(next.captureEvidence) !==
        JSON.stringify(s.e.captureEvidence)
    )
      throw new WorkflowError('INVALID_AUTHORITY');
    const revision = s.e.revision + 1;
    const work = nextWorkflow(
      s.a.cartId,
      s.a.paymentAttemptId,
      revision,
      next.stage,
      opts.due ?? this.now(),
      s.work.createdAt,
      monitoringProjection(next, opts.cart ?? s.cart),
    );
    const e = executionSchema.parse({
      ...next,
      revision,
      workflow: { PK: work.PK, SK: work.SK, revision },
    });
    const a = paymentAttemptSchema.parse({
      ...s.a,
      status: opts.status ?? s.a.status,
      execution: e,
      updatedAt: updated(s.a.updatedAt, this.now()),
    });
    const actions: Actions = [
      opts.cart
        ? {
            Put: {
              TableName: this.commerce,
              Item: { ...cartSchema.parse(opts.cart), ...cartKey(s.a.cartId) },
              ...this.cartGuard(s),
            },
          }
        : {
            ConditionCheck: {
              TableName: this.commerce,
              Key: cartKey(s.a.cartId),
              ...this.cartGuard(s),
            },
          },
      {
        Put: {
          TableName: this.commerce,
          Item: { ...a, ...attemptKey(a.paymentAttemptId) },
          ...this.attemptGuard(s),
        },
      },
    ];
    if (opts.claim)
      actions.push(
        {
          ConditionCheck: {
            TableName: this.commerce,
            Key: orderKey(a.orderId),
            ...this.orderGuard(s),
          },
        },
        this.deadlineDelete(s),
      );
    if (work.PK === s.message.PK && work.SK === s.message.SK)
      actions.push({
        Put: { TableName: this.operations, Item: work, ...this.workGuard(s) },
      });
    else
      actions.push(
        {
          Delete: {
            TableName: this.operations,
            Key: { PK: s.message.PK, SK: s.message.SK },
            ...this.workGuard(s),
          },
        },
        {
          Put: {
            TableName: this.operations,
            Item: work,
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
      );
    try {
      await this.client.send(
        new TransactWriteCommand({ TransactItems: actions }),
      );
    } catch {
      // Lost commit response must not reset timestamps or dispatch from stale authority.
      const current = await this.attempt(a.paymentAttemptId);
      if (
        current?.execution?.revision !== revision ||
        JSON.stringify(current.execution) !== JSON.stringify(e)
      )
        throw new WorkflowError('PAYMENT_BUSY');
    }
    try {
      await this.dispatch?.(paymentMessage(e.workflow));
    } catch {
      /* Durable work owns retry. */
    }
    return e.workflow;
  }
  private committing(s: State) {
    return s.cart.status === 'PAYMENT_COMMITTING'
      ? s.cart
      : modelCommitting(
          s.cart,
          iso(Math.min(this.now(), Date.parse(s.cart.paymentDeadline!))),
        );
  }
  private async association(s: State, p: IntentSnapshot) {
    if (!s.e.intentId || !validIntent(s.e, p)) return false;
    let a: z.infer<typeof associationSchema> | undefined;
    try {
      a = await readPayment(
        this.client,
        this.commerce,
        associationKey(this.scope, s.e.intentId),
        associationSchema,
      );
    } catch (error) {
      if (error instanceof WorkflowError && error.code === 'INVALID_AUTHORITY')
        return false;
      throw error;
    }

    return (
      !!a &&
      a.scope === this.scope &&
      a.intentId === p.id &&
      a.environment === 'dev' &&
      a.cartId === s.a.cartId &&
      a.orderId === s.a.orderId &&
      a.paymentAttemptId === s.a.paymentAttemptId
    );
  }
  private financialCommand(s: State, kind: 'CAPTURE' | 'CANCEL') {
    return financialCommandSchema.parse({
      id: `payment-${kind.toLowerCase()}:${s.a.paymentAttemptId}`,
      kind,
      intentId: s.e.intentId,
      amountCents: s.a.amountCents,
      currency: s.a.currency,
      finalCapture: true,
      preparedAt: iso(this.now()),
      retryUntil: iso(this.now() + RETRY_HORIZON_MS),
      state: 'PREPARED',
    });
  }
  async claimCapture(s: State) {
    if (
      s.e.capture ||
      s.e.cancel ||
      s.e.recoveryRequired ||
      s.e.financialMode === 'CANCEL_ONLY' ||
      s.a.status !== 'AUTHORIZED' ||
      !s.e.intentId
    )
      throw new WorkflowError('INVALID_AUTHORITY');
    const cart = this.committing(s);
    if (this.now() >= Date.parse(cart.committingDeadline!))
      return this.selectCancel(s, 'EXPIRED');
    const pointer = await this.transition(
      s,
      {
        ...s.e,
        stage: 'CAPTURE',
        capture: this.financialCommand(s, 'CAPTURE'),
        admissionClosedAt: s.e.admissionClosedAt ?? iso(this.now()),
        financialMode: 'NORMAL',
      },
      {
        cart: { ...cart, updatedAt: updated(s.cart.updatedAt, this.now()) },
        status: 'CAPTURE_IN_PROGRESS',
        claim: true,
      },
    );
    this.event(s, 'claimCapture', 'CLAIMED');
    return pointer;
  }
  async unknown(
    s: State,
    reason: Execution['recoveryReason'] = 'PROVIDER_UNKNOWN',
    readFailed = false,
    verified?: IntentSnapshot,
  ) {
    const cart = this.committing(s);
    const recoveryStartedAt = s.e.recoveryStartedAt ?? iso(this.now());
    const count = s.e.recoveryPollCount ?? 0;
    const due = this.now() + recoveryDelay(count, this.random);
    const pointer = await this.transition(
      s,
      {
        ...s.e,
        stage: 'RECOVERY_REQUIRED',
        financialMode: 'READ_ONLY',
        admissionClosedAt: s.e.admissionClosedAt ?? iso(this.now()),
        recoveryRequired: true,
        recoveryStartedAt,
        recoveryReason: reason,
        ...(verified
          ? {
              lastVerifiedProviderStatus: verified.status,
              lastVerifiedAt: iso(this.now()),
            }
          : {}),
        consecutiveReadFailures: readFailed
          ? (s.e.consecutiveReadFailures ?? 0) + 1
          : 0,
        recoveryPollCount: count + 1,
        nextCheckAt: iso(due),
      },
      {
        cart: {
          ...cart,
          updatedAt: updated(s.cart.updatedAt, this.now()),
          recoveryRequired: true,
          recoveryReason: 'UNKNOWN_FINANCIAL_OUTCOME',
        },
        due,
      },
    );
    this.event(s, 'paymentUnknownOutcome', reason ?? 'PROVIDER_UNKNOWN');
    return pointer;
  }
  private async readFailure(s: State) {
    if (
      s.cart.status === 'PAYMENT_PENDING' &&
      this.now() < Date.parse(s.cart.paymentDeadline!) &&
      s.e.financialMode !== 'READ_ONLY'
    )
      return this.transition(
        s,
        {
          ...s.e,
          stage: s.e.cancel ? 'CANCEL' : 'VERIFY_AUTHORIZATION',
          consecutiveReadFailures: (s.e.consecutiveReadFailures ?? 0) + 1,
        },
        { due: this.now() + 15000 },
      );
    const cart = this.committing(s);
    if (
      s.e.financialMode === 'READ_ONLY' ||
      this.now() >= Date.parse(cart.committingDeadline!)
    )
      return this.unknown(s, 'PROVIDER_UNKNOWN', true);
    return this.transition(
      s,
      {
        ...s.e,
        stage: s.e.cancel
          ? 'CANCEL'
          : s.e.capture
            ? 'VERIFY_CAPTURE'
            : 'VERIFY_AUTHORIZATION',
        admissionClosedAt: s.e.admissionClosedAt ?? iso(this.now()),
        consecutiveReadFailures: (s.e.consecutiveReadFailures ?? 0) + 1,
      },
      { cart, due: this.now() + 15000 },
    );
  }
  async selectCancel(s: State, reason: 'EXPIRED' | 'FAILED' | 'CANCELLED') {
    if (s.e.captureEvidence) throw new WorkflowError('INVALID_AUTHORITY');
    if (
      s.e.financialMode === 'READ_ONLY' ||
      (s.e.capture && s.e.capture.state !== 'PREPARED')
    )
      return this.unknown(s);
    if (!s.e.intentId) throw new WorkflowError('INVALID_AUTHORITY');
    const pointer = await this.transition(s, {
      ...s.e,
      stage: 'CANCEL',
      financialMode: 'CANCEL_ONLY',
      terminalReason: s.e.terminalReason ?? reason,
      admissionClosedAt: s.e.admissionClosedAt ?? iso(this.now()),
      cancel: s.e.cancel ?? this.financialCommand(s, 'CANCEL'),
    });
    this.event(s, 'paymentCancel', 'PREPARED');
    return pointer;
  }
  // Override the ingress hook: supplied snapshots are wake-ups, never authorization evidence.
  override async observe(s: State, _hint: IntentSnapshot) {
    return this.reconcile(s);
  }
  async reconcile(s: State) {
    if (s.e.releaseEvidence)
      return this.transition(s, { ...s.e, stage: 'RESOLVE_FAILURE' });
    if (s.e.captureEvidence)
      return this.transition(s, { ...s.e, stage: 'FINALIZE_ORDER' });
    if (s.e.nextCheckAt && this.now() < Date.parse(s.e.nextCheckAt))
      return s.e.workflow;
    if (!s.e.intentId) return this.unknown(s);
    // Reserve a durable read slot first. A crash here delays a read; duplicates cannot hot-loop.
    if (s.e.financialMode === 'READ_ONLY') {
      const pointer = await this.transition(
        s,
        {
          ...s.e,
          readClaimId: randomUUID(),
          nextCheckAt: iso(this.now() + 60000),
        },
        { due: this.now() + 60000 },
      );
      const current = await this.load(paymentMessage(pointer));
      if (!current) return pointer;
      s = current;
    }
    let p: IntentSnapshot;
    try {
      p = await this.provider.retrieveIntent(s.e.intentId!);
    } catch {
      return this.readFailure(s);
    }
    if (!(await this.association(s, p)))
      return this.unknown(s, 'ASSOCIATION_CONFLICT');
    const next: Execution = {
      ...s.e,
      lastVerifiedProviderStatus: p.status,
      lastVerifiedAt: iso(this.now()),
      observedStatus: p.status,
      consecutiveReadFailures: 0,
    };
    if (next.confirmations.at(-1)?.state === 'DISPATCHED') {
      next.confirmations = next.confirmations.map((c, i) =>
        i === next.confirmations.length - 1
          ? {
              ...c,
              state: 'OBSERVED',
              observedAt: iso(this.now()),
              outcome: p.status,
            }
          : c,
      );
    }
    this.event(s, 'paymentReconcile', p.status);
    if (p.status === 'succeeded') {
      if (
        !s.e.capture ||
        s.e.capture.state === 'PREPARED' ||
        p.amountReceivedCents !== s.a.amountCents ||
        p.amountCapturableCents !== 0
      )
        return this.unknown(s, 'SETTLEMENT_INVARIANT', false, p);
      next.capture = {
        ...s.e.capture,
        state: 'OBSERVED',
        observedAt: iso(this.now()),
        outcome: 'SUCCEEDED',
      };
      next.captureEvidence = {
        scope: this.scope,
        intentId: p.id,
        amountCents: p.amountCents,
        amountReceivedCents: p.amountReceivedCents,
        currency: 'usd',
        status: 'succeeded',
        verifiedAt: iso(this.now()),
        commandId: s.e.capture.id,
      };
      next.stage = 'FINALIZE_ORDER';
      delete next.nextCheckAt;
      this.event(s, 'verifyCapture', 'VERIFIED');
      return this.transition(s, next);
    }
    if (
      p.amountReceivedCents !== 0 ||
      (p.status === 'requires_capture'
        ? p.amountCapturableCents !== s.a.amountCents
        : p.amountCapturableCents !== 0)
    )
      return this.unknown(s, 'PROVIDER_CONFLICT', false, p);
    if (p.status === 'canceled') {
      delete next.nextCheckAt;
      next.releaseEvidence = 'CANCELED';
      next.stage = 'RESOLVE_FAILURE';
      next.financialMode = 'CANCEL_ONLY';
      next.terminalReason ??=
        this.now() >= Date.parse(s.cart.paymentDeadline!)
          ? 'EXPIRED'
          : 'CANCELLED';
      if (next.cancel?.dispatchedAt)
        next.cancel = {
          ...next.cancel,
          state: 'OBSERVED',
          observedAt: iso(this.now()),
          outcome: 'CANCELED',
        };
      return this.transition(s, next);
    }
    if (s.e.financialMode === 'READ_ONLY')
      return this.unknown(s, s.e.recoveryReason, false, p);
    const deadline =
      s.cart.committingDeadline ??
      iso(Date.parse(s.cart.paymentDeadline!) + 120000);
    if (
      this.now() >= Date.parse(deadline) &&
      (s.e.capture?.state === 'DISPATCHED' ||
        s.e.cancel?.state === 'DISPATCHED' ||
        p.status === 'processing')
    )
      return this.unknown(s);
    if (p.status === 'requires_capture' && !s.e.cancel && !s.e.capture) {
      next.stage = 'CLAIM_CAPTURE';
      this.event(s, 'paymentAuthorized', 'AUTHORIZED');
      return this.transition(s, next, { status: 'AUTHORIZED' });
    }
    if (s.e.capture || s.e.cancel) {
      next.stage = s.e.cancel
        ? 'CANCEL'
        : p.status === 'requires_capture'
          ? 'CAPTURE'
          : 'VERIFY_CAPTURE';
      return this.transition(s, next, { due: this.now() + 15000 });
    }
    if (this.now() >= Date.parse(s.cart.paymentDeadline!)) {
      if (p.status === 'processing')
        return this.transition(
          s,
          { ...next, stage: 'VERIFY_AUTHORIZATION' },
          { cart: this.committing(s), due: this.now() + 15000 },
        );
      return this.selectCancel(s, 'EXPIRED');
    }
    if (p.status === 'requires_payment_method' && p.paymentFailed)
      return this.selectCancel(s, 'FAILED');
    next.stage =
      p.status === 'requires_action'
        ? 'WAIT_FOR_CUSTOMER_ACTION'
        : 'VERIFY_AUTHORIZATION';
    return this.advance(s, next, 'AUTHENTICATING', [], 15000);
  }
  async deadline(message: PaymentMessage) {
    const work = await readPayment(
      this.client,
      this.operations,
      message,
      paymentWorkSchema,
    );
    if (!work) return 'STALE_WORK';
    const a = await this.attempt(work.paymentAttemptId);
    if (!a?.execution) throw new WorkflowError('INVALID_AUTHORITY');
    const s = await this.load(paymentMessage(a.execution.workflow));
    if (!s)
      return (await this.completed(a.paymentAttemptId))
        ? 'COMPLETED'
        : 'STALE_WORK';
    const exact = paymentWork(s.cart).deadline;
    if (
      message.kind !== 'PAYMENT' ||
      message.PK !== exact.PK ||
      message.SK !== exact.SK ||
      work.cartId !== s.a.cartId ||
      work.deadline !== s.cart.paymentDeadline ||
      work.createdAt !== s.cart.paymentStartedAt
    )
      throw new WorkflowError('INVALID_AUTHORITY');
    if (this.now() < Date.parse(work.deadline)) return 'NOT_DUE';
    this.event(s, 'paymentDeadline', 'DUE');
    return this.atDeadline(s);
  }
  private async atDeadline(s: State): Promise<string> {
    if (!s.e.admissionClosedAt) {
      const ptr = await this.transition(s, {
        ...s.e,
        admissionClosedAt: iso(this.now()),
      });
      const current = await this.load(paymentMessage(ptr));
      if (!current) return 'STALE_WORK';
      s = current;
    }
    if (!s.e.intentId) {
      if (
        s.e.create.state === 'PREPARED' &&
        !s.e.candidateIntentId &&
        s.e.confirmations.length === 0
      ) {
        await this.transition(s, {
          ...s.e,
          financialMode: 'CANCEL_ONLY',
          terminalReason: 'EXPIRED',
          releaseEvidence: 'NEVER_DISPATCHED',
          stage: 'RESOLVE_FAILURE',
        });
        return 'SAFE_EXPIRY';
      }
      await this.unknown(s);
      return 'RECOVERY_REQUIRED';
    }
    await this.reconcile(s);
    return 'RECONCILED';
  }
  private async execute(s: State, kind: 'capture' | 'cancel'): Promise<string> {
    const c = s.e[kind];
    if (
      !c ||
      s.e.financialMode === 'READ_ONLY' ||
      (kind === 'capture' &&
        (s.e.cancel || s.e.financialMode === 'CANCEL_ONLY'))
    )
      throw new WorkflowError('INVALID_AUTHORITY');
    if (
      this.now() >= Date.parse(c.retryUntil) ||
      (s.cart.committingDeadline &&
        this.now() >= Date.parse(s.cart.committingDeadline) &&
        c.state !== 'PREPARED')
    ) {
      await this.unknown(s);
      return 'RECOVERY_REQUIRED';
    }
    if (
      kind === 'capture' &&
      this.now() >= Date.parse(s.cart.committingDeadline!)
    ) {
      await this.selectCancel(s, 'EXPIRED');
      return 'CANCEL';
    }
    if (c.state === 'PREPARED') {
      const ptr = await this.transition(s, {
        ...s.e,
        [kind]: { ...c, state: 'DISPATCHED', dispatchedAt: iso(this.now()) },
      });
      const current = await this.load(paymentMessage(ptr));
      if (!current) return 'STALE_WORK';
      return this.execute(current, kind);
    }
    const current = await this.load(s.message);
    if (!current) return 'STALE_WORK';
    // On redelivery always read first: observed success must never prompt another capture.
    const p = await this.provider
      .retrieveIntent(c.intentId)
      .catch(() => undefined);
    if (!p) {
      await this.readFailure(s);
      return 'RECONCILED';
    }
    if (!(await this.association(s, p))) {
      await this.unknown(s, 'ASSOCIATION_CONFLICT');
      return 'RECOVERY_REQUIRED';
    }
    if (p.status === 'succeeded' || p.status === 'canceled') {
      await this.reconcile(s);
      return 'RECONCILED';
    }
    if (kind === 'cancel' && p.amountReceivedCents !== 0) {
      await this.unknown(s, 'PROVIDER_CONFLICT', false, p);
      return 'RECOVERY_REQUIRED';
    }
    if (
      kind === 'capture' &&
      (p.status !== 'requires_capture' ||
        p.amountCapturableCents !== s.a.amountCents ||
        p.amountReceivedCents !== 0)
    ) {
      await this.reconcile(s);
      return 'RECONCILED';
    }
    const fresh = await this.load(s.message);
    if (!fresh) return 'STALE_WORK';
    if (
      (fresh.cart.committingDeadline &&
        this.now() >= Date.parse(fresh.cart.committingDeadline)) ||
      this.now() >= Date.parse(c.retryUntil)
    ) {
      await this.unknown(fresh);
      return 'RECOVERY_REQUIRED';
    }
    const input = {
      paymentAttemptId: s.a.paymentAttemptId,
      orderId: s.a.orderId,
      intentId: c.intentId,
      amountCents: c.amountCents,
      currency: c.currency,
      idempotencyKey: c.id,
    };
    this.event(
      s,
      kind === 'capture' ? 'capturePayment' : 'paymentCancel',
      'DISPATCHED',
    );
    try {
      if (kind === 'capture') await this.provider.captureIntent(input);
      else await this.provider.cancelIntent(input);
    } catch {
      /* Any potentially dispatched result is reconciled, never presumed failure. */
    }
    const after = await this.load(s.message);
    if (after) await this.reconcile(after);
    return 'RECONCILED';
  }
  override async run(input: PaymentMessage): Promise<string> {
    const m = paymentMessageSchema.parse(input);
    if (m.kind === 'PAYMENT') return this.deadline(m);
    const s = await this.load(m);
    if (!s) return 'STALE_WORK';
    if (
      this.now() < Date.parse(s.work.deadline) ||
      (s.e.nextCheckAt && this.now() < Date.parse(s.e.nextCheckAt))
    )
      return 'NOT_DUE';
    if (
      this.now() >= Date.parse(s.cart.paymentDeadline!) &&
      !s.e.admissionClosedAt
    )
      return this.atDeadline(s);
    if (s.e.captureEvidence || s.e.releaseEvidence) return this.settle(s);
    if (
      s.e.stage === 'RECOVERY_REQUIRED' ||
      s.e.financialMode === 'READ_ONLY'
    ) {
      await this.reconcile(s);
      return 'RECONCILED';
    }
    if (s.e.stage === 'CAPTURE') return this.execute(s, 'capture');
    if (s.e.stage === 'CANCEL') return this.execute(s, 'cancel');
    if (s.e.stage === 'CLAIM_CAPTURE') {
      await this.claimCapture(s);
      return 'CLAIMED';
    }
    if (this.now() >= Date.parse(s.cart.paymentDeadline!))
      return this.atDeadline(s);
    if (
      [
        'VERIFY_CAPTURE',
        'FINALIZE_ORDER',
        'RESOLVE_FAILURE',
        'VERIFY_AUTHORIZATION',
        'WAIT_FOR_CUSTOMER_ACTION',
      ].includes(s.e.stage)
    ) {
      await this.reconcile(s);
      return 'RECONCILED';
    }
    return super.run(m);
  }
  override processFinancialInbox = async (
    receipt: z.infer<typeof import('./stripe-webhook').eventReceiptSchema>,
    message: PaymentMessage,
  ): Promise<string | undefined> => {
    const association = await readPayment(
      this.client,
      this.commerce,
      associationKey(this.scope, receipt.intentId),
      associationSchema,
    );
    if (!association) return undefined; // Existing pre-bind durable-create recovery path.
    const a = await this.attempt(association.paymentAttemptId);
    if (
      !a?.execution ||
      a.execution.intentId !== receipt.intentId ||
      a.execution.scope !== receipt.scope ||
      association.cartId !== a.cartId ||
      association.orderId !== a.orderId
    )
      throw new WorkflowError('INVALID_AUTHORITY');
    const eventActions: Actions = [
      {
        Put: {
          TableName: this.operations,
          Item: {
            ...receipt,
            state: 'PROCESSED',
            revision: receipt.revision + 1,
            PK: `EXTERNAL_EVENT#STRIPE#${receipt.eventId}`,
            SK: 'META',
          },
          ...guard({ state: 'RECEIVED', revision: receipt.revision }),
        },
      },
      {
        Delete: {
          TableName: this.operations,
          Key: { PK: message.PK, SK: message.SK },
          ...guard({ revision: message.revision }),
        },
      },
    ];
    if (await this.completed(a.paymentAttemptId)) {
      const p = await this.provider.retrieveIntent(receipt.intentId);
      if (
        !validIntent(a.execution, p) ||
        (a.settlement!.outcome === 'PAID'
          ? p.status !== 'succeeded' ||
            p.amountReceivedCents !== a.amountCents ||
            p.amountCapturableCents !== 0
          : p.status !== 'canceled' || p.amountReceivedCents !== 0)
      )
        throw new WorkflowError('INVALID_AUTHORITY');
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: this.commerce,
                Key: attemptKey(a.paymentAttemptId),
                ...guard({ updatedAt: a.updatedAt, settlement: a.settlement }),
              },
            },
            ...eventActions,
          ],
        }),
      );
      return 'COMPLETED';
    }
    let state = await this.load(paymentMessage(a.execution.workflow));
    if (!state) return 'AWAITING_ASSOCIATION';
    if (!state.e.nextCheckAt || this.now() >= Date.parse(state.e.nextCheckAt)) {
      // Initial confirmation authority must not be replaced by an old created wake-up.
      if (!['CREATE_INTENT', 'BIND_INTENT', 'CONFIRM'].includes(state.e.stage))
        await this.reconcile(state);
      const current = await this.attempt(a.paymentAttemptId);
      state = current?.execution
        ? await this.load(paymentMessage(current.execution.workflow))
        : undefined;
      if (!state) return 'STALE_WORK';
    }
    if (
      (!state.e.nextCheckAt || this.now() >= Date.parse(state.e.nextCheckAt)) &&
      (state.e.captureEvidence || state.e.releaseEvidence)
    )
      return this.settle(state, eventActions);
    await this.client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: this.commerce,
              Key: attemptKey(a.paymentAttemptId),
              ...this.attemptGuard(state),
            },
          },
          {
            ConditionCheck: {
              TableName: this.operations,
              Key: { PK: state.message.PK, SK: state.message.SK },
              ...this.workGuard(state),
            },
          },
          ...eventActions,
        ],
      }),
    );
    return 'TRANSFERRED';
  };
  async completed(id: string) {
    const a = await this.attempt(id);
    if (!a?.settlement || !a.execution) return false;
    const c = await readPayment(
      this.client,
      this.commerce,
      cartKey(a.cartId),
      cartSchema,
    );
    const o = await readPayment(
      this.client,
      this.commerce,
      orderKey(a.orderId),
      orderSchema,
    );
    const mark = a.settlement;
    if (
      !c ||
      !o ||
      a.execution.scope !== this.scope ||
      a.dropId !== c.dropId ||
      o.dropId !== c.dropId ||
      a.amountCents !== a.execution.parameters.amountCents ||
      a.currency !== a.execution.parameters.currency ||
      a.amountCents !== mark.amountCents ||
      a.cartId !== c.cartId ||
      a.orderId !== o.orderId ||
      c.orderId !== o.orderId ||
      c.paymentAttemptId !== id ||
      o.paymentAttemptId !== id ||
      JSON.stringify(c.settlement) !== JSON.stringify(mark) ||
      JSON.stringify(o.settlement) !== JSON.stringify(mark) ||
      JSON.stringify(settlementIdentity(c, a.execution, mark.outcome)) !==
        JSON.stringify(mark) ||
      o.items.length !== c.items.length ||
      c.items.some(
        (line) =>
          !o.items.some(
            (item) =>
              item.productId === line.productId &&
              item.quantity === line.quantity &&
              item.unitPriceCents === line.priceCents &&
              item.cookieUnits === line.cookieUnits,
          ),
      ) ||
      o.totalCents !== a.amountCents ||
      o.currency !== a.currency ||
      (mark.outcome === 'PAID'
        ? c.status !== 'CONVERTED' ||
          o.status !== 'PAID' ||
          o.paymentStatus !== 'CAPTURED' ||
          a.status !== 'CAPTURED'
        : c.status !== (mark.outcome === 'EXPIRED' ? 'EXPIRED' : 'CANCELLED') ||
          o.status !== mark.outcome ||
          o.paymentStatus !== mark.outcome ||
          a.status !== mark.outcome)
    )
      throw new WorkflowError('INVALID_AUTHORITY');
    if (mark.outcome === 'PAID') {
      const out = await readPayment(
        this.client,
        this.operations,
        paidEventKey(o.orderId),
        paidEventSchema,
      );
      if (
        !out ||
        out.settlementId !== mark.id ||
        out.cartId !== c.cartId ||
        out.paymentAttemptId !== id ||
        out.dropId !== c.dropId
      )
        throw new WorkflowError('INVALID_AUTHORITY');
    }
    return true;
  }
  async settle(s: State, eventActions: Actions = []): Promise<string> {
    if (eventActions.length !== 0 && eventActions.length !== 2)
      throw new WorkflowError('INVALID_AUTHORITY');
    const paid = !!s.e.captureEvidence;
    if (
      paid
        ? s.cart.status !== 'PAYMENT_COMMITTING' ||
          s.a.status !== 'CAPTURE_IN_PROGRESS'
        : !s.e.releaseEvidence || !s.e.terminalReason
    )
      throw new WorkflowError('INVALID_AUTHORITY');
    if (
      !paid &&
      (s.e.financialMode !== 'CANCEL_ONLY' ||
        (s.e.releaseEvidence === 'CANCELED'
          ? !s.e.intentId ||
            s.e.lastVerifiedProviderStatus !== 'canceled' ||
            !s.e.lastVerifiedAt
          : s.e.create.state !== 'PREPARED' ||
            !!s.e.intentId ||
            !!s.e.candidateIntentId ||
            s.e.confirmations.length !== 0 ||
            !!s.e.capture ||
            !!s.e.cancel))
    )
      throw new WorkflowError('INVALID_AUTHORITY');
    const outcome: Outcome = paid ? 'PAID' : s.e.terminalReason!;
    const marker = settlementIdentity(s.cart, s.e, outcome);
    for (let attempt = 0; attempt < 3; attempt++) {
      const actions: Actions = [];
      for (const line of [...s.cart.items].sort((a, b) =>
        a.productId.localeCompare(b.productId),
      )) {
        const key = catalogKeys.inventory(s.a.dropId, line.productId);
        let old: z.infer<typeof inventorySchema> | undefined;
        try {
          old = await readPayment(
            this.client,
            this.catalog,
            key,
            inventorySchema,
          );
        } catch (error) {
          if (
            !(error instanceof WorkflowError) ||
            error.code !== 'INVALID_AUTHORITY'
          )
            throw error;
          await this.unknown(s, 'SETTLEMENT_INVARIANT');
          return 'RECOVERY_REQUIRED';
        }
        if (
          !old ||
          old.reserved < line.quantity ||
          old.dropId !== s.a.dropId ||
          old.productId !== line.productId
        ) {
          await this.unknown(s, 'SETTLEMENT_INVARIANT');
          return 'RECOVERY_REQUIRED';
        }
        const next = inventorySchema.parse({
          ...old,
          reserved: old.reserved - line.quantity,
          sold: old.sold + (paid ? line.quantity : 0),
          updatedAt: updated(old.updatedAt, this.now()),
        });
        if (![next.total, next.reserved, next.sold].every(Number.isSafeInteger))
          throw new WorkflowError('INVALID_AUTHORITY');
        actions.push({
          Put: {
            TableName: this.catalog,
            Item: { ...next, ...key },
            ...guard({
              total: old.total,
              reserved: old.reserved,
              sold: old.sold,
              updatedAt: old.updatedAt,
            }),
          },
        });
      }
      const { recoveryRequired: _, recoveryReason: __, ...priorCart } = s.cart;
      const cart = cartSchema.parse({
        ...priorCart,
        status: paid
          ? 'CONVERTED'
          : outcome === 'EXPIRED'
            ? 'EXPIRED'
            : 'CANCELLED',
        settlement: marker,
        updatedAt: updated(s.cart.updatedAt, this.now()),
      });
      const order = orderSchema.parse({
        ...s.order,
        status: outcome,
        paymentStatus: paid ? 'CAPTURED' : outcome,
        settlement: marker,
        updatedAt: updated(s.order.updatedAt, this.now()),
      });
      const a = paymentAttemptSchema.parse({
        ...s.a,
        status: paid ? 'CAPTURED' : outcome,
        settlement: marker,
        updatedAt: updated(s.a.updatedAt, this.now()),
      });
      const cartPut = {
        Put: {
          TableName: this.commerce,
          Item: { ...cart, ...cartKey(a.cartId) },
          ...this.cartGuard(s),
        },
      };
      const orderPut = {
        Put: {
          TableName: this.commerce,
          Item: { ...order, ...orderKey(a.orderId) },
          ...this.orderGuard(s),
        },
      };
      const attemptPut = {
        Put: {
          TableName: this.commerce,
          Item: { ...a, ...attemptKey(a.paymentAttemptId) },
          ...this.attemptGuard(s),
        },
      };
      actions.push(
        cartPut,
        ...(paid ? [orderPut, attemptPut] : [attemptPut, orderPut]),
        this.deadlineDelete(s),
        {
          Delete: {
            TableName: this.operations,
            Key: { PK: s.message.PK, SK: s.message.SK },
            ...this.workGuard(s),
          },
        },
      );
      if (paid)
        actions.push({
          Put: {
            TableName: this.operations,
            Item: {
              ...paidEventKey(a.orderId),
              schemaVersion: 1,
              eventType: 'PAID',
              orderId: a.orderId,
              cartId: a.cartId,
              paymentAttemptId: a.paymentAttemptId,
              dropId: a.dropId,
              settlementId: marker.id,
              createdAt: iso(this.now()),
            },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        });
      actions.push(...eventActions);
      const targets = actions.map((x) => {
        const op = x.Put ?? x.Delete ?? x.ConditionCheck!;
        const k = x.Put?.Item ?? x.Delete?.Key ?? x.ConditionCheck!.Key!;
        return `${op.TableName}|${k.PK}|${k.SK}`;
      });
      if (new Set(targets).size !== targets.length)
        throw new WorkflowError('INVALID_AUTHORITY');
      try {
        await this.client.send(
          new TransactWriteCommand({ TransactItems: actions }),
        );
        this.event(
          s,
          paid ? 'convertCartToOrder' : 'settlePaymentFailure',
          outcome,
        );
        return 'SETTLED';
      } catch (error) {
        try {
          if (await this.completed(a.paymentAttemptId)) return 'COMPLETED';
        } catch (validationError) {
          this.event(s, 'paymentUnknownOutcome', 'SETTLEMENT_INVARIANT');
          throw validationError;
        }
        const reasons = (error as { CancellationReasons?: { Code: string }[] })
          .CancellationReasons;
        const inventoryOnly =
          !!reasons &&
          reasons.some(
            (r, i) =>
              i < s.cart.items.length && r.Code === 'ConditionalCheckFailed',
          ) &&
          reasons.every(
            (r, i) =>
              r.Code === 'None' ||
              (i < s.cart.items.length && r.Code === 'ConditionalCheckFailed'),
          );
        if (!inventoryOnly) {
          if (
            paid &&
            reasons?.[s.cart.items.length + 5]?.Code ===
              'ConditionalCheckFailed'
          ) {
            let exists = false;
            try {
              exists = !!(await readPayment(
                this.client,
                this.operations,
                paidEventKey(a.orderId),
                paidEventSchema,
              ));
            } catch {
              exists = true;
            }
            if (exists) {
              await this.unknown(s, 'SETTLEMENT_INVARIANT');
              return 'RECOVERY_REQUIRED';
            }
          }
          throw new WorkflowError('PAYMENT_BUSY');
        }
        if (attempt < 2) await this.sleep(10 + Math.floor(this.random() * 20));
      }
    }
    await this.transition(
      s,
      { ...s.e, stage: paid ? 'FINALIZE_ORDER' : 'RESOLVE_FAILURE' },
      { due: this.now() + 15000 },
    );
    return 'RESCHEDULED';
  }
}
