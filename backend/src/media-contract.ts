import { createHash } from 'node:crypto';
import { z } from 'zod';
import { idSchema } from './domain';

// Pure contracts only. Callers must commit transitions with a revision condition
// and Product/readiness checks in the SAME transaction. No runtime routes use this yet.
export const MEDIA = Object.freeze({
  maxImages: 6,
  maxInputBytes: 8 * 1024 * 1024,
  minAxis: 480,
  maxAxis: 8000,
  maxPixels: 20_000_000,
  maxVariantBytes: 1024 * 1024,
  maxOutputBytes: 6 * 1024 * 1024,
  authorizationMs: 300_000,
  completionMs: 900_000,
  leaseMs: 60_000,
  graceMs: 7 * 86400_000,
  receiptMs: 30 * 86400_000,
  maxAttempts: 3,
});
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const subject = z
  .string()
  .min(1)
  .max(256)
  .refine((v) => v.trim() === v);
const revision = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
export const uploadRequestSchema = z.strictObject({
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  bytes: z.number().int().min(1).max(MEDIA.maxInputBytes),
  sha256: hash,
});
export const manifestRequestSchema = z.strictObject({
  expectedRevision: revision,
  images: z
    .array(
      z.strictObject({
        mediaId: idSchema,
        alt: z.string().trim().min(1).max(160),
      }),
    )
    .max(MEDIA.maxImages)
    .refine((v) => new Set(v.map((i) => i.mediaId)).size === v.length),
});
export type UploadRequest = z.infer<typeof uploadRequestSchema>;
export type Manifest = {
  productId: string;
  revision: number;
  images: { mediaId: string; alt: string }[];
};
export type AssetState =
  'READY' | 'ATTACHED' | 'RETIRED' | 'DELETING' | 'DELETED';
