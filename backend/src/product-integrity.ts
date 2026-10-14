import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { productSchema, type Product } from './domain';
import { catalogKeys } from './keys';
import { AdminError } from './admin-auth';

export const creationKey = z.uuid();
export const integrityReadyKey = { PK: 'PRODUCT_INTEGRITY#V1', SK: 'STATE' };
export const digest = (s: string) =>
  createHash('sha256').update(s).digest('hex');
export const slugKey = (slug: string) => ({
  PK: `PRODUCT_SLUG#${digest(slug)}`,
  SK: 'OWNER',
});
export interface CreationIdentity {
  subject: string;
  key: string;
}
export function validateIdentity(value: CreationIdentity) {
  if (
    !value ||
    typeof value.subject !== 'string' ||
    !value.subject.trim() ||
    value.subject.length > 256 ||
    !creationKey.safeParse(value.key).success
  )
    throw new AdminError(
      400,
      'IDEMPOTENCY_KEY_INVALID',
      'A valid creation request identity is required.',
    );
  return { subject: value.subject, key: value.key.toLowerCase() };
}
export const receiptKey = (identity: CreationIdentity) => {
  const i = validateIdentity(identity);
  return {
    PK: `PRODUCT_CREATE#${digest(JSON.stringify([i.subject, i.key]))}`,
    SK: 'RESULT',
  };
};
export function payloadHash(p: Product) {
  return digest(
    JSON.stringify([
      1,
      p.name,
      p.slug,
      p.description,
      p.ingredients,
      p.allergens,
      p.active,
    ]),
  );
}
// A deliberately conservative upper bound: JSON escapes and container punctuation
// overestimate strings and map/list overhead. Numeric values are not used here.
// 350 KiB per serialized item and 1 MiB aggregate leave room below DynamoDB limits.
export const INTEGRITY_ITEM_LIMIT = 350 * 1024;
export const INTEGRITY_TRANSACTION_LIMIT = 1024 * 1024;
export function checkIntegritySizes(items: unknown[]) {
  const sizes = items.map((i) => Buffer.byteLength(JSON.stringify(i)));
  if (
    sizes.some((n) => n > INTEGRITY_ITEM_LIMIT) ||
    sizes.reduce((a, b) => a + b, 0) > INTEGRITY_TRANSACTION_LIMIT
  )
    throw new AdminError(
      413,
      'PRODUCT_TOO_LARGE',
      'Product data exceeds the safe creation receipt size limit. Nothing was saved.',
    );
}
const receiptSchema = z.strictObject({
  PK: z.string(),
  SK: z.literal('RESULT'),
  subject: z.string(),
  requestKey: z.uuid(),
  version: z.literal(1),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  product: productSchema,
  completedAt: z.iso.datetime(),
});
type Actions = NonNullable<TransactWriteCommandInput['TransactItems']>;
// Diagnose business conflicts only when DynamoDB confirms which condition failed.
// A timeout/conflict without this evidence may still have an unknown outcome.
function conditionalFailures(error: unknown, count: number): Set<number> {
  if (
    !(error instanceof Error) ||
    error.name !== 'TransactionCanceledException'
  )
    return new Set();
  const reasons = (
    error as Error & { CancellationReasons?: Array<{ Code?: string }> }
  ).CancellationReasons;
  if (
    !reasons ||
    reasons.length !== count ||
    reasons.some(
      (r) =>
        !['None', 'ConditionalCheckFailed', 'TransactionConflict'].includes(
          r.Code ?? 'None',
        ),
    )
  )
    throw error;
  return new Set(
    reasons.flatMap((r, n) => (r.Code === 'ConditionalCheckFailed' ? [n] : [])),
  );
}

