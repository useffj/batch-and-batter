import {
  expiryWork,
  expiryKey,
  expiryMessage,
  expiryWorkSchema,
  deleteExpiryWork,
  expiryDelay,
  expiryLog,
  type ExpiryDispatch,
} from './cart-expiry';
import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { catalogKeys } from './keys';
import {
  dropSchema,
  dropProductSchema,
  inventorySchema,
  productSchema,
  storefrontSchema,
  type Drop,
  type Product,
} from './domain';
import { generateUlid } from './ulid';
import {
  CartError,
  cartSchema,
  cartDto,
  cartKey,
  receiptSchema,
  hash,
  sameCapability,
  parseKey,
  freshKey,
  etag,
  checkedTotal,
  shoppingExpired,
  type Cart,
  type CartRequest,
  type CartResult,
  type CartMetrics,
  type CartCode,
} from './cart-domain';

type Actions = NonNullable<TransactWriteCommandInput['TransactItems']>;
type Key = { PK: string; SK: string };
type Kind =
  'drop' | 'storefront' | 'product' | 'inventory' | 'cart' | 'receipt' | 'work';
export interface CartService {
  get(id: string, tokenHash: string): Promise<CartResult>;
  mutate(
    request: CartRequest,
    metrics: CartMetrics,
    remaining?: () => number,
  ): Promise<CartResult>;
}
export class DynamoCartRepository implements CartService {
  constructor(
    private readonly client: Pick<DynamoDBDocumentClient, 'send'>,
    private readonly catalog: string,
    private readonly commerce: string,
    private readonly operations: string,
    private readonly runtime = {
      now: () => Date.now(),
      monotonic: () => performance.now(),
      sleep: (ms: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, ms)),
      random: () => Math.random(),
      id: generateUlid,
    },
    private readonly dispatch?: ExpiryDispatch,
  ) {
    if (!catalog || !commerce || !operations)
      throw new Error('Cart tables required');
  }
  private async read<T>(
    table: string,
    key: Key,
    schema: z.ZodType<T>,
    budget?: () => number,
  ): Promise<T | undefined> {
    const response = await this.client
      .send(
        new GetCommand({ TableName: table, Key: key, ConsistentRead: true }),
        budget ? { abortSignal: AbortSignal.timeout(budget()) } : {},
      )
      .catch(() => {
        throw new CartError('CART_BUSY');
      });
    if (!response.Item) return undefined;
    const { PK, SK, ...data } = response.Item;
    if (PK !== key.PK || SK !== key.SK) throw new CartError('INTERNAL_ERROR');
    return schema.parse(data);
  }
  private async authorized(
    id: string,
    tokenHash: string,
    budget?: () => number,
  ): Promise<Cart> {
    const c = await this.read(this.commerce, cartKey(id), cartSchema, budget);
    if (
      !sameCapability(c?.managementTokenHash ?? '0'.repeat(64), tokenHash) ||
      !c
    )
      throw new CartError('UNAUTHORIZED');
    return c;
  }
  async get(id: string, tokenHash: string): Promise<CartResult> {
    const c = await this.authorized(id, tokenHash);
    return {
      status: 200,
      cart: cartDto(c),
      expired: shoppingExpired(c, this.runtime.now()),
    };
  }
  async mutate(
    request: CartRequest,
    metrics: CartMetrics,
    remaining: () => number = () => Infinity,
  ): Promise<CartResult> {
    const start = this.runtime.monotonic();
    // Bound every SDK call as well as backoff; leave time to serialize a safe response.
    const budget = () => {
      const ms = Math.floor(
        Math.min(2000 - (this.runtime.monotonic() - start), remaining() - 200),
      );
      if (ms <= 0) throw new CartError('CART_BUSY');
      return ms;
    };
    const key = parseKey(request.key);
    const scope = `cart:v1:${request.operation}:${request.cartId ?? 'new'}`;
    const receiptKey = {
      PK: `IDEMPOTENCY#${hash(`${scope}:${key.raw}`)}`,
      SK: 'META',
    };
    const desired = [...(request.items ?? [])].sort((a, b) =>
      a.productId.localeCompare(b.productId),
    );
    const fingerprint = hash(
      JSON.stringify({
        operation: request.operation,
        cartId: request.cartId ?? null,
        dropId: request.dropId ?? null,
        items: desired,
        ifMatch: request.ifMatch ?? null,
      }),
    );
    const replay = async () => {
      const receipt = await this.read(
        this.operations,
        receiptKey,
        receiptSchema,
        budget,
      );
      if (!receipt) return undefined;
      if (!sameCapability(receipt.managementTokenHash, request.tokenHash))
        throw new CartError('UNAUTHORIZED');
      if (receipt.scope !== scope || receipt.fingerprint !== fingerprint)
        throw new CartError('IDEMPOTENCY_CONFLICT');
      return receipt.response;
    };
    // Dispatch is best effort AFTER durable ownership. Its failure cannot change
    // a committed API response. Replays must recheck current Cart and work.
    const finish = async (response: CartResult): Promise<CartResult> => {
      if (request.operation !== 'create' || !this.dispatch) return response;
      try {
        const dispatchBudget = () => {
          const ms = Math.floor(Math.min(400, remaining() - 200));
          if (ms <= 0) throw new Error('Dispatch budget exhausted');
          return ms;
        };
        const cart = await this.read(
          this.commerce,
          cartKey(response.cart.cartId),
          cartSchema,
          dispatchBudget,
        );
        if (!cart || cart.status !== 'ACTIVE') return response;
        const work = await this.read(
          this.operations,
          expiryKey(cart.cartId, cart.shoppingExpiresAt),
          expiryWorkSchema,
          dispatchBudget,
        );
        if (!work) return response;
        if (
          work.cartId !== cart.cartId ||
          work.deadline !== cart.shoppingExpiresAt
        )
          throw new Error('Invalid work');
        await this.dispatch.send(
          expiryMessage(cart.cartId, cart.shoppingExpiresAt),
          expiryDelay(cart.shoppingExpiresAt, this.runtime.now()),
          dispatchBudget(),
        );
        expiryLog(
          'dispatchCartExpiry',
          'sent',
          { DispatchSuccess: 1 },
          { cartId: cart.cartId, deadline: cart.shoppingExpiresAt },
        );
      } catch {
        expiryLog(
          'dispatchCartExpiry',
          'deferred',
          { DispatchFailure: 1 },
          { cartId: response.cart.cartId },
        );
      }
      return response;
    };
    const prior = await replay();
    if (prior) return finish(prior);
    const cartId = request.cartId ?? this.runtime.id();
    let observedCartRevision: string | undefined;
    let observedDropRevision: string | undefined;
    const checkpoint = () => {
      if (this.runtime.monotonic() - start >= 2000 || remaining() < 650)
        throw new CartError('CART_BUSY');
    };
    try {
      for (let attempt = 0; attempt < 6; attempt++) {
        checkpoint();
        freshKey(key.issuedAt, this.runtime.now());
        let old: Cart | undefined;
        if (request.operation !== 'create') {
          old = await this.authorized(cartId, request.tokenHash, budget);
          if (
            observedCartRevision !== undefined &&
            old.updatedAt !== observedCartRevision
          ) {
            const response = await replay();
            if (response) return finish(response);
            throw new CartError('CART_CONFLICT');
          }
          observedCartRevision = old.updatedAt;
          if (
            request.operation === 'release' &&
            ['PAYMENT_PENDING', 'PAYMENT_COMMITTING', 'CONVERTED'].includes(
              old.status,
            )
          )
            throw new CartError('CART_CONFLICT');
          if (request.operation === 'replace') {
            if (old.status !== 'ACTIVE') throw new CartError('CART_CONFLICT');
            if (request.ifMatch !== etag(old.updatedAt))
              throw new CartError('CART_CONFLICT');
            if (this.runtime.now() >= Date.parse(old.shoppingExpiresAt))
              throw new CartError('RESERVATION_EXPIRED');
          }
        }
        const dropId = old?.dropId ?? request.dropId!;
        const oldLines = new Map(
          (old?.status === 'ACTIVE' ? old.items : []).map((i) => [
            i.productId,
            i,
          ]),
        );
        const settling = request.operation === 'release';
        const acquiring =
          request.operation === 'create' ||
          (!settling &&
            desired.some(
              (i) => i.quantity > (oldLines.get(i.productId)?.quantity ?? 0),
            ));
        const actions: Actions = [];
        const kinds: Kind[] = [];
        const append = (action: Actions[number], kind: Kind) => {
          actions.push(action);
          kinds.push(kind);
        };
        let lines: Cart['items'] = settling ? old!.items : [];
        let drop: Drop | undefined;
        if (!settling) {
          drop = await this.read(
            this.catalog,
            catalogKeys.drop(dropId),
            dropSchema,
            budget,
          );
          if (!drop) throw new CartError('DROP_NOT_OPEN');
          if (
            acquiring &&
            (drop.status !== 'OPEN' ||
              (observedDropRevision !== undefined &&
                drop.updatedAt !== observedDropRevision))
          )
            throw new CartError('DROP_NOT_OPEN');
          if (acquiring) observedDropRevision = drop.updatedAt;
          // Reductions give stock back and need no Product/storefront acquisition guard.
          if (!acquiring) {
            lines = desired.map((i) => ({
              ...oldLines.get(i.productId)!,
              quantity: i.quantity,
            }));
          } else {
            const storefront = await this.read(
              this.catalog,
              catalogKeys.storefront,
              storefrontSchema,
              budget,
            );
            if (storefront?.storefrontDropId !== dropId)
              throw new CartError('STOREFRONT_CONFLICT');
            append(
              {
                ConditionCheck: {
                  TableName: this.catalog,
                  Key: catalogKeys.drop(dropId),
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
              'drop',
            );
            append(
              {
                ConditionCheck: {
                  TableName: this.catalog,
                  Key: catalogKeys.storefront,
                  ConditionExpression: '#storefrontDropId = :dropId',
                  ExpressionAttributeNames: {
                    '#storefrontDropId': 'storefrontDropId',
                  },
                  ExpressionAttributeValues: { ':dropId': dropId },
                },
              },
              'storefront',
            );
            for (const item of desired) {
              checkpoint();
              const relation = await this.read(
                this.catalog,
                catalogKeys.dropProduct(dropId, item.productId),
                dropProductSchema,
                budget,
              );
              const product = await this.read(
                this.catalog,
                catalogKeys.product(item.productId),
                productSchema,
                budget,
              );
              if (
                !relation ||
                relation.dropId !== dropId ||
                relation.productId !== item.productId ||
                !relation.active ||
                relation.priceCents <= 0 ||
                !product ||
                product.productId !== item.productId ||
                !product.active
              )
                throw new CartError('PRODUCT_NOT_AVAILABLE');
              const accepted = oldLines.get(item.productId);
              lines.push({
                productId: item.productId,
                quantity: item.quantity,
                priceCents: accepted?.priceCents ?? relation.priceCents,
                cookieUnits: accepted?.cookieUnits ?? relation.cookieUnits,
              });
              append(this.productCheck(product), 'product');
            }
          }
          if (checkedTotal(lines, 'cookieUnits') > drop.quantityLimit)
            throw new CartError('QUANTITY_LIMIT_EXCEEDED');
          checkedTotal(lines, 'priceCents');
        }
        const quantities = new Map(
          (settling ? [] : lines).map((i) => [i.productId, i.quantity]),
        );
        const ids = [
          ...new Set([...oldLines.keys(), ...quantities.keys()]),
        ].sort();
        for (const productId of ids) {
          const delta =
            (quantities.get(productId) ?? 0) -
            (oldLines.get(productId)?.quantity ?? 0);
          if (delta === 0) continue;
          checkpoint();
          const inventoryKey = catalogKeys.inventory(dropId, productId);
          const current = await this.read(
            this.catalog,
            inventoryKey,
            inventorySchema,
            budget,
          );
          if (
            !current ||
            current.dropId !== dropId ||
            current.productId !== productId
          )
            throw new CartError('INTERNAL_ERROR');
          const reserved = current.reserved + delta;
          if (!Number.isSafeInteger(reserved) || reserved < 0)
            throw new CartError('INTERNAL_ERROR');
          if (reserved > current.total - current.sold)
            throw new CartError('INSUFFICIENT_INVENTORY');
          const next = inventorySchema.parse({
            ...current,
            reserved,
            updatedAt: new Date(
              Math.max(this.runtime.now(), Date.parse(current.updatedAt) + 1),
            ).toISOString(),
          });
          append(
            {
              Put: {
                TableName: this.catalog,
                Item: { ...next, ...inventoryKey },
                ConditionExpression:
                  'attribute_exists(PK) AND #total = :total AND #reserved = :reserved AND #sold = :sold AND #updated = :expected',
                ExpressionAttributeNames: {
                  '#total': 'total',
                  '#reserved': 'reserved',
                  '#sold': 'sold',
                  '#updated': 'updatedAt',
                },
                ExpressionAttributeValues: {
                  ':total': current.total,
                  ':reserved': current.reserved,
                  ':sold': current.sold,
                  ':expected': current.updatedAt,
                },
              },
            },
            'inventory',
          );
        }
        checkpoint();
        const now = this.runtime.now();
        freshKey(key.issuedAt, now);
        if (
          request.operation === 'replace' &&
          now >= Date.parse(old!.shoppingExpiresAt)
        )
          throw new CartError('RESERVATION_EXPIRED');
        const revision = new Date(
          Math.max(now, old ? Date.parse(old.updatedAt) + 1 : now),
        ).toISOString();
        const next: Cart = cartSchema.parse(
          old
            ? {
                ...old,
                items: lines,
                status: settling
                  ? old.status === 'ACTIVE'
                    ? now >= Date.parse(old.shoppingExpiresAt)
                      ? 'EXPIRED'
                      : 'CANCELLED'
                    : old.status
                  : 'ACTIVE',
                updatedAt: old.status === 'ACTIVE' ? revision : old.updatedAt,
              }
            : {
                cartId,
                dropId,
                status: 'ACTIVE',
                createdAt: revision,
                updatedAt: revision,
                shoppingExpiresAt: new Date(now + 480000).toISOString(),
                managementTokenHash: request.tokenHash,
                items: lines,
              },
        );
        append(
          {
            Put: {
              TableName: this.commerce,
              Item: { ...next, ...cartKey(cartId) },
              ConditionExpression: old
                ? 'attribute_exists(PK) AND #status = :status AND #updated = :expected AND #token = :token' +
                  (request.operation === 'replace'
                    ? ' AND #expires > :now'
                    : '')
                : 'attribute_not_exists(PK)',
              ...(old
                ? {
                    ExpressionAttributeNames: {
                      '#status': 'status',
                      '#updated': 'updatedAt',
                      '#token': 'managementTokenHash',
                      ...(request.operation === 'replace'
                        ? { '#expires': 'shoppingExpiresAt' }
                        : {}),
                    },
                    ExpressionAttributeValues: {
                      ':status': old.status,
                      ':expected': old.updatedAt,
                      ':token': request.tokenHash,
                      ...(request.operation === 'replace'
                        ? { ':now': new Date(now).toISOString() }
                        : {}),
                    },
                  }
                : {}),
            },
          },
          'cart',
        );
        const response = {
          status:
            request.operation === 'create' ? (201 as const) : (200 as const),
          cart: cartDto(next),
        };
        append(
          {
            Put: {
              TableName: this.operations,
              Item: {
                ...receiptSchema.parse({
                  operation: request.operation,
                  scope,
                  version: 1,
                  fingerprint,
                  managementTokenHash: request.tokenHash,
                  cartId,
                  response,
                  createdAt: new Date(now).toISOString(),
                  retainUntil: Math.ceil((now + 7 * 86400000) / 1000),
                }),
                ...receiptKey,
              },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          'receipt',
        );
        if (request.operation === 'create')
          append(
            {
              Put: {
                TableName: this.operations,
                Item: expiryWork(
                  cartId,
                  next.shoppingExpiresAt,
                  next.createdAt,
                ),
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            'work',
          );
        if (settling)
          append(
            deleteExpiryWork(
              this.operations,
              expiryMessage(cartId, next.shoppingExpiresAt),
            ),
            'work',
          );
        if (actions.length > 100) throw new CartError('VALIDATION_ERROR');
        metrics.attempts++;
        try {
          await this.client.send(
            new TransactWriteCommand({ TransactItems: actions }),
            { abortSignal: AbortSignal.timeout(budget()) },
          );
          return finish(response);
        } catch (error) {
          // Resolve committed ownership before classifying an ambiguous response or cancellation.
          const committed = await replay();
          if (committed) return finish(committed);
          if (
            !(error instanceof Error) ||
            error.name !== 'TransactionCanceledException'
          )
            throw new CartError('CART_BUSY');
          const reasons = (
            error as Error & { CancellationReasons?: { Code?: string }[] }
          ).CancellationReasons;
          if (
            !reasons ||
            reasons.length !== kinds.length ||
            reasons.some(
              (r) =>
                ![
                  'None',
                  'ConditionalCheckFailed',
                  'TransactionConflict',
                ].includes(r.Code ?? ''),
            )
          )
            throw new CartError('CART_BUSY');
          let retry = false;
          for (let i = 0; i < reasons.length; i++) {
            if (reasons[i].Code === 'ConditionalCheckFailed') {
              const kind = kinds[i];
              if (kind === 'inventory') {
                retry = true;
                continue;
              }
              const codes: Partial<Record<Kind, CartCode>> = {
                drop: 'DROP_NOT_OPEN',
                storefront: 'STOREFRONT_CONFLICT',
                product: 'PRODUCT_NOT_AVAILABLE',
                cart: 'CART_CONFLICT',
                receipt: 'CART_BUSY',
                work: 'CART_BUSY',
              };
              throw new CartError(codes[kind]!);
            }
            if (reasons[i].Code === 'TransactionConflict') retry = true;
          }
          if (!retry || attempt === 5) throw new CartError('CART_BUSY');
          const delay =
            this.runtime.random() * Math.min(250, 25 * 2 ** attempt);
          if (
            this.runtime.monotonic() - start + delay >= 2000 ||
            remaining() < delay + 650
          )
            throw new CartError('CART_BUSY');
          await this.runtime.sleep(delay);
        }
      }
      throw new CartError('CART_BUSY');
    } catch (error) {
      const committed = await replay();
      if (committed) return finish(committed);
      throw error;
    }
  }
  private productCheck(product: Product): Actions[number] {
    return {
      ConditionCheck: {
        TableName: this.catalog,
        Key: catalogKeys.product(product.productId),
        ConditionExpression:
          'attribute_exists(PK) AND #active = :active AND #updated = :expected',
        ExpressionAttributeNames: {
          '#active': 'active',
          '#updated': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':active': true,
          ':expected': product.updatedAt,
        },
      },
    };
  }
}
