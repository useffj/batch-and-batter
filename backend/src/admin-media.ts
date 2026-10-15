import type { MediaOrchestration } from './media-orchestration';
import { z } from 'zod';
import type { ApiEvent } from './api';
import { AdminError } from './admin-auth';
import { idSchema } from './domain';
import { body, validate } from './admin-writes';
import type { CatalogRepository } from './repository';
import type { MediaRepository } from './media-repository';
import {
  createIntent,
  manifestRequestSchema,
  uploadRequestSchema,
  MediaConflict,
} from './media-contract';
import type { MediaAsset, MediaUpload } from './media-records';
export const mediaRoutes = [
  'GET /admin/products/{productId}/media',
  'POST /admin/products/{productId}/media/uploads',
  'GET /admin/products/{productId}/media/uploads/{uploadId}',
  'POST /admin/products/{productId}/media/uploads/{uploadId}/complete',
  'GET /admin/products/{productId}/media/assets/{mediaId}',
  'PUT /admin/products/{productId}/media',
];
export type MediaApiRepository = Pick<
  MediaRepository,
  'manifest' | 'asset' | 'upload' | 'replaceManifest'
>;
export const MEDIA_JSON_LIMIT = 16384;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export function mediaAssetDto(a: MediaAsset) {
  return {
    productId: a.productId,
    mediaId: a.mediaId,
    revision: a.revision,
    state: a.state,
    width: a.result.width,
    height: a.result.height,
    variants: a.result.variants.map(
      ({ size, format, width, height, bytes }) => ({
        size,
        format,
        width,
        height,
        bytes,
      }),
    ),
  };
}
function uploadDto(i: MediaUpload) {
  return {
    productId: i.productId,
    uploadId: i.uploadId,
    state: i.state,
    ...(i.state === 'TOMBSTONE'
      ? {}
      : {
          mediaId: i.mediaId,
          expiresAt: i.expiresAt,
          ...(i.result ? { result: mediaAssetDto(i.result) } : {}),
        }),
  };
}
function readBody(e: ApiEvent) {
  const type = Object.entries(e.headers ?? {}).find(
    ([k]) => k.toLowerCase() === 'content-type',
  )?.[1];
  if (
    !/^application\/json(?:\s*;|$)/i.test(type ?? '') ||
    typeof e.body !== 'string'
  )
    throw new AdminError(
      400,
      'VALIDATION_ERROR',
      'A JSON request is required.',
    );
  if (
    Buffer.byteLength(e.body) > MEDIA_JSON_LIMIT * 2 ||
    Buffer.byteLength(
      e.isBase64Encoded ? Buffer.from(e.body, 'base64') : e.body,
    ) > MEDIA_JSON_LIMIT
  )
    throw new AdminError(
      413,
      'MEDIA_PAYLOAD_TOO_LARGE',
      'Media metadata exceeds the request limit.',
    );
  return body(e);
}
function unavailable(code: string): never {
  throw new AdminError(503, code, 'Media upload services are not configured.');
}
export function mediaFailure(e: MediaConflict) {
  const codes: Record<string, number> = {
    PRODUCT_NOT_FOUND: 404,
    ASSET_NOT_FOUND: 404,
    UPLOAD_NOT_FOUND: 404,
    PRODUCT_WRITES_NOT_READY: 503,
    MEDIA_STORAGE_UNAVAILABLE: 503,
    MEDIA_RECORD_INVALID: 503,
    MEDIA_TRANSACTION_INVALID: 503,
    UPLOAD_AUTHORIZATION_EXPIRED: 410,
    MEDIA_UPLOAD_UNAVAILABLE: 503,
    MEDIA_PROCESSOR_UNAVAILABLE: 503,
    ATTEMPTS_EXHAUSTED: 409,
    UPLOAD_EXPIRED: 410,
    UPLOAD_RESULT_EXPIRED: 410,
    UPLOAD_FAILED: 422,
    IDEMPOTENCY_CONFLICT: 409,
    MEDIA_REVISION_CONFLICT: 409,
    ASSET_STATE_CONFLICT: 409,
    PRODUCT_CONFLICT: 409,
    PRODUCT_INTEGRITY_CONFLICT: 409,
    PROCESSING_CONFLICT: 409,
  };
  return new AdminError(
    codes[e.code] ?? 503,
    codes[e.code] ? e.code : 'MEDIA_STORAGE_UNAVAILABLE',
    'Unable to complete the media request. Reload or contact the operator.',
  );
}
export async function adminMedia(
  e: ApiEvent,
  catalog: () => CatalogRepository,
  media: () => MediaApiRepository,
  subject: string,
  services?: MediaOrchestration,
) {
  const productId = validate(idSchema, e.pathParameters?.productId);
  if (Object.keys(e.queryStringParameters ?? {}).length)
    throw new AdminError(
      400,
      'VALIDATION_ERROR',
      'Query parameters are not supported.',
    );
  let input: unknown;
  if (e.requestContext.http.method !== 'GET') input = readBody(e);
  else if (e.body)
    throw new AdminError(
      400,
      'VALIDATION_ERROR',
      'GET bodies are not supported.',
    );
  if (e.routeKey === mediaRoutes[5])
    input = validate(manifestRequestSchema, input);
  if (e.routeKey === mediaRoutes[1])
    input = validate(uploadRequestSchema, input);
  if (e.routeKey === mediaRoutes[3]) validate(z.strictObject({}), input);
  const uploadId =
    e.routeKey === mediaRoutes[2] || e.routeKey === mediaRoutes[3]
      ? validate(hash, e.pathParameters?.uploadId)
      : undefined;
  const mediaId =
    e.routeKey === mediaRoutes[4]
      ? validate(idSchema, e.pathParameters?.mediaId)
      : undefined;
  let product;
  try {
    product = await catalog().getProduct(productId);
  } catch {
    throw new AdminError(
      503,
      'MEDIA_STORAGE_UNAVAILABLE',
      'Media metadata is unavailable.',
    );
  }
  if (!product)
    throw new AdminError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
  const repo = media();
  try {
    if (e.routeKey === mediaRoutes[0])
      return {
        status: 200,
        body: {
          manifest: (await repo.manifest(productId)) ?? {
            version: 1,
            productId,
            revision: 0,
            images: [],
          },
        },
      };
    if (e.routeKey === mediaRoutes[5])
      return {
        status: 200,
        body: { manifest: await repo.replaceManifest(productId, input) },
      };
    if (mediaId) {
      const a = await repo.asset(productId, mediaId);
      if (!a) throw new MediaConflict('ASSET_NOT_FOUND');
      return { status: 200, body: { asset: mediaAssetDto(a) } };
    }
    if (e.routeKey === mediaRoutes[1]) {
      const key = Object.entries(e.headers ?? {}).find(
        ([k]) => k.toLowerCase() === 'idempotency-key',
      )?.[1];
      const candidate = createIntent(
        productId,
        subject,
        validate(z.uuid(), key),
        productId,
        input,
        Date.now(),
      );
      const existing = await repo.upload(
        productId,
        subject,
        candidate.uploadId,
      );
      if (existing) {
        if (existing.requestHash !== candidate.requestHash)
          throw new MediaConflict('IDEMPOTENCY_CONFLICT');
        if (existing.state === 'TOMBSTONE')
          throw new MediaConflict('UPLOAD_RESULT_EXPIRED');
        if (existing.state === 'READY')
          return { status: 200, body: { upload: uploadDto(existing) } };
        if (existing.state === 'EXPIRED' || Date.now() >= existing.expiresAt)
          throw new MediaConflict('UPLOAD_EXPIRED');
        if (existing.state === 'FAILED')
          throw new MediaConflict('UPLOAD_FAILED');
      }
      if (services) {
        const result = await services.upload(productId, subject, key!, input);
        return {
          status: 200,
          body: {
            upload: uploadDto(result.intent),
            ...(result.authorization
              ? { authorization: result.authorization }
              : {}),
          },
        };
      }
      return unavailable('MEDIA_UPLOAD_UNAVAILABLE'); // No intent reservation without storage authorization.
    }
    const i = await repo.upload(productId, subject, uploadId!);
    if (!i) throw new MediaConflict('UPLOAD_NOT_FOUND');
    if (i.state === 'TOMBSTONE')
      throw new MediaConflict('UPLOAD_RESULT_EXPIRED');
    if (
      i.state === 'EXPIRED' ||
      (!['READY', 'FAILED'].includes(i.state) && Date.now() >= i.expiresAt)
    )
      throw new MediaConflict('UPLOAD_EXPIRED');
    if (e.routeKey === mediaRoutes[2])
      return { status: 200, body: { upload: uploadDto(i) } };
    if (i.state === 'READY')
      return { status: 200, body: { upload: uploadDto(i) } };
    if (i.state === 'FAILED') throw new MediaConflict('UPLOAD_FAILED');
    if (services) {
      const queued = await services.requestProcessing(
        productId,
        subject,
        uploadId!,
      );
      return {
        status: queued.state === 'READY' ? 200 : 202,
        body: { upload: uploadDto(queued) },
      };
    }
    return unavailable('MEDIA_PROCESSOR_UNAVAILABLE'); // Request processing only: never claim/finalize here.
  } catch (error) {
    if (error instanceof MediaConflict) throw mediaFailure(error);
    if (error instanceof AdminError) throw error;
    throw new AdminError(
      503,
      'MEDIA_STORAGE_UNAVAILABLE',
      'Media metadata is unavailable.',
    );
  }
}
