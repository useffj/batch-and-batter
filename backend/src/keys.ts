import { dateSchema, idSchema } from './domain';

export const catalogKeys = {
  product: (id: string) => ({
    PK: `PRODUCT#${idSchema.parse(id)}`,
    SK: 'META',
  }),
  drop: (id: string) => ({ PK: `DROP#${idSchema.parse(id)}`, SK: 'META' }),
  dropProduct: (dropId: string, productId: string) => ({
    PK: `DROP#${idSchema.parse(dropId)}`,
    SK: `PRODUCT#${idSchema.parse(productId)}`,
  }),
  inventory: (dropId: string, productId: string) => ({
    PK: `DROP#${idSchema.parse(dropId)}`,
    SK: `INVENTORY#${idSchema.parse(productId)}`,
  }),
  pickup: (dropId: string, date: string) => ({
    PK: `DROP#${idSchema.parse(dropId)}`,
    SK: `PICKUP#${dateSchema.parse(date)}`,
  }),
  storefront: { PK: 'STORE#CONFIG', SK: 'STOREFRONT' },
};
