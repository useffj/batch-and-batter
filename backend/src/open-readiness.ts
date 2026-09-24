import {
  dropSchema,
  dropProductSchema,
  inventorySchema,
  pickupSchema,
  productSchema,
  type Drop,
  type DropProduct,
  type DropInventory,
  type PickupDate,
  type Product,
} from './domain';

export interface OpenSnapshot {
  drop: Drop;
  relations: DropProduct[];
  inventories: DropInventory[];
  pickups: PickupDate[];
  // Only active associations require independently mutable Product records.
  products: (Product | undefined)[];
}

export function isOpenReady(snapshot: OpenSnapshot, now: number): boolean {
  const { drop, relations, inventories, pickups, products } = snapshot;
  if (
    !Number.isFinite(now) ||
    !dropSchema.safeParse(drop).success ||
    drop.status !== 'SCHEDULED' ||
    now < Date.parse(drop.opensAt)
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
  const active = relations.filter((item) => item.active);
  if (
    !active.length ||
    !pickups.some((item) => item.active) ||
    relationIds.size !== relations.length ||
    inventoryById.size !== inventories.length ||
    relationIds.size !== inventoryById.size ||
    !relations.every((item) => inventoryById.has(item.productId)) ||
    new Set(pickups.map((item) => item.date)).size !== pickups.length ||
    productById.size !== products.length ||
    productById.size !== active.length
  )
    return false;
  return active.every((item) => {
    const product = productById.get(item.productId);
    const inventory = inventoryById.get(item.productId)!;
    // Opening preserves current inventory. Its schema enforces nonnegative counts
    // and reserved + sold <= total; it does not reset or manufacture availability.
    return (
      product?.active === true &&
      inventory.total > 0 &&
      item.priceCents > 0 &&
      item.cookieUnits > 0
    );
  });
}
