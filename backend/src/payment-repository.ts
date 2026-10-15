import {
  newOrderReference,
  referenceKey,
  orderIndexKeys,
} from './order-reference';
import type { PaymentReader } from './payment-provider';
import {
  command,
  executionSchema,
  paymentMessage,
} from './payment-execution-domain';
import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import {
  CartError,
  cartSchema,
  cartKey,
  cartDto,
  cartDtoSchema,
  etag,
  freshKey,
  hash,
  parseKey,
  sameCapability,
  type Cart,
} from './cart-domain';
import {
  dropSchema,
  pickupSchema,
  productSchema,
  storefrontSchema,
} from './domain';
import { catalogKeys } from './keys';
import { deleteExpiryWork, expiryMessage } from './cart-expiry';
import { generateUlid } from './ulid';
import {
  attemptKey,
  orderKey,
  orderSchema,
  paymentAttemptSchema,
  paymentAmount,
  paymentWork,
  paymentRead,
  startPaymentSchema,
  type CheckoutInput,
  type PaymentPricing,
} from './payment-domain';

type Actions = NonNullable<TransactWriteCommandInput['TransactItems']>;
const acceptedSchema = z.strictObject({
  status: z.literal(201),
  cart: cartDtoSchema,
});
// Receipt deliberately excludes customer/contact information and all provider credentials.
const receiptSchema = z.strictObject({
  operation: z.literal('beginPayment'),
  scope: z.string(),
  fingerprint: z.string(),
  managementTokenHash: z.string(),
  response: acceptedSchema,
  createdAt: z.string(),
  retainUntil: z.number(),
});
export interface PaymentStartRequest extends CheckoutInput {
  cartId: string;
  tokenHash: string;
  key: string;
  ifMatch: string;
}
export class PaymentRepository {
  constructor(
    private readonly client: Pick<DynamoDBDocumentClient, 'send'>,
    private readonly catalog: string,
    private readonly commerce: string,
    private readonly operations: string,
    private readonly pricing: PaymentPricing,
    private readonly runtime = { now: () => Date.now(), id: generateUlid },
    private readonly provider?: Pick<
      PaymentReader,
      'retrieveConfirmationToken'
    >,
    private readonly providerScope = 'dev:local',
    private readonly admissionEnabled = false,
    private readonly dispatch?: (
      message: import('./payment-execution-domain').PaymentMessage,
    ) => Promise<void>,
  ) {
    if (!catalog || !commerce || !operations)
      throw new Error('Payment tables required');
  }
  private async read<T>(
    table: string,
    key: { PK: string; SK: string },
    schema: z.ZodType<T>,
  ): Promise<T | undefined> {
    const { Item } = await this.client.send(
      new GetCommand({ TableName: table, Key: key, ConsistentRead: true }),
      { abortSignal: AbortSignal.timeout(1000) },
    );
    if (!Item) return undefined;
    const { PK, SK, ...data } = Item;
    if (PK !== key.PK || SK !== key.SK) throw new CartError('INTERNAL_ERROR');
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new CartError('INTERNAL_ERROR');
    return parsed.data;
  }
  private async authorized(id: string, tokenHash: string): Promise<Cart> {
    const cart = await this.read(this.commerce, cartKey(id), cartSchema);
    if (
      !sameCapability(cart?.managementTokenHash ?? '0'.repeat(64), tokenHash) ||
      !cart
    )
      throw new CartError('UNAUTHORIZED');
    return cart;
  }
  async get(id: string, tokenHash: string) {
    return paymentRead(
      await this.authorized(id, tokenHash),
      this.runtime.now(),
    );
  }
  async start(request: PaymentStartRequest) {
    const input = startPaymentSchema.parse({
      confirmationTokenId: request.confirmationTokenId,
      pickupDate: request.pickupDate,
      customer: request.customer,
    });
    const key = parseKey(request.key);
    const scope = `cart:v1:beginPayment:${request.cartId}`;
    const receiptKey = {
      PK: `IDEMPOTENCY#${hash(`${scope}:${key.raw}`)}`,
      SK: 'META',
    };
    const fingerprint = hash(
      JSON.stringify({
        cartId: request.cartId,
        confirmationTokenId: input.confirmationTokenId,
        pickupDate: input.pickupDate,
        customer: input.customer,
        ifMatch: request.ifMatch,
      }),
    );
    const replay = async () => {
      const receipt = await this.read(
        this.operations,
        receiptKey,
        receiptSchema,
      );
      if (!receipt) return;
      if (!sameCapability(receipt.managementTokenHash, request.tokenHash))
        throw new CartError('UNAUTHORIZED');
      if (receipt.scope !== scope || receipt.fingerprint !== fingerprint)
        throw new CartError('IDEMPOTENCY_CONFLICT');
      return receipt.response;
    };
    const prior = await replay();
    if (prior) return prior;
    if (!this.admissionEnabled) throw new CartError('PAYMENTS_DISABLED');
    freshKey(key.issuedAt, this.runtime.now());
    const cart = await this.authorized(request.cartId, request.tokenHash);
    if (cart.paymentGraceUsed) throw new CartError('PAYMENT_ALREADY_STARTED');
    if (cart.status !== 'ACTIVE') throw new CartError('CART_CONFLICT');
    if (this.runtime.now() >= Date.parse(cart.shoppingExpiresAt))
      throw new CartError('RESERVATION_EXPIRED');
    if (request.ifMatch !== etag(cart.updatedAt))
      throw new CartError('CART_CONFLICT');
    const drop = await this.read(
      this.catalog,
      catalogKeys.drop(cart.dropId),
      dropSchema,
    );
    if (
      !drop ||
      drop.dropId !== cart.dropId ||
      drop.status !== 'OPEN' ||
      this.runtime.now() < Date.parse(drop.opensAt)
    )
      throw new CartError('DROP_NOT_OPEN');
    const storefront = await this.read(
      this.catalog,
      catalogKeys.storefront,
      storefrontSchema,
    );
    if (storefront?.storefrontDropId !== cart.dropId)
      throw new CartError('STOREFRONT_CONFLICT');
    const pickupKey = catalogKeys.pickup(cart.dropId, input.pickupDate);
    const pickup = await this.read(this.catalog, pickupKey, pickupSchema);
    if (
      !pickup ||
      pickup.dropId !== cart.dropId ||
      pickup.date !== input.pickupDate ||
      !pickup.active
    )
      throw new CartError('INVALID_PICKUP_DATE');
    const pickupEligible = () => {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: pickup.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(new Date(this.runtime.now()));
      const value = (type: string) => parts.find((p) => p.type === type)!.value;
      return (
        `${value('year')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}` <
        `${pickup.date}T${pickup.endTime}`
      );
    };
    if (!pickupEligible()) throw new CartError('INVALID_PICKUP_DATE');
    const items = [];
    for (const line of cart.items) {
      const product = await this.read(
        this.catalog,
        catalogKeys.product(line.productId),
        productSchema,
      );
      if (!product || product.productId !== line.productId)
        throw new CartError('PRODUCT_NOT_AVAILABLE');
      // Name is a fulfillment snapshot; accepted Cart price/quantity/units remain authoritative.
      items.push({
        productId: line.productId,
        name: product.name,
        quantity: line.quantity,
        unitPriceCents: line.priceCents,
        cookieUnits: line.cookieUnits,
      });
    }
    if (!pickupEligible()) throw new CartError('INVALID_PICKUP_DATE');
    if (!this.provider) throw new CartError('INTERNAL_ERROR');
    let submission;
    try {
      submission = await this.provider.retrieveConfirmationToken(
        input.confirmationTokenId,
      );
    } catch {
      throw new CartError('VALIDATION_ERROR');
    }
    const now = this.runtime.now();
    if (
      submission.id !== input.confirmationTokenId ||
      submission.livemode !== false ||
      submission.type !== 'card' ||
      submission.expiresAt <= now ||
      submission.paymentIntent ||
      submission.setupIntent
    )
      throw new CartError('VALIDATION_ERROR');
    if (!pickupEligible()) throw new CartError('INVALID_PICKUP_DATE');
    freshKey(key.issuedAt, now);
    if (now >= Date.parse(cart.shoppingExpiresAt))
      throw new CartError('RESERVATION_EXPIRED');
    const started = new Date(now).toISOString();
    const revision = new Date(
      Math.max(now, Date.parse(cart.updatedAt) + 1),
    ).toISOString();
    const paymentAttemptId = this.runtime.id(),
      orderId = this.runtime.id();
    const next = cartSchema.parse({
      ...cart,
      status: 'PAYMENT_PENDING',
      updatedAt: revision,
      paymentGraceUsed: true,
      paymentStartedAt: started,
      paymentDeadline: new Date(now + 240000).toISOString(),
      paymentAttemptId,
      orderId,
    });
    const amount = paymentAmount(cart, this.pricing);
    const initialWork = paymentWork(next).workflow;
    const execution = executionSchema.parse({
      scope: this.providerScope,
      confirmationTokenId: input.confirmationTokenId,
      revision: 0,
      parameters: {
        amountCents: amount.totalCents,
        currency: amount.currency,
        captureMethod: 'manual',
        confirmationMethod: 'automatic',
        paymentMethodTypes: ['card'],
        metadata: {
          environment: 'dev',
          cartId: cart.cartId,
          orderId,
          paymentAttemptId,
          dropId: cart.dropId,
        },
      },
      create: command('CREATE', paymentAttemptId, 0, now),
      confirmations: [],
      stage: 'CREATE_INTENT',
      workflow: { PK: initialWork.PK, SK: initialWork.SK, revision: 0 },
    });
    const attempt = paymentAttemptSchema.parse({
      execution,
      paymentAttemptId,
      cartId: cart.cartId,
      orderId,
      dropId: cart.dropId,
      status: 'CREATED',
      amountCents: amount.totalCents,
      currency: amount.currency,
      createdAt: started,
      updatedAt: started,
    });
    const displayOrderNumber = newOrderReference();
    const order = orderSchema.parse({
      displayOrderNumber,
      ...orderIndexKeys({
        orderId,
        dropId: cart.dropId,
        createdAt: started,
        pickup,
      }),
      orderId,
      cartId: cart.cartId,
      dropId: cart.dropId,
      status: 'PAYMENT_PENDING',
      paymentStatus: 'CREATED',
      paymentAttemptId,
      items,
      ...amount,
      customer: input.customer,
      pickup: {
        ...pickup,
        location: drop.pickupLocation,
        instructions: drop.pickupInstructions,
      },
      createdAt: started,
      updatedAt: started,
    });
    const work = paymentWork(next);
    const response = { status: 201 as const, cart: cartDto(next) };
    const newPut = (
      table: string,
      item: Record<string, unknown>,
    ): Actions[number] => ({
      Put: {
        TableName: table,
        Item: item,
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    });
    const actions: Actions = [
      {
        ConditionCheck: {
          TableName: this.catalog,
          Key: catalogKeys.drop(cart.dropId),
          ConditionExpression:
            'attribute_exists(PK) AND #status = :open AND #updated = :expected',
          ExpressionAttributeNames: {
            '#status': 'status',
            '#updated': 'updatedAt',
          },
          ExpressionAttributeValues: {
            ':open': 'OPEN',
            ':expected': drop.updatedAt,
          },
        },
      },
      {
        ConditionCheck: {
          TableName: this.catalog,
          Key: catalogKeys.storefront,
          ConditionExpression: '#storefront = :drop',
          ExpressionAttributeNames: { '#storefront': 'storefrontDropId' },
          ExpressionAttributeValues: { ':drop': cart.dropId },
        },
      },
      {
        ConditionCheck: {
          TableName: this.catalog,
          Key: pickupKey,
          ConditionExpression:
            'attribute_exists(PK) AND #drop = :drop AND #date = :date AND #active = :active AND #start = :start AND #end = :end AND #zone = :zone',
          ExpressionAttributeNames: {
            '#drop': 'dropId',
            '#date': 'date',
            '#active': 'active',
            '#start': 'startTime',
            '#end': 'endTime',
            '#zone': 'timezone',
          },
          ExpressionAttributeValues: {
            ':drop': cart.dropId,
            ':date': pickup.date,
            ':active': true,
            ':start': pickup.startTime,
            ':end': pickup.endTime,
            ':zone': pickup.timezone,
          },
        },
      },
      {
        Put: {
          TableName: this.commerce,
          Item: { ...next, ...cartKey(cart.cartId) },
          ConditionExpression:
            'attribute_exists(PK) AND #status = :active AND #updated = :expected AND #token = :token AND attribute_not_exists(#grace) AND #expires > :now',
          ExpressionAttributeNames: {
            '#status': 'status',
            '#updated': 'updatedAt',
            '#token': 'managementTokenHash',
            '#grace': 'paymentGraceUsed',
            '#expires': 'shoppingExpiresAt',
          },
          ExpressionAttributeValues: {
            ':active': 'ACTIVE',
            ':expected': cart.updatedAt,
            ':token': request.tokenHash,
            ':now': started,
          },
        },
      },
      newPut(this.commerce, { ...attempt, ...attemptKey(paymentAttemptId) }),
      newPut(this.commerce, { ...order, ...orderKey(orderId) }),
      deleteExpiryWork(
        this.operations,
        expiryMessage(cart.cartId, cart.shoppingExpiresAt),
      ),
      newPut(this.operations, work.deadline),
      newPut(this.operations, work.workflow),
      newPut(this.operations, {
        ...receiptKey,
        operation: 'beginPayment',
        scope,
        fingerprint,
        managementTokenHash: request.tokenHash,
        response,
        createdAt: started,
        retainUntil: Math.ceil((now + 7 * 86400000) / 1000),
      }),
      newPut(this.commerce, {
        PK: `STRIPE_SUBMISSION#${hash(`${this.providerScope}:${input.confirmationTokenId}`)}`,
        SK: 'META',
        paymentAttemptId,
        cartId: cart.cartId,
        orderId,
        createdAt: started,
      }),
      newPut(this.commerce, { ...referenceKey(displayOrderNumber), orderId }),
    ];
    try {
      await this.client.send(
        new TransactWriteCommand({ TransactItems: actions }),
        { abortSignal: AbortSignal.timeout(1500) },
      );
      for (const [row, kind] of [
        [work.workflow, 'WORKFLOW'],
        [work.deadline, 'PAYMENT'],
      ] as const) {
        try {
          await this.dispatch?.(paymentMessage({ ...row, revision: 0 }, kind));
        } catch {
          /* durable work remains authoritative */
        }
      }
      return response;
    } catch (error) {
      const committed = await replay();
      if (committed) return committed;
      const latest = await this.authorized(cart.cartId, request.tokenHash);
      if (latest.paymentGraceUsed)
        throw new CartError('PAYMENT_ALREADY_STARTED');
      const reasons = (error as { CancellationReasons?: { Code?: string }[] })
        ?.CancellationReasons;
      if (reasons?.length === actions.length) {
        const codes = [
          'DROP_NOT_OPEN',
          'STOREFRONT_CONFLICT',
          'INVALID_PICKUP_DATE',
          'CART_CONFLICT',
        ] as const;
        for (let i = 0; i < 4; i++)
          if (reasons[i].Code === 'ConditionalCheckFailed')
            throw new CartError(codes[i]);
      }
      if (
        reasons?.length === actions.length &&
        reasons[10]?.Code === 'ConditionalCheckFailed'
      )
        throw new CartError('VALIDATION_ERROR');
      // No unsafe rebase or new IDs after ambiguity; replay authority resolves the winner.
      throw new CartError('CART_BUSY');
    }
  }
}
