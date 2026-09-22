import {
  availableInventory,
  isCustomerVisible,
  type Drop,
  type VisibleDropStatus,
} from './domain';
import type { CatalogRepository } from './repository';

export interface ProductResponse {
  id: string;
  name: string;
  slug: string;
  description: string;
  ingredients: string[];
  allergens: string[];
  priceCents: number;
  cookieUnits: number;
  displayOrder: number;
  availability: {
    total: number;
    reserved: number;
    sold: number;
    available: number;
  };
}
export interface PickupResponse {
  date: string;
  startTime: string;
  endTime: string;
  timezone: string;
}
export interface DropResponse {
  id: string;
  name: string;
  description: string;
  status: VisibleDropStatus;
  opensAt: string;
  closesAt?: string;
  quantityLimit: number;
  timezone: string;
  pickupLocation: string;
  pickupInstructions: string;
  products: ProductResponse[];
  pickupDates: PickupResponse[];
}
export interface CurrentDropResponse {
  drop: DropResponse | null;
}

export async function composeDrop(
  repository: CatalogRepository,
  drop: Drop,
): Promise<DropResponse | null> {
  if (!isCustomerVisible(drop.status)) return null;
  const [relations, inventory, pickupDates] = await Promise.all([
    repository.getDropProducts(drop.dropId),
    repository.getDropInventory(drop.dropId),
    repository.getPickupDates(drop.dropId),
  ]);
  const inventoryByProduct = new Map(
    inventory.map((item) => [item.productId, item]),
  );
  const products: ProductResponse[] = [];
  // Sequential reads bound fan-out; a weekly menu is small. All are point Gets.
  for (const relation of relations.filter((item) => item.active)) {
    const product = await repository.getProduct(relation.productId);
    if (!product) throw new Error('Catalog product missing');
    if (!product.active) continue;
    const stock = inventoryByProduct.get(product.productId);
    if (!stock) throw new Error('Catalog inventory missing');
    products.push({
      id: product.productId,
      name: product.name,
      slug: product.slug,
      description: product.description,
      ingredients: product.ingredients,
      allergens: product.allergens,
      priceCents: relation.priceCents,
      cookieUnits: relation.cookieUnits,
      displayOrder: relation.displayOrder,
      availability: {
        total: stock.total,
        reserved: stock.reserved,
        sold: stock.sold,
        available: availableInventory(stock),
      },
    });
  }
  products.sort(
    (a, b) => a.displayOrder - b.displayOrder || a.id.localeCompare(b.id),
  );
  return {
    id: drop.dropId,
    name: drop.name,
    description: drop.description,
    status: drop.status,
    opensAt: drop.opensAt,
    ...(drop.closesAt ? { closesAt: drop.closesAt } : {}),
    quantityLimit: drop.quantityLimit,
    timezone: drop.timezone,
    pickupLocation: drop.pickupLocation,
    pickupInstructions: drop.pickupInstructions,
    products,
    pickupDates: pickupDates
      .filter((item) => item.active)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((item) => ({
        date: item.date,
        startTime: item.startTime,
        endTime: item.endTime,
        timezone: item.timezone,
      })),
  };
}