export type Asset = {
  productId: string;
  mediaId: string;
  revision: number;
  state: AssetState;
  readyAt: number;
  retiredAt?: number;
};
export type Intent = {
  version: 1;
  uploadId: string;
  productId: string;
  mediaId: string;
  subject: string;
  requestHash: string;
  request: UploadRequest;
  revision: number;
  createdAt: number;
  authorizationExpiresAt: number;
  expiresAt: number;
  state: 'PENDING' | 'QUEUED' | 'PROCESSING' | 'READY' | 'FAILED' | 'EXPIRED';
  attempts: number;
  leaseToken?: string;
  leaseUntil?: number;
  completedAt?: number;
};
export class MediaConflict extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
function requireCondition(ok: boolean, code: string): asserts ok {
  if (!ok) throw new MediaConflict(code);
}
function clock(now: number) {
  requireCondition(
    Number.isSafeInteger(now) &&
      now >= 0 &&
      now < Number.MAX_SAFE_INTEGER - MEDIA.receiptMs,
    'INVALID_CLOCK',
  );
}
export const mediaKeys = {
  manifest: (productId: string) => ({
    PK: `PRODUCT_MEDIA#${idSchema.parse(productId)}`,
    SK: 'MANIFEST',
  }),
  asset: (productId: string, mediaId: string) => ({
    PK: `PRODUCT_MEDIA#${idSchema.parse(productId)}`,
    SK: `ASSET#${idSchema.parse(mediaId)}`,
  }),
  upload: (uploadId: string) => ({
    PK: `PRODUCT_MEDIA_UPLOAD#${hash.parse(uploadId)}`,
    SK: 'STATE',
  }),
};
export function uploadIdentity(productId: string, owner: string, key: string) {
  return digest(
    JSON.stringify([
      1,
      subject.parse(owner),
      idSchema.parse(productId),
      z.uuid().parse(key).toLowerCase(),
    ]),
  );
}
export function createIntent(
  productId: string,
  owner: string,
  key: string,
  mediaId: string,
  raw: unknown,
  now: number,
): Intent {
  clock(now);
  const request = uploadRequestSchema.parse(raw);
  return {
    version: 1,
    uploadId: uploadIdentity(productId, owner, key),
    productId,
    mediaId: idSchema.parse(mediaId),
    subject: owner,
    requestHash: digest(
      JSON.stringify([1, request.contentType, request.bytes, request.sha256]),
    ),
    request,
    revision: 1,
    createdAt: now,
    authorizationExpiresAt: now + MEDIA.authorizationMs,
    expiresAt: now + MEDIA.completionMs,
    state: 'PENDING',
    attempts: 0,
  };
}
export function replayIntent(existing: Intent, proposed: Intent): Intent {
  requireCondition(
    existing.uploadId === proposed.uploadId &&
      existing.productId === proposed.productId &&
      existing.subject === proposed.subject,
    'UPLOAD_NOT_FOUND',
  );
  requireCondition(
    existing.requestHash === proposed.requestHash,
    'IDEMPOTENCY_CONFLICT',
  );
  return structuredClone(existing); // Includes the ORIGINAL media ID and deadlines.
}
export function queueIntent(
  intent: Intent,
  productId: string,
  owner: string,
  now: number,
): Intent {
  clock(now);
  requireCondition(
    intent.productId === productId && intent.subject === owner,
    'UPLOAD_NOT_FOUND',
  );
  if (intent.state === 'READY') return structuredClone(intent);
  requireCondition(
    now < intent.expiresAt && intent.state !== 'EXPIRED',
    'UPLOAD_EXPIRED',
  );
  requireCondition(intent.state !== 'FAILED', 'UPLOAD_FAILED');
  if (intent.state !== 'PENDING') return structuredClone(intent);
  return { ...intent, state: 'QUEUED', revision: intent.revision + 1 };
}
export function claimIntent(
  intent: Intent,
  attemptId: string,
  now: number,
): Intent {
  clock(now);
  z.uuid().parse(attemptId);
  requireCondition(now < intent.expiresAt, 'UPLOAD_EXPIRED');
  requireCondition(
    intent.state === 'QUEUED' ||
      (intent.state === 'PROCESSING' &&
        intent.leaseUntil !== undefined &&
        intent.leaseUntil <= now),
    'PROCESSING_CONFLICT',
  );
  requireCondition(intent.attempts < MEDIA.maxAttempts, 'ATTEMPTS_EXHAUSTED');
  requireCondition(attemptId !== intent.leaseToken, 'ATTEMPT_ID_REUSED');
  return {
    ...intent,
    state: 'PROCESSING',
    revision: intent.revision + 1,
    attempts: intent.attempts + 1,
    leaseToken: attemptId,
    leaseUntil: Math.min(now + MEDIA.leaseMs, intent.expiresAt),
  };
}
export function finishIntent(
  intent: Intent,
  attemptId: string,
  now: number,
  success: boolean,
): Intent {
  clock(now);
  requireCondition(
    intent.state === 'PROCESSING' &&
      intent.leaseToken === attemptId &&
      now < (intent.leaseUntil ?? 0) &&
      now < intent.expiresAt,
    'PROCESSING_CONFLICT',
  );
  return {
    ...intent,
    state: success ? 'READY' : 'FAILED',
    revision: intent.revision + 1,
    completedAt: now,
  };
}
export function expireIntent(intent: Intent, now: number): Intent {
  clock(now);
  if (['READY', 'FAILED', 'EXPIRED'].includes(intent.state))
    return structuredClone(intent);
  requireCondition(now >= intent.expiresAt, 'UPLOAD_NOT_EXPIRED');
  return {
    ...intent,
    state: 'EXPIRED',
    completedAt: now,
    revision: intent.revision + 1,
  };
}
export function stagingKey(intent: Intent) {
  idSchema.parse(intent.productId);
  hash.parse(intent.uploadId);
  return `staging/products/${intent.productId}/${intent.uploadId}/source`;
}
export function outputKey(
  intent: Intent,
  attemptId: string,
  size: number,
  format: string,
) {
  idSchema.parse(intent.productId);
  idSchema.parse(intent.mediaId);
  z.uuid().parse(attemptId);
  requireCondition(
    [480, 960, 1600].includes(size) && ['jpeg', 'webp'].includes(format),
    'INVALID_VARIANT',
  );
  return `approved/products/${intent.productId}/${intent.mediaId}/${attemptId}/${size}.${format}`;
}
export function planManifest(
  productId: string,
  current: Manifest | undefined,
  raw: unknown,
  assets: Asset[],
  now: number,
  productExists: boolean,
  catalogReady: boolean,
) {
  clock(now);
  idSchema.parse(productId);
  requireCondition(productExists && catalogReady, 'CATALOG_NOT_READY');
  const request = manifestRequestSchema.parse(raw);
  requireCondition(
    !current || current.productId === productId,
    'PRODUCT_MISMATCH',
  );
  requireCondition(
    (current?.revision ?? 0) === request.expectedRevision,
    'MEDIA_REVISION_CONFLICT',
  );
  const previous = new Set(current?.images.map((i) => i.mediaId) ?? []);
  const next = new Set(request.images.map((i) => i.mediaId));
  const changes: Asset[] = [];
  for (const mediaId of new Set([...previous, ...next])) {
    const matches = assets.filter(
      (a) => a.productId === productId && a.mediaId === mediaId,
    );
    requireCondition(matches.length === 1, 'ASSET_NOT_FOUND');
    const asset = matches[0];
    requireCondition(
      asset.state === (previous.has(mediaId) ? 'ATTACHED' : 'READY'),
      'ASSET_STATE_CONFLICT',
    );
    if (!previous.has(mediaId))
      changes.push({
        ...asset,
        state: 'ATTACHED',
        revision: asset.revision + 1,
      });
    else if (!next.has(mediaId))
      changes.push({
        ...asset,
        state: 'RETIRED',
        retiredAt: now,
        revision: asset.revision + 1,
      });
  }
  return {
    manifest: {
      productId,
      revision: request.expectedRevision + 1,
      images: request.images,
    },
    assets: changes,
  };
}
export function deletionEligible(
  asset: Asset,
  referenced: boolean,
  now: number,
) {
  clock(now);
  const since =
    asset.state === 'READY'
      ? asset.readyAt
      : asset.state === 'RETIRED'
        ? asset.retiredAt
        : undefined;
  return !referenced && since !== undefined && now >= since + MEDIA.graceMs;
}
export function fenceDeletion(
  asset: Asset,
  referenced: boolean,
  now: number,
): Asset {
  requireCondition(
    deletionEligible(asset, referenced, now),
    'DELETION_NOT_ELIGIBLE',
  );
  return { ...asset, state: 'DELETING', revision: asset.revision + 1 };
}
export function compactReceipt(intent: Intent, now: number) {
  clock(now);
  requireCondition(
    ['READY', 'FAILED', 'EXPIRED'].includes(intent.state) &&
      intent.completedAt !== undefined &&
      now >= intent.completedAt + MEDIA.receiptMs,
    'RECEIPT_NOT_ELIGIBLE',
  );
  return {
    version: 1 as const,
    uploadId: intent.uploadId,
    productId: intent.productId,
    subject: intent.subject,
    requestHash: intent.requestHash,
    state: 'TOMBSTONE' as const,
    revision: intent.revision + 1,
  };
}
