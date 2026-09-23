import { z } from 'zod';
import type { ApiEvent } from './api';
import { body, validate, dropDto, productDto } from './admin-writes';
import { CatalogWriteError, type CatalogRepository } from './repository';
import {
  idSchema,
  dateSchema,
  dropProductSchema,
  inventorySchema,
  pickupSchema,
  type DropProduct,
  type DropInventory,
  type PickupDate,
} from './domain';

export const compositionRoutes = [
  'GET /admin/drops/{dropId}/composition',
  'POST /admin/drops/{dropId}/products',
  'PUT /admin/drops/{dropId}/products/{productId}',
  'DELETE /admin/drops/{dropId}/products/{productId}',
  'PUT /admin/drops/{dropId}/pickups/{date}',
  'DELETE /admin/drops/{dropId}/pickups/{date}',
];
const configurationFields = {
  priceCents: dropProductSchema.shape.priceCents,
  cookieUnits: dropProductSchema.shape.cookieUnits,
  displayOrder: dropProductSchema.shape.displayOrder,
  active: dropProductSchema.shape.active,
  inventoryTotal: inventorySchema.shape.total,
};
const attachInput = z.strictObject({
  productId: idSchema,
  ...configurationFields,
});
const replaceInput = z.strictObject(configurationFields);
const pickupInput = z
  .strictObject({
    startTime: pickupSchema.shape.startTime,
    endTime: pickupSchema.shape.endTime,
    timezone: pickupSchema.shape.timezone,
    active: pickupSchema.shape.active,
  })
  .refine(
    (item) => item.endTime > item.startTime,
    'endTime must follow startTime',
  );

function dropProductDto(item: DropProduct) {
  return {
    dropId: item.dropId,
    productId: item.productId,
    priceCents: item.priceCents,
    cookieUnits: item.cookieUnits,
    displayOrder: item.displayOrder,
    active: item.active,
  };
}
function inventoryDto(item: DropInventory) {
  return {
    dropId: item.dropId,
    productId: item.productId,
    total: item.total,
    reserved: item.reserved,
    sold: item.sold,
    updatedAt: item.updatedAt,
    available: item.total - item.reserved - item.sold,
  };
}
function pickupDto(item: PickupDate) {
  return {
    dropId: item.dropId,
    date: item.date,
    startTime: item.startTime,
    endTime: item.endTime,
    timezone: item.timezone,
    active: item.active,
  };
}
export async function adminComposition(
  event: ApiEvent,
  getRepository: () => CatalogRepository,
) {
  const dropId = validate(idSchema, event.pathParameters?.dropId);
  const method = event.requestContext.http.method;
  if (method === 'GET') {
    const repository = getRepository();
    const drop = await repository.getDrop(dropId);
    if (!drop) throw new CatalogWriteError('DROP_NOT_FOUND');
    const [relations, inventories, pickups] = await Promise.all([
      repository.getDropProducts(dropId),
      repository.getDropInventory(dropId),
      repository.getPickupDates(dropId),
    ]);
    const products = [];
    for (const relation of relations.sort(
      (a, b) =>
        a.displayOrder - b.displayOrder ||
        a.productId.localeCompare(b.productId),
    )) {
      const product = await repository.getProduct(relation.productId);
      // Null explicitly surfaces a broken reference; inventory is returned separately, including orphans.
      products.push({
        product: product ? productDto(product) : null,
        dropProduct: dropProductDto(relation),
      });
    }
    return {
      status: 200,
      body: {
        drop: dropDto(drop),
        products,
        inventory: inventories
          .sort((a, b) => a.productId.localeCompare(b.productId))
          .map(inventoryDto),
        pickupDates: pickups
          .sort((a, b) => a.date.localeCompare(b.date))
          .map(pickupDto),
      },
    };
  }
  if (event.routeKey.includes('/pickups/')) {
    const date = validate(dateSchema, event.pathParameters?.date);
    if (method === 'DELETE') {
      await getRepository().removePickup(dropId, date);
      return { status: 200, body: { deleted: true } };
    }
    const fields = validate(pickupInput, body(event));
    const pickup = validate(pickupSchema, { ...fields, dropId, date });
    await getRepository().putPickup(pickup);
    return { status: 200, body: { pickup: pickupDto(pickup) } };
  }
  if (method === 'DELETE') {
    const productId = validate(idSchema, event.pathParameters?.productId);
    await getRepository().removeDropProduct(dropId, productId);
    return { status: 200, body: { deleted: true } };
  }
  const creating = method === 'POST';
  const fields = creating
    ? validate(attachInput, body(event))
    : validate(replaceInput, body(event));
  const productId = creating
    ? (fields as z.infer<typeof attachInput>).productId
    : validate(idSchema, event.pathParameters?.productId);
  const { inventoryTotal } = fields;
  const relation = validate(dropProductSchema, {
    dropId,
    productId,
    priceCents: fields.priceCents,
    cookieUnits: fields.cookieUnits,
    displayOrder: fields.displayOrder,
    active: fields.active,
  });
  const repository = getRepository();
  const inventory = creating
    ? await repository.attachDropProduct(relation, inventoryTotal)
    : await repository.replaceDropProduct(relation, inventoryTotal);
  return {
    status: creating ? 201 : 200,
    body: {
      dropProduct: dropProductDto(relation),
      inventory: inventoryDto(inventory),
    },
  };
}
