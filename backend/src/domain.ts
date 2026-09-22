import { z } from 'zod';

export const idSchema = z.ulid();
const timestamp = z.iso.datetime();
const nonnegativeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveInteger = nonnegativeInteger.min(1);
export const timezoneSchema = z
  .string()
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'Must be a valid timezone')
  .default('America/Denver');
export const dateSchema = z.iso.date();
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const auditFields = { createdAt: timestamp, updatedAt: timestamp };

export const productSchema = z.strictObject({
  productId: idSchema,
  name: z.string().trim().min(1),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string(),
  ingredients: z.array(z.string().min(1)),
  allergens: z.array(z.string().min(1)),
  active: z.boolean(),
  ...auditFields,
});
export const dropStatusSchema = z.enum([
  'DRAFT',
  'SCHEDULED',
  'OPEN',
  'PAUSED',
  'SOLD_OUT',
  'CLOSED',
  'COMPLETED',
]);
export const dropSchema = z
  .strictObject({
    dropId: idSchema,
    name: z.string().trim().min(1),
    description: z.string(),
    status: dropStatusSchema,
    opensAt: timestamp,
    closesAt: timestamp.optional(),
    quantityLimit: positiveInteger.default(12),
    timezone: timezoneSchema,
    pickupLocation: z.string().trim().min(1),
    pickupInstructions: z.string(),
    ...auditFields,
  })
  .refine(
    (drop) =>
      !drop.closesAt || Date.parse(drop.closesAt) > Date.parse(drop.opensAt),
    'closesAt must follow opensAt',
  );
export const dropProductSchema = z.strictObject({
  dropId: idSchema,
  productId: idSchema,
  priceCents: nonnegativeInteger,
  cookieUnits: positiveInteger,
  displayOrder: nonnegativeInteger,
  active: z.boolean(),
});
export const inventorySchema = z
  .strictObject({
    dropId: idSchema,
    productId: idSchema,
    total: nonnegativeInteger,
    reserved: nonnegativeInteger.default(0),
    sold: nonnegativeInteger.default(0),
    updatedAt: timestamp,
  })
  .refine(
    (item) => item.reserved <= item.total - item.sold,
    'reserved + sold must not exceed total',
  );
export const pickupSchema = z
  .strictObject({
    dropId: idSchema,
    date: dateSchema,
    startTime: timeSchema,
    endTime: timeSchema,
    timezone: timezoneSchema,
    active: z.boolean(),
  })
  .refine(
    (pickup) => pickup.endTime > pickup.startTime,
    'endTime must follow startTime on the same date',
  );
export const storefrontSchema = z.strictObject({
  storefrontDropId: idSchema.optional(),
  updatedAt: timestamp,
});
export type Product = z.infer<typeof productSchema>;
export type Drop = z.infer<typeof dropSchema>;
export type DropStatus = z.infer<typeof dropStatusSchema>;
export type DropProduct = z.infer<typeof dropProductSchema>;
export type DropInventory = z.infer<typeof inventorySchema>;
export type PickupDate = z.infer<typeof pickupSchema>;
export type StorefrontConfiguration = z.infer<typeof storefrontSchema>;
export type VisibleDropStatus = Exclude<DropStatus, 'DRAFT' | 'COMPLETED'>;
export function isCustomerVisible(
  status: DropStatus,
): status is VisibleDropStatus {
  return ['SCHEDULED', 'OPEN', 'PAUSED', 'SOLD_OUT', 'CLOSED'].includes(status);
}
export function availableInventory(inventory: DropInventory): number {
  return inventory.total - inventory.reserved - inventory.sold;
}
