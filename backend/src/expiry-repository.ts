import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { performance } from 'node:perf_hooks';
import { cartSchema, cartKey } from './cart-domain';
import { inventorySchema } from './domain';
import { catalogKeys } from './keys';
import {
  canonicalTime,
  deleteExpiryWork,
  type ExpiryMessage,
} from './cart-expiry';

export const expiryRuntime = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
  random: () => Math.random(),
  sleep: (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
};
export type ExpiryRuntime = typeof expiryRuntime;
export type ExpiryResult = {
  outcome: 'expired' | 'terminal' | 'obsolete' | 'early';
  attempts: number;
  lateness: number;
};
export class ExpiryFailure extends Error {
  constructor(
    public readonly code:
      'INVALID_STATE' | 'MISSING_CART' | 'RETRY_EXHAUSTED' | 'INVALID_WORK',
  ) {
    super(code);
  }
}
export class ExpiryRepository {
  constructor(
    private readonly client: Pick<DynamoDBDocumentClient, 'send'>,
    private readonly catalog: string,
    private readonly commerce: string,
    private readonly operations: string,
    private readonly runtime: ExpiryRuntime = expiryRuntime,
  ) {
    if (!catalog || !commerce || !operations)
      throw new Error('Expiry tables required');
  }
  async expire(
    message: ExpiryMessage,
    remaining: () => number = () => Infinity,
  ): Promise<ExpiryResult> {
    const start = this.runtime.monotonic();
    const budget = () => {
      const ms = Math.floor(
        Math.min(5000 - (this.runtime.monotonic() - start), remaining() - 1000),
      );
      if (ms <= 0) throw new ExpiryFailure('RETRY_EXHAUSTED');
      return ms;
    };
    const read = async <T>(
      table: string,
      key: { PK: string; SK: string },
      schema: z.ZodType<T>,
    ) => {
      const { Item } = await this.client.send(
        new GetCommand({ TableName: table, Key: key, ConsistentRead: true }),
        { abortSignal: AbortSignal.timeout(budget()) },
      );
      if (!Item) return undefined;
      const { PK, SK, ...data } = Item;
      const parsed = schema.safeParse(data);
      if (PK !== key.PK || SK !== key.SK || !parsed.success)
        throw new ExpiryFailure('INVALID_STATE');
      return parsed.data;
    };
    for (let attempt = 0; attempt < 6; attempt++) {
      budget();
      try {
        const cart = await read(
          this.commerce,
          cartKey(message.cartId),
          cartSchema,
        );
        if (!cart) throw new ExpiryFailure('MISSING_CART');
        if (
          cart.cartId !== message.cartId ||
          !canonicalTime.safeParse(cart.shoppingExpiresAt).success ||
          !canonicalTime.safeParse(cart.updatedAt).success
        )
          throw new ExpiryFailure('INVALID_STATE');
        const now = this.runtime.now();
        const sameDeadline = cart.shoppingExpiresAt === message.deadline;
        const lateness = Math.max(0, now - Date.parse(message.deadline));
        if (
          cart.status === 'ACTIVE' &&
          sameDeadline &&
          now < Date.parse(message.deadline)
        )
          return { outcome: 'early', attempts: attempt + 1, lateness: 0 };
        const actions: NonNullable<TransactWriteCommandInput['TransactItems']> =
          [];
        if (cart.status !== 'ACTIVE' || !sameDeadline) {
          // Prove obsolescence against the exact state read; never rewrite its ETag.
          actions.push(
            {
              ConditionCheck: {
                TableName: this.commerce,
                Key: cartKey(cart.cartId),
                ConditionExpression:
                  'attribute_exists(PK) AND #status = :status AND #updated = :updated AND #expires = :expires',
                ExpressionAttributeNames: {
                  '#status': 'status',
                  '#updated': 'updatedAt',
                  '#expires': 'shoppingExpiresAt',
                },
                ExpressionAttributeValues: {
                  ':status': cart.status,
                  ':updated': cart.updatedAt,
                  ':expires': cart.shoppingExpiresAt,
                },
              },
            },
            deleteExpiryWork(this.operations, message),
          );
        } else {
          for (const line of [...cart.items].sort((a, b) =>
            a.productId.localeCompare(b.productId),
          )) {
            const key = catalogKeys.inventory(cart.dropId, line.productId);
            const inventory = await read(this.catalog, key, inventorySchema);
            if (
              !inventory ||
              inventory.dropId !== cart.dropId ||
              inventory.productId !== line.productId
            )
              throw new ExpiryFailure('INVALID_STATE');
            const reserved = inventory.reserved - line.quantity;
            if (
              !Number.isSafeInteger(reserved) ||
              reserved < 0 ||
              inventory.sold < 0 ||
              reserved > inventory.total - inventory.sold
            )
              throw new ExpiryFailure('INVALID_STATE');
            const next = inventorySchema.parse({
              ...inventory,
              reserved,
              updatedAt: new Date(
                Math.max(
                  this.runtime.now(),
                  Date.parse(inventory.updatedAt) + 1,
                ),
              ).toISOString(),
            });
            actions.push({
              Put: {
                TableName: this.catalog,
                Item: { ...next, ...key },
                ConditionExpression:
                  'attribute_exists(PK) AND #total = :total AND #reserved = :reserved AND #sold = :sold AND #updated = :expected',
                ExpressionAttributeNames: {
                  '#total': 'total',
                  '#reserved': 'reserved',
                  '#sold': 'sold',
                  '#updated': 'updatedAt',
                },
                ExpressionAttributeValues: {
                  ':total': inventory.total,
                  ':reserved': inventory.reserved,
                  ':sold': inventory.sold,
                  ':expected': inventory.updatedAt,
                },
              },
            });
          }
          // Sample again immediately before submission, never rely on a message's time.
          const sampledNow = new Date(this.runtime.now()).toISOString();
          actions.push(
            {
              Put: {
                TableName: this.commerce,
                Item: {
                  ...cart,
                  ...cartKey(cart.cartId),
                  status: 'EXPIRED',
                  updatedAt: new Date(
                    Math.max(
                      Date.parse(sampledNow),
                      Date.parse(cart.updatedAt) + 1,
                    ),
                  ).toISOString(),
                },
                ConditionExpression:
                  'attribute_exists(PK) AND #status = :active AND #updated = :updated AND #expires = :expires AND #expires <= :now',
                ExpressionAttributeNames: {
                  '#status': 'status',
                  '#updated': 'updatedAt',
                  '#expires': 'shoppingExpiresAt',
                },
                ExpressionAttributeValues: {
                  ':active': 'ACTIVE',
                  ':updated': cart.updatedAt,
                  ':expires': message.deadline,
                  ':now': sampledNow,
                },
              },
            },
            deleteExpiryWork(this.operations, message),
          );
        }
        try {
          await this.client.send(
            new TransactWriteCommand({ TransactItems: actions }),
            { abortSignal: AbortSignal.timeout(budget()) },
          );
        } catch (error) {
          const reasons = (
            error as { CancellationReasons?: { Code?: string }[] }
          )?.CancellationReasons;
          if (reasons?.[actions.length - 1]?.Code === 'ConditionalCheckFailed')
            throw new ExpiryFailure('INVALID_WORK');
          throw error;
        }
        return {
          outcome:
            cart.status !== 'ACTIVE'
              ? 'terminal'
              : !sameDeadline
                ? 'obsolete'
                : 'expired',
          attempts: attempt + 1,
          lateness,
        };
      } catch (error) {
        if (error instanceof ExpiryFailure) throw error;
        // Includes ambiguous commit responses: a fresh terminal read makes retry safe.
        if (attempt === 5) throw new ExpiryFailure('RETRY_EXHAUSTED');
        const delay = this.runtime.random() * Math.min(250, 25 * 2 ** attempt);
        if (budget() <= delay + 100) throw new ExpiryFailure('RETRY_EXHAUSTED');
        await this.runtime.sleep(delay);
      }
    }
    throw new ExpiryFailure('RETRY_EXHAUSTED');
  }
}
