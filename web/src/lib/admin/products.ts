import { id, record } from './contract';
export interface ProductFields {
  name: string;
  slug: string;
  description: string;
  ingredients: string[];
  allergens: string[];
  active: boolean;
}
export interface CatalogProduct extends ProductFields {
  productId: string;
  createdAt: string;
  updatedAt: string;
}
export function fieldErrors(
  value: ProductFields,
): Partial<Record<keyof ProductFields, string>> {
  const errors: Partial<Record<keyof ProductFields, string>> = {};
  if (!value.name.trim()) errors.name = 'Enter a cookie name.';
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.slug))
    errors.slug =
      'Use lowercase letters or numbers separated by single hyphens.';
  for (const key of ['ingredients', 'allergens'] as const)
    if (value[key].some((x) => !x.length))
      errors[key] = 'Remove empty entries.';
  return errors;
}
export function productFields(value: unknown): ProductFields {
  const v = record(value);
  const keys = [
    'name',
    'slug',
    'description',
    'ingredients',
    'allergens',
    'active',
  ];
  if (
    Object.keys(v).some((k) => !keys.includes(k)) ||
    typeof v.name !== 'string' ||
    typeof v.slug !== 'string' ||
    typeof v.description !== 'string' ||
    typeof v.active !== 'boolean'
  )
    throw new Error('Invalid product');
  for (const key of ['ingredients', 'allergens'])
    if (
      !Array.isArray(v[key]) ||
      !(v[key] as unknown[]).every((x) => typeof x === 'string' && x.length > 0)
    )
      throw new Error('Invalid product');
  const fields = v as unknown as ProductFields;
  if (Object.keys(fieldErrors(fields)).length)
    throw new Error('Invalid product');
  return { ...fields, name: fields.name.trim() };
}
export function catalogProduct(value: unknown): CatalogProduct {
  const p = record(value);
  const { productId, createdAt, updatedAt, ...fields } = p;
  for (const stamp of [createdAt, updatedAt])
    if (
      typeof stamp !== 'string' ||
      !/^\d{4}-\d\d-\d\dT/.test(stamp) ||
      !Number.isFinite(Date.parse(stamp))
    )
      throw new Error('Invalid product timestamp');
  return {
    ...productFields(fields),
    productId: id(productId),
    createdAt: createdAt as string,
    updatedAt: updatedAt as string,
  };
}
export interface CatalogSummary {
  productId: string;
  name: string;
  description: string;
  nameTruncated: boolean;
  descriptionTruncated: boolean;
  active: boolean;
}
export function summaryOf(p: CatalogProduct): CatalogSummary {
  const clip = (value: string, limit: number) => {
    let text = '',
      bytes = 2;
    for (const character of value) {
      const size =
        new TextEncoder().encode(JSON.stringify(character)).length - 2;
      if (bytes + size > limit) break;
      text += character;
      bytes += size;
    }
    return { text, truncated: text.length !== value.length };
  };
  const name = clip(p.name, 512),
    description = clip(p.description, 1024);
  return {
    productId: p.productId,
    name: name.text,
    description: description.text,
    nameTruncated: name.truncated,
    descriptionTruncated: description.truncated,
    active: p.active,
  };
}
export function catalogSummary(value: unknown): CatalogSummary {
  const p = record(value);
  if (
    typeof p.name !== 'string' ||
    !p.name.trim() ||
    typeof p.description !== 'string' ||
    typeof p.active !== 'boolean' ||
    typeof p.nameTruncated !== 'boolean' ||
    typeof p.descriptionTruncated !== 'boolean' ||
    new TextEncoder().encode(JSON.stringify(p.name)).length > 512 ||
    new TextEncoder().encode(JSON.stringify(p.description)).length > 1024
  )
    throw new Error('Invalid product summary');
  return {
    productId: id(p.productId),
    name: p.name,
    description: p.description,
    active: p.active,
    nameTruncated: p.nameTruncated,
    descriptionTruncated: p.descriptionTruncated,
  };
}
export function mergeCatalog(old: CatalogSummary[], next: CatalogSummary[]) {
  return [...new Map([...old, ...next].map((p) => [p.productId, p])).values()];
}
export function generatedSlug(name: string) {
  return (
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'cookie'
  );
}
export function nameChange(
  fields: ProductFields,
  name: string,
  automatic: boolean,
) {
  return {
    ...fields,
    name,
    ...(automatic ? { slug: generatedSlug(name) } : {}),
  };
}
export function needsDeactivationConfirmation(
  previous: ProductFields | undefined,
  next: ProductFields,
) {
  return previous?.active === true && !next.active;
}
export function catalogPage(value: unknown) {
  const p = record(value);
  if (
    !Array.isArray(p.products) ||
    p.products.length > 100 ||
    !(
      p.nextCursor === null ||
      (typeof p.nextCursor === 'string' &&
        /^[A-Za-z0-9_-]{1,8192}$/.test(p.nextCursor))
    )
  )
    throw new Error('Invalid catalog page');
  const products = p.products.map(catalogSummary);
  if (new Set(products.map((x) => x.productId)).size !== products.length)
    throw new Error('Duplicate product');
  return { products, nextCursor: p.nextCursor as string | null };
}
export const newProduct: ProductFields = {
  name: '',
  slug: '',
  description: '',
  ingredients: [],
  allergens: [],
  active: false,
};
export function fieldsOf(p: ProductFields): ProductFields {
  return {
    name: p.name,
    slug: p.slug,
    description: p.description,
    ingredients: p.ingredients,
    allergens: p.allergens,
    active: p.active,
  };
}
