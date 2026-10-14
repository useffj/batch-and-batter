import {
  productSchema,
  dropSchema,
  dropProductSchema,
  inventorySchema,
  pickupSchema,
} from '../src/domain';
import type { CatalogRepository } from '../src/repository';
export const dropId = '01K5J100000000000000000001';
export const productId = '01K5J100000000000000000002';
export const otherProductId = '01K5J100000000000000000003';
export const timestamp = '2026-09-22T12:00:00.000Z';
export const product = productSchema.parse({
  productId,
  name: 'Cookie',
  slug: 'cookie',
  description: 'A cookie',
  ingredients: ['Flour'],
  allergens: ['Wheat'],
  active: true,
  createdAt: timestamp,
  updatedAt: timestamp,
});
export const drop = dropSchema.parse({
  dropId,
  name: 'Test Drop',
  description: 'Test',
  status: 'OPEN',
  opensAt: timestamp,
  pickupLocation: 'Test location',
  pickupInstructions: 'Test instructions',
  createdAt: timestamp,
  updatedAt: timestamp,
});
export const relation = dropProductSchema.parse({
  dropId,
  productId,
  priceCents: 450,
  cookieUnits: 1,
  displayOrder: 0,
  active: true,
});
export const inventory = inventorySchema.parse({
  dropId,
  productId,
  total: 100,
  reserved: 8,
  sold: 62,
  updatedAt: timestamp,
});
export const pickup = pickupSchema.parse({
  dropId,
  date: '2026-10-01',
  startTime: '16:00',
  endTime: '19:00',
  active: true,
});
export function fakeRepository(
  overrides: Partial<CatalogRepository> = {},
): CatalogRepository {
  return {
    getProductCreation: async () => undefined,
    listProducts: async () => ({ products: [] }),
    changeScheduled: async () => {
      throw new Error('Unexpected scheduled change');
    },
    pauseDrop: async () => {
      throw new Error('Unexpected pause');
    },
    resumeDrop: async () => {
      throw new Error('Unexpected resume');
    },
    closeDrop: async () => {
      throw new Error('Unexpected close');
    },
    openScheduled: async () => {
      throw new Error('Unexpected open');
    },
    publishDraft: async () => {
      throw new Error('Unexpected publish');
    },
    attachDropProduct: async () => {
      throw new Error('Unexpected write');
    },
    replaceDropProduct: async () => {
      throw new Error('Unexpected write');
    },
    removeDropProduct: async () => {
      throw new Error('Unexpected write');
    },
    putPickup: async () => {
      throw new Error('Unexpected write');
    },
    removePickup: async () => {
      throw new Error('Unexpected write');
    },
    createProduct: async () => {
      throw new Error('Unexpected write');
    },
    replaceProduct: async () => {
      throw new Error('Unexpected write');
    },
    createDraftDrop: async () => {
      throw new Error('Unexpected write');
    },
    replaceDraftDrop: async () => {
      throw new Error('Unexpected write');
    },
    getProduct: async () => product,
    getDrop: async () => drop,
    getDropProducts: async () => [relation],
    getDropInventory: async () => [inventory],
    getPickupDates: async () => [pickup],
    getStorefrontDropId: async () => dropId,
    getStorefrontDrop: async () => drop,
    ...overrides,
  };
}
