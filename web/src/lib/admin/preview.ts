import { composition, record, text, id } from './contract';
export function previewData(value: unknown, dropId: string) {
  const raw = record(value),
    overview = composition(raw, id(dropId));
  if (
    raw.preview !== true ||
    raw.actionsEnabled !== false ||
    overview.drop.status !== 'DRAFT'
  )
    throw Error('Invalid draft preview');
  const drop = record(raw.drop);
  const products = (raw.products as unknown[]).map((entry, i) => {
    const relation = record(entry),
      product = record(relation.product),
      assignment = record(relation.dropProduct);
    if (id(product.productId) !== overview.products[i].id)
      throw Error('Broken product reference');
    const price = assignment.priceCents;
    if (!Number.isSafeInteger(price) || (price as number) < 0)
      throw Error('Invalid price');
    const stock = overview.inventory.find(
      (v) => v.productId === product.productId,
    );
    if (!stock || stock.reserved !== 0 || stock.sold !== 0)
      throw Error('Invalid draft inventory');
    return {
      id: id(product.productId),
      name: text(product.name),
      description: text(product.description, 100000),
      priceCents: price as number,
      quantity: stock.total,
      active: product.active === true && assignment.active === true,
    };
  });
  return { ...overview, description: text(drop.description), products };
}
