import {
  GetCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { catalogKeys } from './keys';
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
  getProduct(productId: string): Promise<Product | undefined>;
  getDrop(dropId: string): Promise<Drop | undefined>;
  getDropProducts(dropId: string): Promise<DropProduct[]>;
  getDropInventory(dropId: string): Promise<DropInventory[]>;
  getPickupDates(dropId: string): Promise<PickupDate[]>;
  getStorefrontDropId(): Promise<string | undefined>;
  getStorefrontDrop(): Promise<Drop | undefined>;
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
