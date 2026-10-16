import { z } from 'zod';
import { createHash } from 'node:crypto';
import { idSchema, dateSchema } from './domain';
export const digest = (s: string) =>
  createHash('sha256').update(s).digest('hex');
export const shard = (s: string) =>
  String(parseInt(digest(s).slice(0, 2), 16) % 16).padStart(2, '0');
export const refundKey = (id: string) => ({
  PK: 'ORDER#' + id,
  SK: 'REFUND_DISPOSITION',
});
export const consentKey = (id: string) => ({
  PK: 'ORDER#' + id,
  SK: 'SMS_CONSENT',
});
export const suppressionKey = (phone: string) => ({
  PK: 'SMS_SUPPRESSION#' + digest(phone),
  SK: 'META',
});
export const refundSchema = z.strictObject({
  disposition: z.enum(['UNKNOWN', 'NONE', 'PENDING', 'PARTIAL', 'FULL']),
  settlementId: z.string().regex(/^[a-f0-9]{64}$/),
  updatedAt: z.iso.datetime(),
});
export const consentSchema = z.strictObject({
  phone: z.string().regex(/^\+[1-9]\d{1,14}$/),
  smsTransactionalConsent: z.boolean(),
  consentedAt: z.iso.datetime().nullable(),
  consentSource: z.literal('CHECKOUT_V1'),
  optOutAt: z.iso.datetime().nullable(),
});
export const suppressionSchema = z.strictObject({
  phoneHash: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.number().int().nonnegative(),
  verifiedAt: z.iso.datetime(),
  optOutAt: z.iso.datetime().nullable(),
});
export const eventWork = (orderId: string) => ({
  PK: 'NOTIFICATION_EVENTS#' + shard(orderId),
  SK: orderId,
  orderId,
});
export const operationKey = (orderId: string, key: string) => ({
  PK: 'ORDER_NOTIFICATIONS#' + orderId,
  SK: key,
});
export const notificationKey = z
  .string()
  .regex(
    /^(CONFIRMATION#email|REMINDER#\d{4}-\d\d-\d\d#(email|sms)|(ACCESS|PICKUP_CHANGE|REQUEST)#[a-f0-9-]{36}#email)$/,
  );
export const operationSchema = z
  .strictObject({
    orderId: idSchema,
    key: notificationKey,
    kind: z.enum([
      'CONFIRMATION',
      'REMINDER',
      'ACCESS',
      'PICKUP_CHANGE',
      'REQUEST',
    ]),
    channel: z.enum(['email', 'sms']),
    pickupDate: dateSchema,
    status: z.enum([
      'PENDING',
      'DISPATCHED',
      'SENT',
      'FAILED',
      'UNCERTAIN',
      'SUPPRESSED',
    ]),
    attempts: z.number().int().min(0).max(3),
    revision: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    reason: z.string().max(80).optional(),
    sentAt: z.iso.datetime().optional(),
  })
  .refine(
    (o) =>
      (o.kind === 'CONFIRMATION'
        ? o.key === 'CONFIRMATION#email' && o.channel === 'email'
        : o.kind === 'REMINDER'
          ? o.key === `REMINDER#${o.pickupDate}#${o.channel}`
          : o.key.startsWith(o.kind + '#') && o.channel === 'email') &&
      (o.status !== 'SENT' || !!o.sentAt),
    'Invalid notification identity or acknowledgement',
  );
export type Operation = z.infer<typeof operationSchema>;
export const dueKey = (o: Pick<Operation, 'orderId' | 'key'>) => ({
  PK: 'NOTIFICATION_DUE#' + shard(o.orderId),
  SK: o.orderId + '#' + o.key,
});
export function reminderSchedule(date: string, time = '10:00') {
  dateSchema.parse(date);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
    throw Error('Invalid reminder time');
  const prior = new Date(date + 'T12:00:00Z');
  prior.setUTCDate(prior.getUTCDate() - 1);
  return {
    name: 'pickup-reminder-' + date,
    expression: `at(${prior.toISOString().slice(0, 10)}T${time}:00)`,
    timezone: 'America/Denver',
    date,
  };
}