export class ProductIntegrity {
  constructor(
    private client: Pick<DynamoDBDocumentClient, 'send'>,
    private table: string,
  ) {}
  private async get(key: { PK: string; SK: string }) {
    return (
      await this.client.send(
        new GetCommand({
          TableName: this.table,
          Key: key,
          ConsistentRead: true,
        }),
      )
    ).Item;
  }
  private readyCheck() {
    return {
      ConditionCheck: {
        TableName: this.table,
        Key: integrityReadyKey,
        ConditionExpression: '#version = :version AND #state = :ready',
        ExpressionAttributeNames: { '#version': 'version', '#state': 'state' },
        ExpressionAttributeValues: { ':version': 1, ':ready': 'READY' },
      },
    };
  }
  private inconsistent(): never {
    throw new AdminError(
      409,
      'PRODUCT_INTEGRITY_CONFLICT',
      'Catalog ownership is inconsistent. Contact the operator.',
    );
  }
  async result(identity: CreationIdentity) {
    const i = validateIdentity(identity),
      key = receiptKey(i),
      raw = await this.get(key);
    if (!raw) return undefined;
    const parsed = receiptSchema.safeParse(raw);
    if (!parsed.success) return this.inconsistent();
    const r = parsed.data;
    if (
      r.PK !== key.PK ||
      r.subject !== i.subject ||
      r.requestKey !== i.key ||
      r.hash !== payloadHash(r.product) ||
      r.completedAt !== r.product.createdAt
    )
      return this.inconsistent();
    return r;
  }
  private async ready() {
    const r = await this.get(integrityReadyKey);
    if (!r || r.version !== 1 || r.state !== 'READY')
      throw new AdminError(
        503,
        'PRODUCT_WRITES_NOT_READY',
        'Product changes are not enabled until catalog preparation is complete.',
      );
  }
  private async ownership(product: Product) {
    const r = await this.get(slugKey(product.slug));
    if (
      !r ||
      r.canonicalSlug !== product.slug ||
      r.productId !== product.productId
    ) {
      const current = await this.get(catalogKeys.product(product.productId));
      if (!current)
        throw new AdminError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
      if (
        current.updatedAt !== product.updatedAt ||
        current.createdAt !== product.createdAt ||
        current.slug !== product.slug
      )
        throw new AdminError(
          409,
          'PRODUCT_CONFLICT',
          'Product changed. Reload before editing.',
        );
      return this.inconsistent();
    }
  }
  private ownerCondition(product: Product) {
    return {
      ConditionExpression: 'canonicalSlug = :slug AND productId = :owner',
      ExpressionAttributeValues: {
        ':slug': product.slug,
        ':owner': product.productId,
      },
    };
  }
  private claim(product: Product) {
    return {
      Put: {
        TableName: this.table,
        Item: {
          ...slugKey(product.slug),
          canonicalSlug: product.slug,
          productId: product.productId,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    };
  }
  private async collision(slug: string) {
    const owner = await this.get(slugKey(slug));
    if (owner) {
      if (
        owner.canonicalSlug !== slug ||
        !z.ulid().safeParse(owner.productId).success
      )
        return this.inconsistent();
      throw new AdminError(
        409,
        'SLUG_CONFLICT',
        'This slug belongs to another cookie, including inactive cookies. Choose a different slug in Advanced Details.',
      );
    }
  }
  async create(product: Product, identity: CreationIdentity): Promise<Product> {
    const p = productSchema.parse(product),
      i = validateIdentity(identity),
      hash = payloadHash(p);
    const replay = async () => {
      const r = await this.result(i);
      if (r && r.hash !== hash)
        throw new AdminError(
          409,
          'IDEMPOTENCY_CONFLICT',
          'This creation request was already used with different cookie details.',
        );
      return r?.product;
    };
    const prior = await replay();
    if (prior) return prior;
    await this.ready();
    const receipt = {
      ...receiptKey(i),
      subject: i.subject,
      requestKey: i.key,
      version: 1,
      hash,
      product: p,
      completedAt: p.createdAt,
    };
    const record = { ...p, ...catalogKeys.product(p.productId) };
    const claim = this.claim(p);
    checkIntegritySizes([record, claim.Put.Item, receipt]);
    const actions: Actions = [
      this.readyCheck(),
      {
        Put: {
          TableName: this.table,
          Item: record,
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
      claim,
      {
        Put: {
          TableName: this.table,
          Item: receipt,
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
    ];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.client.send(
          new TransactWriteCommand({ TransactItems: actions }),
        );
        return p;
      } catch (error) {
        const done = await replay();
        if (done) return done;
        const failed = conditionalFailures(error, actions.length);
        try {
          if (failed.has(0)) await this.ready();
          if (failed.has(2)) await this.collision(p.slug);
          if (
            failed.has(1) &&
            (await this.get(catalogKeys.product(p.productId)))
          )
            throw new AdminError(
              409,
              'PRODUCT_CONFLICT',
              'Product identity already exists.',
            );
          if (failed.has(3)) this.inconsistent();
        } catch (diagnostic) {
          // A competing identical operation can commit between reconciliation
          // and diagnostic reads. Its durable result takes precedence.
          const late = await replay();
          if (late) return late;
          throw diagnostic;
        }
        if (attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
    throw new Error('Unreachable creation');
  }
  async replace(p: Product, previous: Product) {
    await this.ready();
    await this.ownership(previous);
    const changed = p.slug !== previous.slug;
    if (changed && slugKey(p.slug).PK === slugKey(previous.slug).PK)
      return this.inconsistent();
    const record = { ...p, ...catalogKeys.product(p.productId) };
    checkIntegritySizes([record, this.claim(p).Put.Item]);
    const actions: Actions = [
      this.readyCheck(),
      {
        Put: {
          TableName: this.table,
          Item: record,
          ConditionExpression:
            'attribute_exists(PK) AND createdAt = :created AND updatedAt = :updated AND slug = :slug',
          ExpressionAttributeValues: {
            ':created': previous.createdAt,
            ':updated': previous.updatedAt,
            ':slug': previous.slug,
          },
        },
      },
      ...(changed
        ? [
            this.claim(p),
            {
              Delete: {
                TableName: this.table,
                Key: slugKey(previous.slug),
                ...this.ownerCondition(previous),
              },
            },
          ]
        : [
            {
              ConditionCheck: {
                TableName: this.table,
                Key: slugKey(previous.slug),
                ...this.ownerCondition(previous),
              },
            },
          ]),
    ];
    try {
      await this.client.send(
        new TransactWriteCommand({ TransactItems: actions }),
      );
    } catch (error) {
      if (!conditionalFailures(error, actions.length).size) throw error;
      await this.ready();
      const current = await this.get(catalogKeys.product(p.productId));
      if (!current)
        throw new AdminError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
      if (
        current.updatedAt !== previous.updatedAt ||
        current.createdAt !== previous.createdAt ||
        current.slug !== previous.slug
      )
        throw new AdminError(
          409,
          'PRODUCT_CONFLICT',
          'Product changed. Reload before editing.',
        );
      await this.ownership(previous);
      if (changed) await this.collision(p.slug);
      throw error;
    }
  }
}
