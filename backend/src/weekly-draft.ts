import { z } from 'zod';
import {
  dropSchema,
  dropProductSchema,
  inventorySchema,
  pickupSchema,
} from './domain';
export const weeklyDraftSchema = z
  .strictObject({
    revision: z.iso.datetime(),
    drop: dropSchema,
    products: z
      .array(
        z.strictObject({
          productId: dropProductSchema.shape.productId,
          priceCents: dropProductSchema.shape.priceCents,
          inventoryTotal: inventorySchema.shape.total,
        }),
      )
      .max(24),
    pickups: z.array(pickupSchema).max(3),
  })
  .superRefine((v, ctx) => {
    const fail = () =>
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid weekly draft configuration',
      });
    if (
      v.drop.status !== 'DRAFT' ||
      v.drop.timezone !== 'America/Denver' ||
      new Set(v.products.map((p) => p.productId)).size !== v.products.length
    )
      fail();
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Denver',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(v.drop.opensAt));
    const part = (type: string) => parts.find((p) => p.type === type)!.value;
    const start = `${part('year')}-${part('month')}-${part('day')}`;
    const date = new Date(start + 'T12:00:00Z');
    const day = date.getUTCDay();
    const thursday = new Date(date);
    thursday.setUTCDate(date.getUTCDate() + ((4 - day + 7) % 7 || 7));
    const allowed = [0, 1, 2].map((n) =>
      new Date(thursday.getTime() + n * 86400000).toISOString().slice(0, 10),
    );
    if (new Set(v.pickups.map((p) => p.date)).size !== v.pickups.length) fail();
    for (const p of v.pickups) {
      const mins = (t: string) =>
        Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
      const duration = mins(p.endTime) - mins(p.startTime);
      if (
        p.dropId !== v.drop.dropId ||
        p.timezone !== 'America/Denver' ||
        !allowed.includes(p.date) ||
        duration < 120 ||
        duration > 180
      )
        fail();
    }
  });
export type WeeklyDraft = z.infer<typeof weeklyDraftSchema>;
