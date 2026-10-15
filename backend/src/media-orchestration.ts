import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { idSchema } from './domain';
import { MediaConflict } from './media-contract';
import type { MediaRepository } from './media-repository';
import type { MediaIntent } from './media-records';
import type { S3MediaStorage, LambdaMediaDispatch } from './media-storage';
export class MediaOrchestration {
  constructor(
    private repository: MediaRepository,
    private storage: Pick<S3MediaStorage, 'preflight' | 'authorize'>,
    private dispatch: Pick<LambdaMediaDispatch, 'invoke'>,
  ) {}
  async upload(
    productId: string,
    subject: string,
    key: string,
    request: unknown,
  ) {
    await this.storage.preflight();
    const intent = await this.repository.createUpload(
      productId,
      subject,
      key,
      request,
    );
    if (intent.state === 'READY') return { intent };
    if (intent.state === 'FAILED') throw new MediaConflict('UPLOAD_FAILED');
    await this.repository.assertWritable(productId);
    const authorization = await this.storage.authorize(intent);
    return { intent, authorization };
  }
  async requestProcessing(productId: string, subject: string, id: string) {
    const reservation = await this.repository.reserveDispatch(
      productId,
      subject,
      id,
    );
    if (reservation.dispatch) await this.dispatch.invoke(reservation.intent);
    return reservation.intent;
  }
}
const eventSchema = z.strictObject({
  version: z.literal(1),
  productId: idSchema,
  subject: z.string().min(1).max(256),
  uploadId: z.string().regex(/^[a-f0-9]{64}$/),
});
type Processed = {
  processingVersion: 1;
  width: number;
  height: number;
  variants: {
    size: number;
    format: string;
    width: number;
    height: number;
    bytes: number;
    sha256: string;
    data: Buffer;
  }[];
};
// Dependency-injected worker contract only. No deployable handler or Sharp import
// in the API package. The isolated processor supplies its actual processImage.
export async function processMedia(
  event: unknown,
  repository: MediaRepository,
  storage: Pick<S3MediaStorage, 'source' | 'output'>,
  processImage: (
    bytes: Buffer,
    request: MediaIntent['request'],
  ) => Promise<Processed>,
) {
  const e = eventSchema.parse(event),
    attempt = randomUUID();
  let i: MediaIntent;
  try {
    i = await repository.claim(e.productId, e.subject, e.uploadId, attempt);
  } catch (error) {
    if (
      error instanceof MediaConflict &&
      [
        'PROCESSING_CONFLICT',
        'ATTEMPT_ID_REUSED',
        'ATTEMPTS_EXHAUSTED',
        'UPLOAD_EXPIRED',
        'UPLOAD_RESULT_EXPIRED',
      ].includes(error.code)
    )
      return { state: 'IGNORED' };
    throw error;
  }
  if (i.state === 'READY') return { state: 'READY' };
  try {
    const bytes = await storage.source(i),
      result = await processImage(bytes, i.request),
      variants = [];
    for (const v of result.variants) {
      const key = await storage.output(i, attempt, v);
      const { data, ...metadata } = v;
      variants.push({ ...metadata, key });
    }
    await repository.complete(e.productId, e.subject, e.uploadId, attempt, {
      processingVersion: result.processingVersion,
      width: result.width,
      height: result.height,
      variants,
    });
    return { state: 'READY' };
  } catch (error) {
    if (
      (error instanceof Error && error.name === 'InvalidImage') ||
      (error instanceof MediaConflict && error.code === 'INVALID_MEDIA')
    ) {
      await repository.failProcessing(
        e.productId,
        e.subject,
        e.uploadId,
        attempt,
        'INVALID_MEDIA',
      );
      return { state: 'FAILED' };
    }
    // Storage/unknown write outcomes retain PROCESSING for lease-expiry recovery.
    throw new MediaConflict('MEDIA_PROCESSOR_UNAVAILABLE');
  }
}
