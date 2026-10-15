import { z } from 'zod';
import { createHash } from 'node:crypto';
import { idSchema } from './domain';
import {
  MEDIA,
  manifestRequestSchema,
  uploadRequestSchema,
  mediaKeys,
} from './media-contract';
const time = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - MEDIA.receiptMs);
const revision = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER - 1);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identity = {
  version: z.literal(1),
  uploadId: hash,
  productId: idSchema,
  subject: z.string().trim().min(1).max(256),
  requestHash: hash,
  revision,
};
const variant = z.strictObject({
  size: z.union([z.literal(480), z.literal(960), z.literal(1600)]),
  format: z.enum(['jpeg', 'webp']),
  width: z.number().int().min(1).max(1600),
  height: z.number().int().min(1).max(1600),
  bytes: z.number().int().min(1).max(MEDIA.maxVariantBytes),
  sha256: hash,
  key: z.string().max(300),
});
export const verifiedResultSchema = z
  .strictObject({
    processingVersion: z.literal(1),
    width: z.number().int().min(480).max(8000),
    height: z.number().int().min(480).max(8000),
    variants: z.array(variant).min(2).max(6),
  })
  .superRefine((v, c) => {
    const issue = () =>
      c.addIssue({ code: 'custom', message: 'Invalid processed variants' });
    if (
      v.width * v.height > MEDIA.maxPixels ||
      v.variants.reduce((n, x) => n + x.bytes, 0) > MEDIA.maxOutputBytes
    )
      issue();
    const seen = new Set<string>(),
      expected: number[] = [];
    for (const size of [480, 960, 1600]) {
      const r = Math.min(1, size / Math.max(v.width, v.height)),
        d = `${Math.round(v.width * r)}x${Math.round(v.height * r)}`;
      if (!seen.has(d)) expected.push(size);
      seen.add(d);
    }
    if (
      JSON.stringify(
        [...new Set(v.variants.map((x) => x.size))].sort((a, b) => a - b),
      ) !== JSON.stringify(expected)
    )
      issue();
    for (const size of expected) {
      const group = v.variants.filter((x) => x.size === size),
        r = Math.min(1, size / Math.max(v.width, v.height));
      if (
        group.length !== 2 ||
        new Set(group.map((x) => x.format)).size !== 2 ||
        group.some(
          (x) =>
            x.width !== Math.round(v.width * r) ||
            x.height !== Math.round(v.height * r),
        )
      )
        issue();
    }
  });
export const assetSchema = z
  .strictObject({
    version: z.literal(1),
    productId: idSchema,
    mediaId: idSchema,
    uploadId: hash,
    revision,
    state: z.enum(['READY', 'ATTACHED', 'RETIRED', 'DELETING', 'DELETED']),
    readyAt: time,
    retiredAt: time.optional(),
    attemptId: z.uuid(),
    result: verifiedResultSchema,
  })
  .superRefine((a, c) => {
    if (a.state === 'RETIRED' && a.retiredAt === undefined)
      c.addIssue({ code: 'custom', message: 'Missing retirement' });
    for (const v of a.result.variants)
      if (
        v.key !==
        `approved/products/${a.productId}/${a.mediaId}/${a.attemptId}/${v.size}.${v.format}`
      )
        c.addIssue({ code: 'custom', message: 'Invalid output ownership' });
  });
export const manifestSchema = z.strictObject({
  version: z.literal(1),
  productId: idSchema,
  revision,
  images: manifestRequestSchema.shape.images,
});
export const intentSchema = z
  .strictObject({
    ...identity,
    mediaId: idSchema,
    request: uploadRequestSchema,
    createdAt: time,
    authorizationExpiresAt: time,
    expiresAt: time,
    state: z.enum([
      'PENDING',
      'QUEUED',
      'PROCESSING',
      'READY',
      'FAILED',
      'EXPIRED',
    ]),
    dispatchAfter: time.optional(),
    dispatchToken: z.uuid().optional(),
    attempts: z.number().int().min(0).max(3),
    attemptIds: z.array(z.uuid()).max(3),
    leaseToken: z.uuid().optional(),
    leaseUntil: time.optional(),
    completedAt: time.optional(),
    result: assetSchema.optional(),
    failureCode: z.enum(['INVALID_MEDIA', 'PROCESSING_FAILED']).optional(),
  })
  .superRefine((i, c) => {
    const issue = () =>
      c.addIssue({ code: 'custom', message: 'Invalid intent state' });
    if (
      (i.dispatchAfter === undefined) !== (i.dispatchToken === undefined) ||
      (i.dispatchAfter !== undefined &&
        (i.dispatchAfter < i.createdAt || i.dispatchAfter > i.expiresAt))
    )
      issue();
    const expectedHash = createHash('sha256')
      .update(
        JSON.stringify([
          1,
          i.request.contentType,
          i.request.bytes,
          i.request.sha256,
        ]),
      )
      .digest('hex');
    if (i.requestHash !== expectedHash) issue();
    if (['PENDING', 'QUEUED'].includes(i.state) && i.attempts !== 0) issue();
    if (i.state === 'FAILED' && !i.failureCode) issue();
    if (i.state !== 'FAILED' && i.failureCode) issue();
    if (i.completedAt !== undefined && i.completedAt < i.createdAt) issue();
    if (
      i.authorizationExpiresAt !== i.createdAt + MEDIA.authorizationMs ||
      i.expiresAt !== i.createdAt + MEDIA.completionMs ||
      i.attempts !== i.attemptIds.length ||
      new Set(i.attemptIds).size !== i.attemptIds.length
    )
      issue();
    if (
      i.attempts > 0 &&
      (!i.leaseToken ||
        !i.attemptIds.includes(i.leaseToken) ||
        i.leaseUntil === undefined ||
        i.leaseUntil > i.expiresAt)
    )
      issue();
    if (i.state === 'PROCESSING' && i.attempts === 0) issue();
    if (
      ['READY', 'FAILED', 'EXPIRED'].includes(i.state) &&
      i.completedAt === undefined
    )
      issue();
    if ((i.state === 'READY') !== !!i.result) issue();
    if (
      i.result &&
      (i.result.productId !== i.productId ||
        i.result.mediaId !== i.mediaId ||
        i.result.uploadId !== i.uploadId ||
        i.result.attemptId !== i.leaseToken ||
        i.result.state !== 'READY')
    )
      issue();
  });
export const tombstoneSchema = z.strictObject({
  ...identity,
  state: z.literal('TOMBSTONE'),
});
export const uploadSchema = z.union([intentSchema, tombstoneSchema]);
export type MediaAsset = z.infer<typeof assetSchema>;
export type MediaIntent = z.infer<typeof intentSchema>;
export type MediaUpload = z.infer<typeof uploadSchema>;
export type MediaManifest = z.infer<typeof manifestSchema>;
export function recordKey(v: MediaAsset | MediaUpload | MediaManifest) {
  if ('images' in v) return mediaKeys.manifest(v.productId);
  if ('readyAt' in v) return mediaKeys.asset(v.productId, v.mediaId);
  return mediaKeys.upload(v.uploadId);
}
