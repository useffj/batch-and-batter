import {
  dropSchema,
  productSchema,
  dropProductSchema,
  inventorySchema,
  pickupSchema,
  type Drop,
  type Product,
  type DropProduct,
  type DropInventory,
  type PickupDate,
} from './domain';

export interface PublishSnapshot {
  drop: Drop;
  relations: DropProduct[];
  inventories: DropInventory[];
  pickups: PickupDate[];
  products: (Product | undefined)[];
}
export function isPublishReady(
  snapshot: PublishSnapshot,
  now: number,
): boolean {
  const { drop, relations, inventories, pickups, products } = snapshot;
  if (
    !dropSchema.safeParse(drop).success ||
    drop.status !== 'DRAFT' ||
    Date.parse(drop.opensAt) <= now
  )
    return false;
  if (
    !relations.every(
      (item) =>
        dropProductSchema.safeParse(item).success &&
        item.dropId === drop.dropId,
    ) ||
    !inventories.every(
      (item) =>
        inventorySchema.safeParse(item).success && item.dropId === drop.dropId,
    ) ||
    !pickups.every(
      (item) =>
        pickupSchema.safeParse(item).success && item.dropId === drop.dropId,
    ) ||
    !products.every((item) => productSchema.safeParse(item).success)
  )
    return false;
  const relationIds = new Set(relations.map((item) => item.productId));
  const inventoryById = new Map(
    inventories.map((item) => [item.productId, item]),
  );
  const productById = new Map(
    products
      .filter((item): item is Product => !!item)
      .map((item) => [item.productId, item]),
  );
  if (
    relationIds.size !== relations.length ||
    inventoryById.size !== inventories.length ||
    productById.size !== products.length ||
    new Set(pickups.map((item) => item.date)).size !== pickups.length ||
    relationIds.size !== inventoryById.size ||
    relationIds.size !== productById.size
  )
    return false;
  if (!relations.some((item) => item.active)) return false;
  for (const relation of relations) {
    const product = productById.get(relation.productId);
    const inventory = inventoryById.get(relation.productId);
    if (!product || !inventory) return false;
    if (
      relation.active &&
      (!product.active ||
        relation.priceCents <= 0 ||
        relation.cookieUnits <= 0 ||
        inventory.total <= 0 ||
        inventory.reserved !== 0 ||
        inventory.sold !== 0)
    )
      return false;
  }
  // Build an ISO calendar date explicitly, without relying on locale-specific field ordering.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: drop.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(drop.opensAt));
  const part = (type: string) =>
    parts.find((entry) => entry.type === type)!.value;
  const openingDate = `${part('year')}-${part('month')}-${part('day')}`;
  const activePickups = pickups.filter((item) => item.active);
  return (
    activePickups.length > 0 &&
    activePickups.every((item) => item.date >= openingDate)
  );
}
