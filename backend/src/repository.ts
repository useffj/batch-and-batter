import { ProductIntegrity, type CreationIdentity } from './product-integrity';
import {
  GetCommand,
  ScanCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { scheduledPatchSchema, type ScheduledPatch } from './scheduled-input';
import { catalogKeys } from './keys';
import { updatedAt } from './timestamps';
import { isPublishReady, type PublishSnapshot } from './publish-readiness';
import { isOpenReady, type OpenSnapshot } from './open-readiness';
import {
  productSchema,
  dropSchema,
  dropProductSchema,
  inventorySchema,
  pickupSchema,
  storefrontSchema,
  type Product,
  type Drop,
  type DropProduct,
  type DropInventory,
  type PickupDate,
} from './domain';

export interface CatalogRepository {
  changeScheduled(
    dropId: string,
    revision: string,
    actor: string,
    patch: ScheduledPatch | null,
  ): Promise<Drop>;
  openScheduled(
    dropId: string,
    delivery?: { openingRevision?: string },
  ): Promise<Drop>;
  pauseDrop(dropId: string): Promise<Drop>;
  resumeDrop(dropId: string): Promise<Drop>;
  closeDrop(dropId: string): Promise<Drop>;
  publishDraft(dropId: string): Promise<{
    drop: Drop;
    storefront: { storefrontDropId: string; updatedAt: string };
  }>;
  attachDropProduct(
    item: DropProduct,
    inventoryTotal: number,
  ): Promise<DropInventory>;
  replaceDropProduct(
    item: DropProduct,
    inventoryTotal: number,
  ): Promise<DropInventory>;
  removeDropProduct(dropId: string, productId: string): Promise<void>;
  putPickup(item: PickupDate): Promise<void>;
  removePickup(dropId: string, date: string): Promise<void>;
  listProducts(cursor?: {
    PK: string;
    SK: string;
  }): Promise<{ products: Product[]; cursor?: { PK: string; SK: string } }>;
  createProduct(
    product: Product,
    identity?: CreationIdentity,
  ): Promise<Product | void>;
  getProductCreation(identity: CreationIdentity): Promise<Product | undefined>;
  replaceProduct(product: Product, previous: Product): Promise<void>;
  createDraftDrop(drop: Drop): Promise<void>;
  replaceDraftDrop(drop: Drop, previous: Drop): Promise<void>;
  getProduct(productId: string): Promise<Product | undefined>;
  getDrop(dropId: string): Promise<Drop | undefined>;
  getDropProducts(dropId: string): Promise<DropProduct[]>;
  getDropInventory(dropId: string): Promise<DropInventory[]>;
  getPickupDates(dropId: string): Promise<PickupDate[]>;
  getStorefrontDropId(): Promise<string | undefined>;
  getStorefrontDrop(): Promise<Drop | undefined>;
}
export class CatalogWriteError extends Error {
  constructor(
    public readonly code:
      | 'STALE_OPENING'
      | 'PRODUCT_NOT_FOUND'
      | 'DROP_NOT_FOUND'
      | 'PRODUCT_CONFLICT'
      | 'DROP_CONFLICT'
      | 'DROP_NOT_EDITABLE'
      | 'DROP_PRODUCT_NOT_FOUND'
      | 'PICKUP_NOT_FOUND'
      | 'DROP_PRODUCT_CONFLICT'
      | 'INVENTORY_NOT_EDITABLE'
      | 'COMPOSITION_CONFLICT'
      | 'DROP_NOT_READY'
      | 'STOREFRONT_OCCUPIED'
      | 'STOREFRONT_CONFLICT',
  ) {
    super(code);
  }
}
type Key = { PK: string; SK: string };
function decode<T>(
  item: Record<string, unknown>,
  schema: z.ZodType<T>,
  expected: Key,
): T {
  const { PK, SK, ...data } = item;
  if (PK !== expected.PK || SK !== expected.SK)
    throw new Error('Catalog key mismatch');
  return schema.parse(data);
}
export class DynamoCatalogRepository implements CatalogRepository {
  constructor(
    private readonly client: Pick<DynamoDBDocumentClient, 'send'>,
    private readonly tableName: string,
  ) {
    if (!tableName) throw new Error('CATALOG_TABLE_NAME is required');
  }
  private draftRevisionPut(previous: Drop, next: Drop) {
    return {
      Put: {
        TableName: this.tableName,
        Item: { ...next, ...catalogKeys.drop(previous.dropId) },
        ConditionExpression:
          'attribute_exists(PK) AND #status = :draft AND #updated = :expected',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#updated': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':draft': 'DRAFT',
          ':expected': previous.updatedAt,
        },
      },
    };
  }
  private async dropRevisionFailure(
    dropId: string,
  ): Promise<CatalogWriteError['code']> {
    const current = await this.getDrop(dropId);
    if (!current) return 'DROP_NOT_FOUND';
    return current.status !== 'DRAFT'
      ? 'DROP_NOT_EDITABLE'
      : 'COMPOSITION_CONFLICT';
  }
  private productCheck(productId: string) {
    return {
      ConditionCheck: {
        TableName: this.tableName,
        Key: catalogKeys.product(productId),
        ConditionExpression: 'attribute_exists(PK)',
      },
    };
  }
  private async transact(
    dropId: string,
    actions: NonNullable<TransactWriteCommandInput['TransactItems']>,
    failures: Array<
      CatalogWriteError['code'] | (() => Promise<CatalogWriteError['code']>)
    >,
  ) {
    // This read gives a useful initial 404. Only the transaction authorizes the write.
    const drop = await this.getDrop(dropId);
    if (!drop) throw new CatalogWriteError('DROP_NOT_FOUND');
    if (drop.status !== 'DRAFT')
      throw new CatalogWriteError('DROP_NOT_EDITABLE');
    const next = dropSchema.parse({
      ...drop,
      updatedAt: updatedAt(drop.updatedAt),
    });
    await this.sendTransaction(
      [this.draftRevisionPut(drop, next), ...actions],
      [() => this.dropRevisionFailure(dropId), ...failures],
    );
  }
  private async sendTransaction(
    actions: NonNullable<TransactWriteCommandInput['TransactItems']>,
    mappings: Array<
      CatalogWriteError['code'] | (() => Promise<CatalogWriteError['code']>)
    >,
  ) {
    try {
      await this.client.send(
        new TransactWriteCommand({ TransactItems: actions }),
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.name !== 'TransactionCanceledException'
      )
        throw error;
      const reasons = (
        error as Error & { CancellationReasons?: Array<{ Code?: string }> }
      ).CancellationReasons;
      // Conditional failures follow action order. Unknown service failures stay 500.
      if (reasons?.length === mappings.length) {
        if (
          reasons.some(
            (reason) =>
              reason.Code &&
              ![
                'None',
                'ConditionalCheckFailed',
                'TransactionConflict',
              ].includes(reason.Code),
          )
        )
          throw error;
        for (let index = 0; index < reasons.length; index++) {
          if (reasons[index].Code === 'ConditionalCheckFailed') {
            const mapping = mappings[index];
            throw new CatalogWriteError(
              typeof mapping === 'function' ? await mapping() : mapping,
            );
          }
        }
        if (reasons.some((reason) => reason.Code === 'TransactionConflict'))
          throw new CatalogWriteError('COMPOSITION_CONFLICT');
      }
      throw error;
    }
  }
  async publishDraft(dropId: string) {
    // META must be read first: all following composition reads are covered by its revision.
    let snapshot: PublishSnapshot;
    try {
      const drop = await this.getDrop(dropId);
      if (!drop) throw new CatalogWriteError('DROP_NOT_FOUND');
      if (drop.status !== 'DRAFT')
        throw new CatalogWriteError('DROP_NOT_EDITABLE');
      const [relations, inventories, pickups] = await Promise.all([
        this.getDropProducts(dropId),
        this.getDropInventory(dropId),
        this.getPickupDates(dropId),
      ]);
      const products = [];
      for (const relation of relations)
        products.push(await this.getProduct(relation.productId));
      snapshot = { drop, relations, inventories, pickups, products };
    } catch (error) {
      // Invalid stored domain data is not publishable; SDK/service failures remain generic 500s.
      if (error instanceof z.ZodError)
        throw new CatalogWriteError('DROP_NOT_READY');
      throw error;
    }
    if (!isPublishReady(snapshot, Date.now()))
      throw new CatalogWriteError('DROP_NOT_READY');
    const { drop, products } = snapshot;
    // Two Puts plus one check for every referenced reusable Product, including inactive associations.
    const actionCount = 2 + products.length;
    if (actionCount > 100) throw new CatalogWriteError('DROP_NOT_READY');
    const now = updatedAt(drop.updatedAt);
    const scheduled = dropSchema.parse({
      ...drop,
      status: 'SCHEDULED',
      updatedAt: now,
    });
    const storefront = { storefrontDropId: dropId, updatedAt: now };
    const actions: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      this.draftRevisionPut(drop, scheduled),
      {
        Put: {
          TableName: this.tableName,
          Item: { ...storefront, ...catalogKeys.storefront },
          ConditionExpression:
            'attribute_not_exists(PK) OR #storefrontDropId = :dropId',
          ExpressionAttributeNames: { '#storefrontDropId': 'storefrontDropId' },
          ExpressionAttributeValues: { ':dropId': dropId },
        },
      },
      ...products.map((product) => {
        if (!product) throw new CatalogWriteError('DROP_NOT_READY');
        return {
          ConditionCheck: {
            TableName: this.tableName,
            Key: catalogKeys.product(product.productId),
            ConditionExpression:
              'attribute_exists(PK) AND #active = :active AND #updated = :expected',
            ExpressionAttributeNames: {
              '#active': 'active',
              '#updated': 'updatedAt',
            },
            ExpressionAttributeValues: {
              ':active': product.active,
              ':expected': product.updatedAt,
            },
          },
        };
      }),
    ];
    await this.sendTransaction(actions, [
      () => this.dropRevisionFailure(dropId),
      'STOREFRONT_OCCUPIED',
      ...products.map(() => 'COMPOSITION_CONFLICT' as const),
    ]);
    return { drop: scheduled, storefront };
  }
  async changeScheduled(
    dropId: string,
    revision: string,
    actor: string,
    input: ScheduledPatch | null,
  ): Promise<Drop> {
    const patch = input === null ? null : scheduledPatchSchema.parse(input);
    z.string().min(1).max(256).parse(actor);
    const previous = await this.getDrop(dropId);
    if (!previous) throw new CatalogWriteError('DROP_NOT_FOUND');
    const eligible = () => {
      if (
        previous.status !== 'SCHEDULED' ||
        Date.parse(previous.opensAt) <= Date.now()
      )
        throw new CatalogWriteError('DROP_NOT_EDITABLE');
    };
    eligible();
    if (revision !== previous.updatedAt)
      throw new CatalogWriteError('COMPOSITION_CONFLICT');
    if ((await this.getStorefrontDropId()) !== dropId)
      throw new CatalogWriteError('STOREFRONT_CONFLICT');
    // META is read first. Supported composition writers always advance it; acquisition requires OPEN.
    const [relations, inventories, pickups] = await Promise.all([
      this.getDropProducts(dropId),
      this.getDropInventory(dropId),
      this.getPickupDates(dropId),
    ]);
    if (inventories.some((i) => i.reserved !== 0 || i.sold !== 0))
      throw new CatalogWriteError('INVENTORY_NOT_EDITABLE');
    const now = updatedAt(previous.updatedAt);
    const {
      products: desiredProducts,
      pickups: desiredPickups,
      ...metadata
    } = patch ?? {};
    const parsedNext = dropSchema.safeParse({
      ...previous,
      ...metadata,
      ...(metadata.closesAt === null ? { closesAt: undefined } : {}),
      status: patch ? 'SCHEDULED' : 'CLOSED',
      updatedAt: now,
      ...(patch ? { openingRevision: now } : {}),
    });
    if (!parsedNext.success) throw new CatalogWriteError('DROP_NOT_READY');
    const next = parsedNext.data;
    if (next.closesAt === undefined) delete next.closesAt;
    const nextRelations =
      desiredProducts?.map(({ inventoryTotal: _total, ...r }) => ({
        ...r,
        dropId,
      })) ?? relations;
    const nextInventories =
      desiredProducts?.map((p) =>
        inventorySchema.parse({
          dropId,
          productId: p.productId,
          total: p.inventoryTotal,
          reserved: 0,
          sold: 0,
          updatedAt: updatedAt(
            inventories.find((i) => i.productId === p.productId)?.updatedAt,
          ),
        }),
      ) ?? inventories;
    const nextPickups =
      desiredPickups?.map((p) => ({ ...p, dropId })) ?? pickups;
    const products = patch
      ? await Promise.all(
          nextRelations.map((r) => this.getProduct(r.productId)),
        )
      : [];
    if (
      patch &&
      !isPublishReady(
        {
          drop: { ...next, status: 'DRAFT' },
          relations: nextRelations,
          inventories: nextInventories,
          pickups: nextPickups,
          products,
        },
        Date.now(),
      )
    )
      throw new CatalogWriteError('DROP_NOT_READY');
    const actions: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      {
        Put: {
          TableName: this.tableName,
          Item: { ...next, ...catalogKeys.drop(dropId) },
          ConditionExpression:
            'attribute_exists(PK) AND #status = :source AND #updated = :expected',
          ExpressionAttributeNames: {
            '#status': 'status',
            '#updated': 'updatedAt',
          },
          ExpressionAttributeValues: {
            ':source': 'SCHEDULED',
            ':expected': revision,
          },
        },
      },
    ];
    const pointer = {
      TableName: this.tableName,
      Key: catalogKeys.storefront,
      ConditionExpression: '#storefrontDropId = :dropId',
      ExpressionAttributeNames: { '#storefrontDropId': 'storefrontDropId' },
      ExpressionAttributeValues: { ':dropId': dropId },
    };
    actions.push(patch ? { ConditionCheck: pointer } : { Delete: pointer });
    for (const old of inventories) {
      const replacement =
        desiredProducts &&
        nextInventories.find((i) => i.productId === old.productId);
      const guard = {
        TableName: this.tableName,
        ...this.inventoryZeroCondition(),
      };
      // A removed zero-owned inventory record is retained in the immutable audit.
      actions.push(
        replacement
          ? {
              Put: {
                ...guard,
                Item: {
                  ...replacement,
                  ...catalogKeys.inventory(dropId, old.productId),
                },
              },
            }
          : desiredProducts
            ? {
                Delete: {
                  ...guard,
                  Key: catalogKeys.inventory(dropId, old.productId),
                },
              }
            : {
                ConditionCheck: {
                  ...guard,
                  Key: catalogKeys.inventory(dropId, old.productId),
                },
              },
      );
    }
    if (desiredProducts) {
      for (const i of nextInventories.filter(
        (i) => !inventories.some((old) => old.productId === i.productId),
      ))
        actions.push({
          Put: {
            TableName: this.tableName,
            Item: { ...i, ...catalogKeys.inventory(dropId, i.productId) },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        });
      for (const r of nextRelations)
        actions.push({
          Put: {
            TableName: this.tableName,
            Item: { ...r, ...catalogKeys.dropProduct(dropId, r.productId) },
          },
        });
      for (const r of relations.filter(
        (r) => !nextRelations.some((n) => n.productId === r.productId),
      ))
        actions.push({
          Delete: {
            TableName: this.tableName,
            Key: catalogKeys.dropProduct(dropId, r.productId),
          },
        });
    }
    if (desiredPickups) {
      for (const p of nextPickups)
        actions.push({
          Put: {
            TableName: this.tableName,
            Item: { ...p, ...catalogKeys.pickup(dropId, p.date) },
          },
        });
      for (const p of pickups.filter(
        (p) => !nextPickups.some((n) => n.date === p.date),
      ))
        actions.push({
          Delete: {
            TableName: this.tableName,
            Key: catalogKeys.pickup(dropId, p.date),
          },
        });
    }
    for (const p of products) {
      if (!p) throw new CatalogWriteError('DROP_NOT_READY');
      actions.push({
        ConditionCheck: {
          TableName: this.tableName,
          Key: catalogKeys.product(p.productId),
          ConditionExpression:
            'attribute_exists(PK) AND #active = :active AND #updated = :expected',
          ExpressionAttributeNames: {
            '#active': 'active',
            '#updated': 'updatedAt',
          },
          ExpressionAttributeValues: {
            ':active': p.active,
            ':expected': p.updatedAt,
          },
        },
      });
    }
    const audit = {
      ...catalogKeys.drop(dropId),
      SK: `ADMIN_CHANGE#${revision}`,
      actor,
      operation: patch ? 'editScheduledDrop' : 'cancelScheduledDrop',
      createdAt: now,
      before: { drop: previous, relations, inventories, pickups },
      after: {
        drop: next,
        relations: nextRelations,
        inventories: nextInventories,
        pickups: nextPickups,
      },
    };
    // Keep the immutable audit item comfortably below DynamoDB's item size limit.
    if (
      Buffer.byteLength(JSON.stringify(audit)) > 300_000 ||
      actions.length >= 100
    )
      throw new CatalogWriteError('DROP_NOT_READY');
    actions.push({
      Put: {
        TableName: this.tableName,
        Item: audit,
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    });
    eligible();
    if (patch && Date.parse(next.opensAt) <= Date.now())
      throw new CatalogWriteError('DROP_NOT_READY');
    await this.sendTransaction(
      actions,
      actions.map((_, index) =>
        index === 0
          ? () => this.lifecycleRevisionFailure(dropId, 'SCHEDULED')
          : index === 1
            ? 'STOREFRONT_CONFLICT'
            : 'COMPOSITION_CONFLICT',
      ),
    );
    return next;
  }
  async pauseDrop(dropId: string): Promise<Drop> {
    return this.pauseOrClose(dropId, 'PAUSED');
  }
  async closeDrop(dropId: string): Promise<Drop> {
    return this.pauseOrClose(dropId, 'CLOSED');
  }
  private async lifecycleRevisionFailure(
    dropId: string,
    source: Drop['status'],
  ): Promise<CatalogWriteError['code']> {
    const current = await this.getDrop(dropId);
    if (!current) return 'DROP_NOT_FOUND';
    return current.status !== source
      ? 'DROP_NOT_EDITABLE'
      : 'COMPOSITION_CONFLICT';
  }
  private async pauseOrClose(
    dropId: string,
    target: 'PAUSED' | 'CLOSED',
  ): Promise<Drop> {
    const previous = await this.getDrop(dropId);
    if (!previous) throw new CatalogWriteError('DROP_NOT_FOUND');
    if (
      previous.status !== 'OPEN' &&
      !(target === 'CLOSED' && previous.status === 'PAUSED')
    )
      throw new CatalogWriteError('DROP_NOT_EDITABLE');
    if ((await this.getStorefrontDropId()) !== dropId)
      throw new CatalogWriteError('STOREFRONT_CONFLICT');
    const next = dropSchema.parse({
      ...previous,
      status: target,
      updatedAt: updatedAt(previous.updatedAt),
    });
    const actions: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      {
        Put: {
          TableName: this.tableName,
          Item: { ...next, ...catalogKeys.drop(dropId) },
          ConditionExpression:
            'attribute_exists(PK) AND #status = :source AND #updated = :expected',
          ExpressionAttributeNames: {
            '#status': 'status',
            '#updated': 'updatedAt',
          },
          ExpressionAttributeValues: {
            ':source': previous.status,
            ':expected': previous.updatedAt,
          },
        },
      },
    ];
    if (target === 'CLOSED')
      actions.push({
        Delete: {
          TableName: this.tableName,
          Key: catalogKeys.storefront,
          ConditionExpression: '#storefrontDropId = :dropId',
          ExpressionAttributeNames: { '#storefrontDropId': 'storefrontDropId' },
          ExpressionAttributeValues: { ':dropId': dropId },
        },
      });
    await this.sendTransaction(actions, [
      () => this.lifecycleRevisionFailure(dropId, previous.status),
      ...(target === 'CLOSED' ? ['STOREFRONT_CONFLICT' as const] : []),
    ]);
    return next;
  }
  async openScheduled(
    dropId: string,
    delivery?: { openingRevision?: string },
  ): Promise<Drop> {
    return this.openFrom(dropId, 'SCHEDULED', delivery);
  }
  async resumeDrop(dropId: string): Promise<Drop> {
    return this.openFrom(dropId, 'PAUSED');
  }
  private async openFrom(
    dropId: string,
    source: 'SCHEDULED' | 'PAUSED',
    delivery?: { openingRevision?: string },
  ): Promise<Drop> {
    let snapshot: OpenSnapshot;
    try {
      // Read META first so its revision protects the subsequent composition reads.
      const drop = await this.getDrop(dropId);
      if (!drop) throw new CatalogWriteError('DROP_NOT_FOUND');
      if (delivery && delivery.openingRevision !== drop.openingRevision)
        throw new CatalogWriteError('STALE_OPENING');
      if (drop.status !== source)
        throw new CatalogWriteError('DROP_NOT_EDITABLE');
      if ((await this.getStorefrontDropId()) !== dropId)
        throw new CatalogWriteError('STOREFRONT_CONFLICT');
      const [relations, inventories, pickups] = await Promise.all([
        this.getDropProducts(dropId),
        this.getDropInventory(dropId),
        this.getPickupDates(dropId),
      ]);
      const products = [];
      for (const relation of relations.filter((item) => item.active)) {
        products.push(await this.getProduct(relation.productId));
      }
      snapshot = { drop, relations, inventories, pickups, products };
    } catch (error) {
      if (error instanceof z.ZodError)
        throw new CatalogWriteError('DROP_NOT_READY');
      throw error;
    }
    // Evaluate server time after loading: opensAt may pass during those reads.
    if (!isOpenReady(snapshot, Date.now(), source))
      throw new CatalogWriteError('DROP_NOT_READY');
    const { drop, products } = snapshot;
    const actionCount = 2 + products.length;
    if (actionCount > 100) throw new CatalogWriteError('DROP_NOT_READY');
    const opened = dropSchema.parse({
      ...drop,
      status: 'OPEN',
      updatedAt: updatedAt(drop.updatedAt),
    });
    const sourceToken = source === 'SCHEDULED' ? ':scheduled' : ':paused';
    const actions: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      {
        Put: {
          TableName: this.tableName,
          Item: { ...opened, ...catalogKeys.drop(dropId) },
          ConditionExpression: `attribute_exists(PK) AND #status = ${sourceToken} AND #updated = :expected`,
          ExpressionAttributeNames: {
            '#status': 'status',
            '#updated': 'updatedAt',
          },
          ExpressionAttributeValues: {
            [sourceToken]: source,
            ':expected': drop.updatedAt,
          },
        },
      },
      {
        ConditionCheck: {
          TableName: this.tableName,
          Key: catalogKeys.storefront,
          ConditionExpression: '#storefrontDropId = :dropId',
          ExpressionAttributeNames: { '#storefrontDropId': 'storefrontDropId' },
          ExpressionAttributeValues: { ':dropId': dropId },
        },
      },
      ...products.map((product) => {
        if (!product) throw new CatalogWriteError('DROP_NOT_READY');
        return {
          ConditionCheck: {
            TableName: this.tableName,
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
      }),
    ];
    await this.sendTransaction(actions, [
      () => this.lifecycleRevisionFailure(dropId, source),
      'STOREFRONT_CONFLICT',
      ...products.map(() => 'COMPOSITION_CONFLICT' as const),
    ]);
    return opened;
  }
  private inventoryZeroCondition() {
    return {
      ConditionExpression:
        'attribute_exists(PK) AND #reserved = :zero AND #sold = :zero',
      ExpressionAttributeNames: { '#reserved': 'reserved', '#sold': 'sold' },
      ExpressionAttributeValues: { ':zero': 0 },
    };
  }
  private async inventoryFailure(
    dropId: string,
    productId: string,
  ): Promise<CatalogWriteError['code']> {
    const current = await this.get(
      catalogKeys.inventory(dropId, productId),
      inventorySchema,
    );
    return current && (current.reserved !== 0 || current.sold !== 0)
      ? 'INVENTORY_NOT_EDITABLE'
      : 'COMPOSITION_CONFLICT';
  }
  private async writeDropProduct(
    item: DropProduct,
    inventoryTotal: number,
    creating: boolean,
  ) {
    const relation = dropProductSchema.parse(item);
    const inventory = inventorySchema.parse({
      dropId: relation.dropId,
      productId: relation.productId,
      total: inventoryTotal,
      reserved: 0,
      sold: 0,
      updatedAt: new Date().toISOString(),
    });
    await this.transact(
      relation.dropId,
      [
        this.productCheck(relation.productId),
        {
          Put: {
            TableName: this.tableName,
            Item: {
              ...relation,
              ...catalogKeys.dropProduct(relation.dropId, relation.productId),
            },
            ConditionExpression: creating
              ? 'attribute_not_exists(PK)'
              : 'attribute_exists(PK)',
          },
        },
        {
          Put: {
            TableName: this.tableName,
            Item: {
              ...inventory,
              ...catalogKeys.inventory(relation.dropId, relation.productId),
            },
            ...(creating
              ? { ConditionExpression: 'attribute_not_exists(PK)' }
              : this.inventoryZeroCondition()),
          },
        },
      ],
      [
        'PRODUCT_NOT_FOUND',
        creating ? 'DROP_PRODUCT_CONFLICT' : 'DROP_PRODUCT_NOT_FOUND',
        creating
          ? 'DROP_PRODUCT_CONFLICT'
          : () => this.inventoryFailure(relation.dropId, relation.productId),
      ],
    );
    return inventory;
  }
  attachDropProduct(item: DropProduct, inventoryTotal: number) {
    return this.writeDropProduct(item, inventoryTotal, true);
  }
  replaceDropProduct(item: DropProduct, inventoryTotal: number) {
    return this.writeDropProduct(item, inventoryTotal, false);
  }
  async removeDropProduct(dropId: string, productId: string) {
    await this.transact(
      dropId,
      [
        {
          Delete: {
            TableName: this.tableName,
            Key: catalogKeys.dropProduct(dropId, productId),
            ConditionExpression: 'attribute_exists(PK)',
          },
        },
        {
          Delete: {
            TableName: this.tableName,
            Key: catalogKeys.inventory(dropId, productId),
            ...this.inventoryZeroCondition(),
          },
        },
      ],
      [
        'DROP_PRODUCT_NOT_FOUND',
        () => this.inventoryFailure(dropId, productId),
      ],
    );
  }
  async putPickup(item: PickupDate) {
    const pickup = pickupSchema.parse(item);
    await this.transact(
      pickup.dropId,
      [
        {
          Put: {
            TableName: this.tableName,
            Item: {
              ...pickup,
              ...catalogKeys.pickup(pickup.dropId, pickup.date),
            },
          },
        },
      ],
      ['COMPOSITION_CONFLICT'],
    );
  }
  async removePickup(dropId: string, date: string) {
    await this.transact(
      dropId,
      [
        {
          Delete: {
            TableName: this.tableName,
            Key: catalogKeys.pickup(dropId, date),
            ConditionExpression: 'attribute_exists(PK)',
          },
        },
      ],
      ['PICKUP_NOT_FOUND'],
    );
  }
  private async put(item: Product | Drop, key: Key, previous?: Product | Drop) {
    const draft = 'dropId' in item;
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...item, ...key },
          ConditionExpression: previous
            ? 'attribute_exists(PK) AND #created = :created AND #updated = :updated' +
              (draft ? ' AND #status = :draft' : '')
            : 'attribute_not_exists(PK)',
          ...(previous
            ? {
                ExpressionAttributeNames: {
                  '#created': 'createdAt',
                  '#updated': 'updatedAt',
                  ...(draft ? { '#status': 'status' } : {}),
                },
                ExpressionAttributeValues: {
                  ':created': previous.createdAt,
                  ':updated': previous.updatedAt,
                  ...(draft ? { ':draft': 'DRAFT' } : {}),
                },
              }
            : {}),
        }),
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.name !== 'ConditionalCheckFailedException'
      )
        throw error;
      if (previous) {
        const current = draft
          ? await this.getDrop(item.dropId)
          : await this.getProduct(item.productId);
        if (!current)
          throw new CatalogWriteError(
            draft ? 'DROP_NOT_FOUND' : 'PRODUCT_NOT_FOUND',
          );
        if ('status' in current && current.status !== 'DRAFT')
          throw new CatalogWriteError('DROP_NOT_EDITABLE');
      }
      throw new CatalogWriteError(draft ? 'DROP_CONFLICT' : 'PRODUCT_CONFLICT');
    }
  }
  async getProductCreation(identity: CreationIdentity) {
    return (
      await new ProductIntegrity(this.client, this.tableName).result(identity)
    )?.product;
  }
  async createProduct(product: Product, identity?: CreationIdentity) {
    const item = productSchema.parse(product);
    return new ProductIntegrity(this.client, this.tableName).create(
      item,
      identity!,
    );
  }
  async replaceProduct(product: Product, previous: Product) {
    const item = productSchema.parse(product);
    productSchema.parse(previous);
    this.assertReplacement(
      item,
      previous,
      item.productId === previous.productId,
    );
    await new ProductIntegrity(this.client, this.tableName).replace(
      item,
      previous,
    );
  }
  async createDraftDrop(drop: Drop) {
    const item = dropSchema.parse(drop);
    if (item.status !== 'DRAFT')
      throw new CatalogWriteError('DROP_NOT_EDITABLE');
    await this.put(item, catalogKeys.drop(item.dropId));
  }
  async replaceDraftDrop(drop: Drop, previous: Drop) {
    const item = dropSchema.parse(drop);
    dropSchema.parse(previous);
    if (item.status !== 'DRAFT' || previous.status !== 'DRAFT')
      throw new CatalogWriteError('DROP_NOT_EDITABLE');
    this.assertReplacement(item, previous, item.dropId === previous.dropId);
    await this.put(item, catalogKeys.drop(item.dropId), previous);
  }
  private assertReplacement(
    item: Product | Drop,
    previous: Product | Drop,
    sameId: boolean,
  ) {
    if (
      !sameId ||
      item.createdAt !== previous.createdAt ||
      Date.parse(item.updatedAt) <= Date.parse(previous.updatedAt)
    )
      throw new Error('Invalid catalog replacement');
  }
  private async get<T>(key: Key, schema: z.ZodType<T>): Promise<T | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: key,
        ConsistentRead: true,
      }),
    );
    return result.Item ? decode(result.Item, schema, key) : undefined;
  }
  async listProducts(cursor?: { PK: string; SK: string }) {
    // One bounded page; filtered empty pages can still have a continuation.
    const result = await this.client.send(
      new ScanCommand({
        TableName: this.tableName,
        Limit: 100,
        ConsistentRead: true,
        ExclusiveStartKey: cursor,
        FilterExpression: 'begins_with(#pk, :product) AND #sk = :meta',
        ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
        ExpressionAttributeValues: { ':product': 'PRODUCT#', ':meta': 'META' },
      }),
    );
    const products = (result.Items ?? []).map((item) => {
      const { PK: _pk, SK: _sk, ...data } = item;
      const product = productSchema.parse(data);
      return decode(
        item,
        productSchema,
        catalogKeys.product(product.productId),
      );
    });
    const key = result.LastEvaluatedKey;
    return {
      products,
      ...(key && Object.keys(key).length
        ? {
            cursor: z
              .strictObject({
                PK: z.string().min(1).max(2048),
                SK: z.string().min(1).max(1024),
              })
              .parse(key),
          }
        : {}),
    };
  }
  async getProduct(productId: string) {
    const result = await this.get(
      catalogKeys.product(productId),
      productSchema,
    );
    if (result && result.productId !== productId)
      throw new Error('Product identity mismatch');
    return result;
  }
  async getDrop(dropId: string) {
    const result = await this.get(catalogKeys.drop(dropId), dropSchema);
    if (result && result.dropId !== dropId)
      throw new Error('Drop identity mismatch');
    return result;
  }
  private async query<T extends { dropId: string }>(
    dropId: string,
    prefix: string,
    schema: z.ZodType<T>,
    keyFor: (item: T) => Key,
  ): Promise<T[]> {
    const PK = catalogKeys.drop(dropId).PK;
    const items: T[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
          ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
          ExpressionAttributeValues: { ':pk': PK, ':prefix': prefix },
          ConsistentRead: true,
          ExclusiveStartKey: cursor,
        }),
      );
      for (const item of result.Items ?? []) {
        const { PK: _pk, SK: _sk, ...data } = item;
        const parsed = schema.parse(data);
        if (parsed.dropId !== dropId)
          throw new Error('Drop relationship mismatch');
        items.push(decode(item, schema, keyFor(parsed)));
      }
      cursor = result.LastEvaluatedKey;
    } while (cursor && Object.keys(cursor).length > 0);
    return items;
  }
  getDropProducts(dropId: string) {
    return this.query(dropId, 'PRODUCT#', dropProductSchema, (item) =>
      catalogKeys.dropProduct(item.dropId, item.productId),
    );
  }
  getDropInventory(dropId: string) {
    return this.query(dropId, 'INVENTORY#', inventorySchema, (item) =>
      catalogKeys.inventory(item.dropId, item.productId),
    );
  }
  getPickupDates(dropId: string) {
    return this.query(dropId, 'PICKUP#', pickupSchema, (item) =>
      catalogKeys.pickup(item.dropId, item.date),
    );
  }
  async getStorefrontDropId() {
    return (await this.get(catalogKeys.storefront, storefrontSchema))
      ?.storefrontDropId;
  }
  async getStorefrontDrop() {
    const id = await this.getStorefrontDropId();
    return id ? this.getDrop(id) : undefined;
  }
}
