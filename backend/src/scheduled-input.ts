import { z } from 'zod';
import {
  dropSchema,
  dropProductSchema,
  inventorySchema,
  pickupSchema,
} from './domain';

// Partial metadata; supplied arrays replace the complete composition. Omitted arrays are preserved.
export const scheduledPatchSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(4000).optional(),
    opensAt: dropSchema.shape.opensAt.optional(),
    closesAt: dropSchema.shape.closesAt.nullable().optional(),
    quantityLimit: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    timezone: z
      .string()
      .max(100)
      .pipe(dropSchema.shape.timezone.unwrap())
      .optional(),
    pickupLocation: z.string().trim().min(1).max(1000).optional(),
    pickupInstructions: z.string().max(4000).optional(),
    products: z
      .array(
        dropProductSchema.omit({ dropId: true }).extend({
          inventoryTotal: inventorySchema.shape.total,
        }),
      )
      .min(1)
      .max(20)
      .optional(),
    pickups: z
      .array(
        z
          .strictObject({
            date: pickupSchema.shape.date,
            startTime: pickupSchema.shape.startTime,
            endTime: pickupSchema.shape.endTime,
            timezone: pickupSchema.shape.timezone,
            active: pickupSchema.shape.active,
          })
          .refine((p) => p.endTime > p.startTime),
      )
      .min(1)
      .max(14)
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0);
export type ScheduledPatch = z.infer<typeof scheduledPatchSchema>;
