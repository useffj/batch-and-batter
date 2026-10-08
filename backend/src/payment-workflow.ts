import {
  paymentDiagnostic,
  paymentDiagnosticState,
} from './payment-diagnostics';
import { monitoringProjection } from './payment-metrics';
// Dependency-injected coordinator: provider credentials and deployment wiring stay in entrypoints.
import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import {
  cartKey,
  cartSchema,
  CartError,
  sameCapability,
  freshKey,
  parseKey,
  hash,
} from './cart-domain';
import { expiryShard } from './cart-expiry';
import {
  attemptKey,
  orderKey,
  orderSchema,
  paymentAttemptSchema,
  workflowWorkSchema,
} from './payment-domain';
import {
  associationKey,
  associationSchema,
  executionSchema,
  nextWorkflow,
  command,
  workflowSchema,
  paymentMessageSchema,
  paymentMessage,
  paymentEtag,
  type Execution,
  type PaymentMessage,
} from './payment-execution-domain';
import {
  ProviderError,
  type IntentSnapshot,
  type PaymentProvider,
  type PaymentReader,
} from './payment-provider';

type Attempt = z.infer<typeof paymentAttemptSchema>;
type Actions = NonNullable<TransactWriteCommandInput['TransactItems']>;
export type PaymentClient = Pick<DynamoDBDocumentClient, 'send'>;
export class WorkflowError extends Error {
  constructor(
    readonly code:
      | 'STALE_WORK'
      | 'INVALID_AUTHORITY'
      | 'PAYMENT_BUSY'
      | 'LEGACY_PAYMENT_CONTRACT',
  ) {
    super(code);
  }
}
export function requireExecutable(e: Execution): asserts e is Execution & {
  parameters: Execution['parameters'] & { confirmationMethod: 'automatic' };
} {
  if (e.parameters.confirmationMethod !== 'automatic')
    throw new WorkflowError('LEGACY_PAYMENT_CONTRACT');
  if (e.parameters.captureMethod !== 'manual')
    throw new WorkflowError('INVALID_AUTHORITY');
}
export function legacyTerminal(a: Attempt) {
  return (
    a.execution?.parameters.confirmationMethod === 'manual' &&
    ['EXPIRED', 'FAILED', 'CANCELLED', 'CAPTURED'].includes(a.status)
  );
}
export async function readPayment<T>(
  client: PaymentClient,
  table: string,
  key: { PK: string; SK: string },
  schema: z.ZodType<T>,
): Promise<T | undefined> {
  const { Item } = await client.send(
    new GetCommand({
      TableName: table,
      Key: { PK: key.PK, SK: key.SK },
      ConsistentRead: true,
    }),
    { abortSignal: AbortSignal.timeout(1000) },
  );
  if (!Item) return;
  const { PK, SK, ...data } = Item;
  const parsed = schema.safeParse(data);
  if (PK !== key.PK || SK !== key.SK || !parsed.success)
    throw new WorkflowError('INVALID_AUTHORITY');
  return parsed.data;
}
export function validIntent(e: Execution, p: IntentSnapshot) {
  return (
    p.livemode === false &&
    p.captureMethod === 'manual' &&
    p.confirmationMethod === 'automatic' &&
    p.amountCents === e.parameters.amountCents &&
    p.currency === e.parameters.currency &&
    Object.entries(e.parameters.metadata).every(
      ([k, v]) => p.metadata[k as keyof typeof p.metadata] === v,
    ) &&
    (!e.intentId || e.intentId === p.id) &&
    (!e.candidateIntentId || e.candidateIntentId === p.id)
  );
}
export class PaymentWorkflow {
  processFinancialInbox?: (
    receipt: z.infer<typeof import('./stripe-webhook').eventReceiptSchema>,
    message: PaymentMessage,
  ) => Promise<string | undefined>;
  constructor(
    readonly client: PaymentClient,
    readonly commerce: string,
    readonly operations: string,
    readonly provider: PaymentProvider,
    readonly scope: string,
    readonly now = () => Date.now(),
    readonly dispatch?: (message: PaymentMessage) => Promise<void>,
  ) {}
  async attempt(id: string) {
    return readPayment(
      this.client,
      this.commerce,
      attemptKey(id),
      paymentAttemptSchema,
    );
  }
  async load(message: PaymentMessage) {
    paymentMessageSchema.parse(message);
    const work = await readPayment(
      this.client,
      this.operations,
      message,
      z.union([workflowWorkSchema, workflowSchema]),
    );
    if (!work) return;
    if (
      message.kind !== 'WORKFLOW' ||
      message.PK !== `CART_EXPIRY#V1#${expiryShard(work.cartId)}` ||
      message.SK !==
        `${work.deadline}#PAYMENT_WORKFLOW#${work.cartId}#${work.paymentAttemptId}`
    )
      throw new WorkflowError('INVALID_AUTHORITY');
    const a = await this.attempt(work.paymentAttemptId);
    const e = a?.execution;
    if (!a || !e || e.scope !== this.scope || a.cartId !== work.cartId)
      throw new WorkflowError('INVALID_AUTHORITY');
    if (legacyTerminal(a)) return;
    requireExecutable(e);
    if (
      e.workflow.PK !== message.PK ||
      e.workflow.SK !== message.SK ||
      e.workflow.revision !== message.revision ||
      ('revision' in work ? work.revision : 0) !== message.revision
    )
      return;
    if (e.stage !== work.step || e.revision !== message.revision)
      throw new WorkflowError('INVALID_AUTHORITY');
    const cart = await readPayment(
      this.client,
      this.commerce,
      cartKey(a.cartId),
      cartSchema,
    );
    const order = await readPayment(
      this.client,
      this.commerce,
      orderKey(a.orderId),
      orderSchema,
    );
    if (
      !cart ||
      !order ||
      !['PAYMENT_PENDING', 'PAYMENT_COMMITTING'].includes(cart.status) ||
      order.status !== 'PAYMENT_PENDING' ||
      order.paymentStatus !== 'CREATED' ||
      cart.paymentAttemptId !== a.paymentAttemptId ||
      cart.orderId !== a.orderId ||
      cart.dropId !== a.dropId ||
      order.dropId !== a.dropId ||
      order.paymentAttemptId !== a.paymentAttemptId ||
      order.cartId !== a.cartId ||
      order.items.length !== cart.items.length ||
      cart.items.some(
        (line) =>
          !order.items.some(
            (item) =>
              item.productId === line.productId &&
              item.quantity === line.quantity &&
              item.unitPriceCents === line.priceCents &&
              item.cookieUnits === line.cookieUnits,
          ),
      ) ||
      order.totalCents !== a.amountCents ||
      order.currency !== a.currency ||
      e.parameters.amountCents !== a.amountCents ||
      e.parameters.currency !== a.currency ||
      e.parameters.metadata.cartId !== a.cartId ||
      e.parameters.metadata.orderId !== a.orderId ||
      e.parameters.metadata.dropId !== a.dropId ||
      e.parameters.metadata.paymentAttemptId !== a.paymentAttemptId
    )
      throw new WorkflowError('INVALID_AUTHORITY');
    return { a, e, cart, order, work, message };
  }
  async advance(
    state: NonNullable<Awaited<ReturnType<PaymentWorkflow['load']>>>,
    next: Execution,
    status = state.a.status,
    extra: Actions = [],
    delay = 0,
  ) {
    requireExecutable(state.e);
    requireExecutable(next);
    const { a, cart, message, work } = state;
    const immutableCommand = (c: Execution['create']) => ({
      id: c.id,
      kind: c.kind,
      generation: c.generation,
      createdAt: c.createdAt,
      preparedAt: c.preparedAt,
      retryUntil: c.retryUntil,
      intentId: c.intentId,
    });
    if (
      next.scope !== state.e.scope ||
      next.confirmationTokenId !== state.e.confirmationTokenId ||
      JSON.stringify(next.parameters) !== JSON.stringify(state.e.parameters) ||
      JSON.stringify(immutableCommand(next.create)) !==
        JSON.stringify(immutableCommand(state.e.create)) ||
      (state.e.intentId && state.e.intentId !== next.intentId) ||
      next.confirmations.length < state.e.confirmations.length ||
      state.e.confirmations.some(
        (c, i) =>
          JSON.stringify(immutableCommand(c)) !==
          JSON.stringify(immutableCommand(next.confirmations[i])),
      )
    )
      throw new WorkflowError('INVALID_AUTHORITY');
    const revision = state.e.revision + 1;
    const nextWork = nextWorkflow(
      a.cartId,
      a.paymentAttemptId,
      revision,
      next.stage,
      this.now() + delay,
      work.createdAt,
      monitoringProjection(next, cart),
    );
    const execution = executionSchema.parse({
      ...next,
      revision,
      workflow: { PK: nextWork.PK, SK: nextWork.SK, revision },
    });
    const updatedAt = new Date(
      Math.max(this.now(), Date.parse(a.updatedAt) + 1),
    ).toISOString();
    const attempt = paymentAttemptSchema.parse({
      ...a,
      status,
      execution,
      updatedAt,
    });
    const condition: {
      ConditionExpression: string;
      ExpressionAttributeNames: Record<string, string>;
      ExpressionAttributeValues: Record<string, unknown>;
    } =
      message.revision === 0
        ? {
            ConditionExpression:
              '#attempt = :attempt AND #created = :created AND #step = :step',
            ExpressionAttributeNames: {
              '#attempt': 'paymentAttemptId',
              '#created': 'createdAt',
              '#step': 'step',
            },
            ExpressionAttributeValues: {
              ':attempt': a.paymentAttemptId,
              ':created': work.createdAt,
              ':step': 'CREATE_INTENT',
            },
          }
        : {
            ConditionExpression: '#revision = :revision',
            ExpressionAttributeNames: { '#revision': 'revision' },
            ExpressionAttributeValues: { ':revision': message.revision },
          };
    const actions: Actions = [
      {
        Put: {
          TableName: this.commerce,
          Item: { ...attempt, ...attemptKey(a.paymentAttemptId) },
          ConditionExpression: '#updated = :updated',
          ExpressionAttributeNames: { '#updated': 'updatedAt' },
          ExpressionAttributeValues: { ':updated': a.updatedAt },
        },
      },
      {
        ConditionCheck: {
          TableName: this.commerce,
          Key: cartKey(cart.cartId),
          ConditionExpression: '#updated = :updated AND #status = :status',
          ExpressionAttributeNames: {
            '#updated': 'updatedAt',
            '#status': 'status',
          },
          ExpressionAttributeValues: {
            ':updated': cart.updatedAt,
            ':status': cart.status,
          },
        },
      },
    ];
    if (nextWork.PK === message.PK && nextWork.SK === message.SK)
      actions.push({
        Put: { TableName: this.operations, Item: nextWork, ...condition },
      });
    else
      actions.push(
        {
          Delete: {
            TableName: this.operations,
            Key: { PK: message.PK, SK: message.SK },
            ...condition,
          },
        },
        {
          Put: {
            TableName: this.operations,
            Item: nextWork,
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
      );
    actions.push(...extra);
    try {
      await this.client.send(
        new TransactWriteCommand({ TransactItems: actions }),
        { abortSignal: AbortSignal.timeout(1500) },
      );
    } catch (error) {
      paymentDiagnostic('workflowAdvance', error, 'RETHROW');
      throw new WorkflowError('PAYMENT_BUSY');
    }
    // Customer-action polling must not extend the worker's SQS invocation chain.
    // The independent reconciler discovers the durable due-work row instead.
    // Continuation/webhooks still wake non-wait transitions immediately.
    if (execution.stage === 'WAIT_FOR_CUSTOMER_ACTION')
      return execution.workflow;
    // Losing this optimization never deletes durable work.
    try {
      await this.dispatch?.(paymentMessage(execution.workflow));
    } catch {
      /* recovered by future due-work routing */
    }
    return execution.workflow;
  }
  async recover(
    state: NonNullable<Awaited<ReturnType<PaymentWorkflow['load']>>>,
    reason: Execution['recoveryReason'],
  ) {
    return this.advance(state, {
      ...state.e,
      stage: 'RECOVERY_REQUIRED',
      recoveryReason: reason,
    });
  }
  async bind(
    state: NonNullable<Awaited<ReturnType<PaymentWorkflow['load']>>>,
    p: IntentSnapshot,
  ) {
    requireExecutable(state.e);
    if (
      !validIntent(state.e, p) ||
      p.status !== 'requires_payment_method' ||
      p.amountReceivedCents !== 0 ||
      p.amountCapturableCents !== 0
    )
      return this.recover(state, 'PROVIDER_CONFLICT');
    const key = associationKey(this.scope, p.id);
    const prior = await readPayment(
      this.client,
      this.commerce,
      key,
      associationSchema,
    );
    if (prior) return this.recover(state, 'ASSOCIATION_CONFLICT');
    const association = associationSchema.parse({
      scope: this.scope,
      intentId: p.id,
      cartId: state.a.cartId,
      orderId: state.a.orderId,
      paymentAttemptId: state.a.paymentAttemptId,
      environment: 'dev',
      createdAt: new Date(this.now()).toISOString(),
    });
    const next = {
      ...state.e,
      intentId: p.id,
      create: {
        ...state.e.create,
        state: 'OBSERVED' as const,
        observedAt: new Date(this.now()).toISOString(),
        outcome: p.status,
      },
      stage: 'CONFIRM' as const,
      confirmations: [
        command('CONFIRM', state.a.paymentAttemptId, 0, this.now(), p.id),
      ],
    };
    // Binding, reverse association, confirmation authority and successor work commit together.
    return this.advance(state, next, 'CREATED', [
      {
        Put: {
          TableName: this.commerce,
          Item: { ...association, ...key },
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
    ]);
  }
  async observe(
    state: NonNullable<Awaited<ReturnType<PaymentWorkflow['load']>>>,
    p: IntentSnapshot,
  ) {
    requireExecutable(state.e);
    if (!validIntent(state.e, p))
      return this.recover(state, 'PROVIDER_CONFLICT');
    const e = structuredClone(state.e);
    e.observedStatus = p.status;
    if (e.confirmations.length)
      e.confirmations[e.confirmations.length - 1].state = 'OBSERVED';
    let status: Attempt['status'] = 'AUTHENTICATING';
    switch (p.status) {
      case 'requires_action':
        e.stage = 'WAIT_FOR_CUSTOMER_ACTION';
        break;
      case 'requires_confirmation':
      case 'processing':
        e.stage = 'VERIFY_AUTHORIZATION';
        break;
      case 'requires_capture':
        if (
          p.amountCapturableCents !== state.a.amountCents ||
          p.amountReceivedCents !== 0
        )
          return this.recover(state, 'PROVIDER_CONFLICT');
        e.stage = 'CLAIM_CAPTURE';
        status = 'AUTHORIZED';
        break;
      case 'succeeded':
        e.stage = 'FINALIZE_ORDER';
        break;
      case 'requires_payment_method':
      case 'canceled':
        e.stage = 'RESOLVE_FAILURE';
        break;
    }
    return this.advance(state, e, status, [], 15000);
  }
  async run(input: PaymentMessage): Promise<string> {
    const message = paymentMessageSchema.parse(input);
    const state = await this.load(message);
    if (!state) return 'STALE_WORK';
    const { e, a, cart, work } = state;
    paymentDiagnosticState(e, a.paymentAttemptId);
    requireExecutable(e);
    if (Date.parse(work.deadline) > this.now()) return 'NOT_DUE';
    if (
      ![
        'CREATE_INTENT',
        'BIND_INTENT',
        'CONFIRM',
        'VERIFY_AUTHORIZATION',
        'WAIT_FOR_CUSTOMER_ACTION',
      ].includes(e.stage)
    )
      return 'PHASE_5B2B_REQUIRED';
    const activeCommand =
      e.stage === 'CREATE_INTENT'
        ? e.create
        : e.stage === 'CONFIRM'
          ? e.confirmations.at(-1)
          : undefined;
    if (activeCommand && this.now() >= Date.parse(activeCommand.retryUntil)) {
      await this.recover(state, 'RETRY_HORIZON');
      return 'RECOVERY_REQUIRED';
    }
    if (this.now() >= Date.parse(cart.paymentDeadline!)) {
      await this.recover(state, 'DEADLINE');
      return 'PHASE_5B2B_REQUIRED';
    }
    if (e.stage === 'CREATE_INTENT' || e.stage === 'CONFIRM') {
      const c =
        e.stage === 'CREATE_INTENT' ? e.create : e.confirmations.at(-1)!;
      if (!c || this.now() >= Date.parse(c.retryUntil)) {
        await this.recover(state, 'RETRY_HORIZON');
        return 'RECOVERY_REQUIRED';
      }
      if (c.state === 'PREPARED') {
        const next = structuredClone(e);
        const target =
          e.stage === 'CREATE_INTENT'
            ? next.create
            : next.confirmations.at(-1)!;
        target.state = 'DISPATCHED';
        target.dispatchedAt = new Date(this.now()).toISOString();
        const pointer = await this.advance(
          state,
          next,
          e.stage === 'CONFIRM' ? 'AUTHENTICATING' : a.status,
        );
        return this.run(paymentMessage(pointer));
      }
      // Always re-read exact authority before dispatch. No lease expiry implies absence of side effects.
      const current = await this.load(message);
      if (
        !current ||
        this.now() >= Date.parse(current.cart.paymentDeadline!) ||
        this.now() >= Date.parse(c.retryUntil)
      )
        return 'STALE_WORK';
      const shared = {
        paymentAttemptId: a.paymentAttemptId,
        orderId: a.orderId,
        amountCents: a.amountCents,
        currency: a.currency,
        idempotencyKey: c.id,
      };
      if (e.stage === 'CREATE_INTENT') {
        const p = await this.provider.createIntent({
          ...shared,
          parameters: e.parameters,
        });
        if (!validIntent(e, p) || p.status !== 'requires_payment_method') {
          await this.recover(state, 'PROVIDER_CONFLICT');
          return 'RECOVERY_REQUIRED';
        }
        await this.advance(state, {
          ...e,
          candidateIntentId: p.id,
          stage: 'BIND_INTENT',
        });
        return 'CREATED';
      }
      if (!e.intentId || c.intentId !== e.intentId)
        throw new WorkflowError('INVALID_AUTHORITY');
      const canonical = await readPayment(
        this.client,
        this.commerce,
        associationKey(this.scope, e.intentId),
        associationSchema,
      );
      if (
        !canonical ||
        canonical.paymentAttemptId !== a.paymentAttemptId ||
        canonical.cartId !== a.cartId ||
        canonical.orderId !== a.orderId
      ) {
        await this.recover(state, 'ASSOCIATION_CONFLICT');
        return 'RECOVERY_REQUIRED';
      }
      if (
        this.now() >= Date.parse(current.cart.paymentDeadline!) ||
        this.now() >= Date.parse(c.retryUntil)
      ) {
        await this.recover(state, 'DEADLINE');
        return 'PHASE_5B2B_REQUIRED';
      }
      let p: IntentSnapshot;
      try {
        p = await this.provider.confirmIntent({
          ...shared,
          intentId: e.intentId,
          confirmationSequence: c.generation,
          ...(c.generation === 0
            ? { confirmationTokenId: e.confirmationTokenId }
            : {}),
        });
      } catch (error) {
        paymentDiagnostic('providerConfirm', error, 'REREAD');
        // Declines throw in the SDK. Never consume its raw error; retrieve current authority.
        p = await this.provider.retrieveIntent(e.intentId);
        if (
          p.status === 'requires_confirmation' ||
          (p.status === 'requires_payment_method' && !p.paymentFailed)
        )
          throw new ProviderError('PROVIDER_UNKNOWN');
      }
      await this.observe(state, p);
      return p.status;
    }
    if (e.stage === 'BIND_INTENT') {
      if (!e.candidateIntentId) throw new WorkflowError('INVALID_AUTHORITY');
      await this.bind(
        state,
        await this.provider.retrieveIntent(e.candidateIntentId),
      );
      return 'BOUND';
    }
    if (!e.intentId) throw new WorkflowError('INVALID_AUTHORITY');
    await this.observe(state, await this.provider.retrieveIntent(e.intentId));
    return 'OBSERVED';
  }
}

export class PaymentCustomer {
  constructor(
    readonly workflow: Pick<
      PaymentWorkflow,
      | 'client'
      | 'commerce'
      | 'operations'
      | 'scope'
      | 'now'
      | 'attempt'
      | 'load'
      | 'advance'
    >,
    readonly reader: PaymentReader,
  ) {}
  async authorized(cartId: string, tokenHash: string) {
    const w = this.workflow;
    const cart = await readPayment(
      w.client,
      w.commerce,
      cartKey(cartId),
      cartSchema,
    );
    if (
      !sameCapability(cart?.managementTokenHash ?? '0'.repeat(64), tokenHash) ||
      !cart
    )
      throw new CartError('UNAUTHORIZED');
    const a = cart.paymentAttemptId
      ? await w.attempt(cart.paymentAttemptId)
      : undefined;
    if (
      !a?.execution ||
      a.execution.scope !== w.scope ||
      a.cartId !== cartId ||
      a.orderId !== cart.orderId
    )
      throw new CartError('CART_CONFLICT');
    return { cart, a, e: a.execution };
  }
  async get(cartId: string, tokenHash: string) {
    const { cart, a, e } = await this.authorized(cartId, tokenHash);
    let clientSecret: string | null = null;
    const canAct =
      e.parameters.confirmationMethod === 'automatic' &&
      cart.status === 'PAYMENT_PENDING' &&
      !e.admissionClosedAt &&
      !e.recoveryRequired &&
      this.workflow.now() < Date.parse(cart.paymentDeadline!) &&
      e.stage === 'WAIT_FOR_CUSTOMER_ACTION';
    if (canAct && e.intentId) {
      const action = await this.reader.customerAction(e.intentId);
      if (!validIntent(e, action.intent))
        throw new WorkflowError('INVALID_AUTHORITY');
      clientSecret = action.clientSecret;
    }
    return {
      etag: paymentEtag(cart.updatedAt, a.updatedAt, e.revision),
      payment: {
        orderId: a.orderId,
        paymentAttemptId: a.paymentAttemptId,
        status:
          cart.status === 'CONVERTED' && a.status === 'CAPTURED'
            ? 'paid'
            : cart.status === 'EXPIRED'
              ? 'expired'
              : cart.status === 'CANCELLED'
                ? a.status === 'FAILED'
                  ? 'failed'
                  : 'cancelled'
                : canAct
                  ? 'action_required'
                  : e.parameters.confirmationMethod === 'manual'
                    ? 'processing'
                    : e.stage === 'CREATE_INTENT' || e.stage === 'BIND_INTENT'
                      ? 'payment_pending'
                      : 'processing',
        paymentDeadline: cart.paymentDeadline!,
        continuationGeneration: e.confirmations.length,
        ...(clientSecret ? { clientSecret } : {}),
      },
    };
  }
  async confirm(request: {
    cartId: string;
    tokenHash: string;
    ifMatch: string;
    key: string;
    continuationGeneration: number;
  }) {
    const w = this.workflow;
    const { cart, a, e } = await this.authorized(
      request.cartId,
      request.tokenHash,
    );
    requireExecutable(e);
    const key = parseKey(request.key);
    const scope = `cart:v1:confirmPayment:${cart.cartId}:${a.paymentAttemptId}`;
    const receiptKey = {
      PK: `IDEMPOTENCY#${hash(`${scope}:${key.raw}`)}`,
      SK: 'META',
    };
    const fingerprint = hash(
      JSON.stringify([request.ifMatch, request.continuationGeneration]),
    );
    const receiptSchema = z.strictObject({
      scope: z.string(),
      fingerprint: z.string(),
      status: z.literal(202),
      createdAt: z.string(),
    });
    const prior = await readPayment(
      w.client,
      w.operations,
      receiptKey,
      receiptSchema,
    );
    if (prior) {
      if (prior.scope !== scope || prior.fingerprint !== fingerprint)
        throw new CartError('IDEMPOTENCY_CONFLICT');
      return { status: 202 as const };
    }
    freshKey(key.issuedAt, w.now());
    if (
      request.ifMatch !== paymentEtag(cart.updatedAt, a.updatedAt, e.revision)
    )
      throw new CartError('CART_CONFLICT');
    if (
      cart.status !== 'PAYMENT_PENDING' ||
      !!e.admissionClosedAt ||
      !!e.recoveryRequired ||
      w.now() >= Date.parse(cart.paymentDeadline!) ||
      request.continuationGeneration !== e.confirmations.length ||
      request.continuationGeneration >= 8 ||
      !e.intentId ||
      !['WAIT_FOR_CUSTOMER_ACTION', 'VERIFY_AUTHORIZATION'].includes(e.stage) ||
      !e.confirmations.length ||
      e.confirmations.at(-1)?.state !== 'OBSERVED' ||
      !['requires_action', 'requires_confirmation'].includes(
        e.observedStatus ?? '',
      )
    )
      throw new CartError('CART_CONFLICT');
    const p = await this.reader.retrieveIntent(e.intentId);
    if (!validIntent(e, p)) throw new CartError('CART_CONFLICT');
    const state = await w.load(paymentMessage(e.workflow));
    if (
      !state ||
      state.a.updatedAt !== a.updatedAt ||
      w.now() >= Date.parse(cart.paymentDeadline!)
    )
      throw new CartError('CART_CONFLICT');
    try {
      await w.advance(
        state,
        {
          ...e,
          // Stripe owns continuation after customer action; wake canonical reconciliation.
          stage: 'VERIFY_AUTHORIZATION',
        },
        'AUTHENTICATING',
        [
          {
            Put: {
              TableName: w.operations,
              Item: {
                ...receiptKey,
                scope,
                fingerprint,
                status: 202,
                createdAt: new Date(w.now()).toISOString(),
              },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
        ],
      );
    } catch {
      const committed = await readPayment(
        w.client,
        w.operations,
        receiptKey,
        receiptSchema,
      );
      if (
        !committed ||
        committed.scope !== scope ||
        committed.fingerprint !== fingerprint
      )
        throw new CartError('CART_BUSY');
    }
    return { status: 202 as const };
  }
}
