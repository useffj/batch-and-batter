import { z } from 'zod';
import type { ApiEvent } from './api';
import { AdminError } from './admin-auth';
import {
  productSchema,
  dropSchema,
  idSchema,
  type Product,
  type Drop,
} from './domain';
import type { CatalogRepository } from './repository';
import { generateUlid } from './ulid';

const productInput = productSchema.omit({
  productId: true,
  createdAt: true,
  updatedAt: true,
});
// Construct from the existing field schemas; validate cross-field rules on the complete Drop below.
const dropInput = z.strictObject({
  name: dropSchema.shape.name,
  description: dropSchema.shape.description,
  opensAt: dropSchema.shape.opensAt,
  closesAt: dropSchema.shape.closesAt,
  quantityLimit: dropSchema.shape.quantityLimit,
  timezone: dropSchema.shape.timezone,
  pickupLocation: dropSchema.shape.pickupLocation,
  pickupInstructions: dropSchema.shape.pickupInstructions,
});

function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new AdminError(400, 'VALIDATION_ERROR', 'Invalid request data.');
  return parsed.data;
}
function body(event: ApiEvent): unknown {
  try {
    if (typeof event.body !== 'string') throw new Error();
    return JSON.parse(
      event.isBase64Encoded
        ? Buffer.from(event.body, 'base64').toString('utf8')
        : event.body,
    );
  } catch {
    throw new AdminError(
      400,
      'VALIDATION_ERROR',
      'A JSON request body is required.',
    );
  }
}
function updatedAt(previous?: string): string {
  // Ensure every successful replacement advances the concurrency marker, even within one millisecond.
  return new Date(
    Math.max(Date.now(), previous ? Date.parse(previous) + 1 : 0),
  ).toISOString();
}
function productDto(item: Product) {
  return {
    productId: item.productId,
    name: item.name,
    slug: item.slug,
    description: item.description,
    ingredients: item.ingredients,
    allergens: item.allergens,
    active: item.active,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}
function dropDto(item: Drop) {
  return {
    dropId: item.dropId,
    name: item.name,
    description: item.description,
    status: item.status,
    opensAt: item.opensAt,
    closesAt: item.closesAt,
    quantityLimit: item.quantityLimit,
    timezone: item.timezone,
    pickupLocation: item.pickupLocation,
    pickupInstructions: item.pickupInstructions,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export const adminWriteRoutes = [
  'POST /admin/products',
  'PUT /admin/products/{productId}',
  'POST /admin/drops',
  'PUT /admin/drops/{dropId}',
];

export async function adminWrite(
  event: ApiEvent,
  getRepository: () => CatalogRepository,
) {
  const creating = event.requestContext.http.method === 'POST';
  const isProduct = event.routeKey.includes('/products');
  const input = body(event);
  if (isProduct) {
    const fields = validate(productInput, input);
    const productId = creating
      ? generateUlid()
      : validate(idSchema, event.pathParameters?.productId);
    const repository = getRepository();
    const previous = creating
      ? undefined
      : await repository.getProduct(productId);
    if (!creating && !previous)
      throw new AdminError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
    const now = updatedAt(previous?.updatedAt);
    const product = validate(productSchema, {
      ...fields,
      productId,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    });
    if (previous) await repository.replaceProduct(product, previous);
    else await repository.createProduct(product);
    return {
      status: creating ? 201 : 200,
      body: { product: productDto(product) },
    };
  }
  const fields = validate(dropInput, input);
  const dropId = creating
    ? generateUlid()
    : validate(idSchema, event.pathParameters?.dropId);
  // Cross-field validation happens before repository access on both create and replace.
  const now = updatedAt();
  let drop = validate(dropSchema, {
    ...fields,
    dropId,
    status: 'DRAFT',
    createdAt: now,
    updatedAt: now,
  });
  const repository = getRepository();
  const previous = creating ? undefined : await repository.getDrop(dropId);
  if (!creating && !previous)
    throw new AdminError(404, 'DROP_NOT_FOUND', 'Drop not found.');
  if (previous) {
    if (previous.status !== 'DRAFT')
      throw new AdminError(
        409,
        'DROP_NOT_EDITABLE',
        'Only DRAFT Drops can be edited.',
      );
    drop = validate(dropSchema, {
      ...drop,
      createdAt: previous.createdAt,
      updatedAt: updatedAt(previous.updatedAt),
    });
    await repository.replaceDraftDrop(drop, previous);
  } else await repository.createDraftDrop(drop);
  return { status: creating ? 201 : 200, body: { drop: dropDto(drop) } };
}
