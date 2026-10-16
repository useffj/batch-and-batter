import { z } from 'zod';
import { idSchema } from './domain';
export const money = z.number().int().min(0).max(99999999);
export const refundInput = z
  .strictObject({
    operationId: z.uuid(),
    amountCents: money.positive(),
    reason: z.string().trim().min(1).max(500),
    disposition: z
      .enum(['RESTOCK', 'DO_NOT_RESTOCK'])
      .default('DO_NOT_RESTOCK'),
    physicallyAvailable: z.boolean().default(false),
    items: z
      .array(
        z.strictObject({
          productId: idSchema,
          quantity: z.number().int().positive().max(999999),
        }),
      )
      .max(12)
      .default([]),
  })
  .refine(
    (x) =>
      new Set(x.items.map((i) => i.productId)).size === x.items.length &&
      (x.disposition === 'RESTOCK'
        ? x.physicallyAvailable && x.items.length > 0
        : x.items.length === 0 && !x.physicallyAvailable),
  );
export const refundStatus = z.enum([
  'AUTHORIZED',
  'DISPATCHED',
  'PENDING',
  'SUCCEEDED',
  'FAILED',
  'CANCELED',
  'RECONCILIATION_REQUIRED',
]);
export const refundOperation = refundInput.safeExtend({
  orderId: idSchema,
  administrator: z.string().min(1).max(256),
  fingerprint: z.string().length(64),
  intentId: z.string().regex(/^pi_[A-Za-z0-9]+$/),
  accountId: z.string().regex(/^acct_[A-Za-z0-9]+$/),
  scope: z.string().regex(/^dev:acct_[A-Za-z0-9]+$/),
  environment: z.literal('dev'),
  currency: z.literal('usd'),
  capturedCents: money.positive(),
  previousRefundedCents: money,
  settlementId: z.string().length(64),
  idempotencyKey: z.string().max(255),
  status: refundStatus,
  revision: z.number().int().nonnegative(),
  checks: z.number().int().nonnegative(),
  providerId: z
    .string()
    .regex(/^re_[A-Za-z0-9]+$/)
    .optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  nextCheckAt: z.iso.datetime(),
});
export type RefundOperation = z.infer<typeof refundOperation>;
export const refundLedger = z
  .strictObject({
    orderId: idSchema,
    settlementId: z.string().length(64),
    capturedCents: money.positive(),
    refundedCents: money,
    reservedCents: money,
    revision: z.number().int().nonnegative(),
    active: z.uuid().nullable(),
    blocked: z.boolean().default(false),
    lastStatus: refundStatus.optional(),
    returned: z.record(idSchema, z.number().int().nonnegative()),
    updatedAt: z.iso.datetime(),
  })
  .refine(
    (x) =>
      x.refundedCents + x.reservedCents <= x.capturedCents &&
      (x.active === null ? x.reservedCents === 0 : x.reservedCents > 0),
  );
export const ledgerKey = (id: string) => ({
  PK: 'ORDER#' + idSchema.parse(id),
  SK: 'REFUND_LEDGER',
});
export const refundOperationKey = (id: string, op: string) => ({
  PK: 'ORDER_REFUNDS#' + idSchema.parse(id),
  SK: z.uuid().parse(op),
});
export const refundWorkKey = (id: string, op: string) => ({
  PK: 'REFUND_WORK#' + idSchema.parse(id),
  SK: z.uuid().parse(op),
});
export const refundSnapshot = z.strictObject({
  id: z.string().regex(/^re_[A-Za-z0-9]+$/),
  operationId: z.uuid(),
  orderId: idSchema,
  intentId: z.string().regex(/^pi_[A-Za-z0-9]+$/),
  accountId: z.string().regex(/^acct_[A-Za-z0-9]+$/),
  environment: z.literal('dev'),
  amountCents: money.positive(),
  currency: z.literal('usd'),
  status: z.enum([
    'pending',
    'requires_action',
    'succeeded',
    'failed',
    'canceled',
  ]),
});
export type RefundSnapshot = z.infer<typeof refundSnapshot>;
export interface RefundProvider {
  readonly accountId: string;
  readonly environment: 'dev';
  create(operation: RefundOperation): Promise<RefundSnapshot>;
  // An empty result is NOT proof that a dispatched mutation did not occur.
  reconcile(operation: RefundOperation): Promise<RefundSnapshot | null>;
}
