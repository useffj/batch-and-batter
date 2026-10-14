import { validateIdentity } from './product-integrity';
import { z } from 'zod';
import type { ApiEvent } from './api';
import type { CatalogRepository } from './repository';
import { idSchema, type Product } from './domain';
import { AdminError } from './admin-auth';
import { productDto, validate } from './admin-writes';
// Limits include JSON string escaping and UTF-8 encoding; stored values are untouched.
export function summaryText(value: string, maxBytes: number) {
  let text = '',
    bytes = 2;
  for (const character of value) {
    const size = Buffer.byteLength(JSON.stringify(character), 'utf8') - 2;
    if (bytes + size > maxBytes) break;
    text += character;
    bytes += size;
  }
  return { text, truncated: text.length !== value.length };
}
export function productSummary(product: Product) {
  const name = summaryText(product.name, 512);
  const description = summaryText(product.description, 1024);
  return {
    productId: product.productId,
    name: name.text,
    nameTruncated: name.truncated,
    description: description.text,
    descriptionTruncated: description.truncated,
    active: product.active,
  };
}
export const catalogRoutes = [
  'GET /admin/products',
  'GET /admin/products/{productId}',
];
export async function adminCatalog(
  event: ApiEvent,
  repository: () => CatalogRepository,
  subject?: string,
) {
  if (event.routeKey === catalogRoutes[1]) {
    const id = validate(idSchema, event.pathParameters?.productId);
    const product = await repository().getProduct(id);
    if (!product)
      throw new AdminError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
    return { status: 200, body: { product: productDto(product) } };
  }
  const requestKey = event.queryStringParameters?.creationKey;
  if (requestKey !== undefined) {
    if (event.queryStringParameters?.cursor !== undefined)
      throw new AdminError(
        400,
        'VALIDATION_ERROR',
        'Conflicting catalog query.',
      );
    const product = await repository().getProductCreation(
      validateIdentity({ subject: subject!, key: requestKey }),
    );
    return {
      status: 200,
      body: { creation: product ? productDto(product) : null },
    };
  }
  let cursor: { PK: string; SK: string } | undefined;
  const encoded = event.queryStringParameters?.cursor;
  if (encoded !== undefined) {
    try {
      if (!/^[A-Za-z0-9_-]{1,8192}$/.test(encoded)) throw new Error();
      const decoded = Buffer.from(encoded, 'base64url');
      if (decoded.toString('base64url') !== encoded) throw new Error();
      cursor = z
        .strictObject({
          PK: z.string().min(1).max(2048),
          SK: z.string().min(1).max(1024),
        })
        .parse(JSON.parse(decoded.toString()));
    } catch {
      throw new AdminError(400, 'VALIDATION_ERROR', 'Invalid catalog cursor.');
    }
  }
  const page = await repository().listProducts(cursor);
  return {
    status: 200,
    body: {
      products: page.products.map(productSummary),
      nextCursor: page.cursor
        ? Buffer.from(JSON.stringify(page.cursor)).toString('base64url')
        : null,
    },
  };
}
