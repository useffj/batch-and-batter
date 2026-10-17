import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { z } from 'zod';
import {
  MEDIA,
  MediaConflict,
  stagingKey,
  outputKey,
  uploadRequestSchema,
} from './media-contract';
import type { MediaIntent } from './media-records';
export const mediaServiceConfigSchema = z
  .strictObject({
    enabled: z.literal(true),
    region: z.literal('us-east-2'),
    bucket: z
      .string()
      .regex(
        /^batch-and-batter-dev-(?:product-media|isolated-media)-302154194958-us-east-2$/,
      ),
    processorArn: z
      .string()
      .regex(
        /^arn:aws:lambda:us-east-2:302154194958:function:batch-and-batter-dev-(?:isolated-)?media-processor(?::[a-zA-Z0-9_-]+)?$/,
      ),
  })
  .refine(
    (c) =>
      c.bucket.includes('-isolated-media-') ===
      c.processorArn.includes(
        ':function:batch-and-batter-dev-isolated-media-processor',
      ),
    { message: 'Media storage and processor boundary mismatch' },
  );
export type UploadAuthorization = {
  url: string;
  fields: Record<string, string>;
  expiresAt: number;
};
export class S3MediaStorage {
  private config: z.infer<typeof mediaServiceConfigSchema>;
  constructor(
    private client: S3Client,
    config: unknown,
    private now: () => number = Date.now,
  ) {
    this.config = mediaServiceConfigSchema.parse(config);
  }
  async preflight() {
    try {
      const c = await this.client.config.credentials();
      if (
        !c.sessionToken ||
        (!c.expiration && !this.config.bucket.includes('-isolated-media-')) ||
        (c.expiration !== undefined &&
          (!Number.isFinite(c.expiration.getTime()) ||
            c.expiration.getTime() <= this.now() + 1000))
      )
        throw new Error();
    } catch {
      throw new MediaConflict('MEDIA_UPLOAD_UNAVAILABLE');
    }
  }
  async authorize(i: MediaIntent): Promise<UploadAuthorization> {
    uploadRequestSchema.parse(i.request);
    const remaining = Math.floor(
      (i.authorizationExpiresAt - this.now()) / 1000,
    );
    if (i.state !== 'PENDING' || remaining < 1)
      throw new MediaConflict('UPLOAD_AUTHORIZATION_EXPIRED');
    try {
      const credentials = await this.client.config.credentials();
      if (
        !credentials.sessionToken ||
        (!credentials.expiration &&
          !this.config.bucket.includes('-isolated-media-'))
      )
        throw new Error();
      // Lambda execution-role environment credentials need not expose expiry.
      // S3 still enforces the session's validity; the signed POST itself is <=5 min.
      const credentialEnd =
        credentials.expiration?.getTime() ?? this.now() + 300000;
      if (!Number.isFinite(credentialEnd)) throw new Error();
      const seconds = Math.min(
        remaining,
        300,
        Math.floor((credentialEnd - this.now()) / 1000),
      );
      if (seconds < 1) throw new Error();
      const signed = await createPresignedPost(this.client, {
        Bucket: this.config.bucket,
        Key: stagingKey(i),
        Expires: seconds,
        Fields: {
          'Content-Type': i.request.contentType,
          'x-amz-checksum-algorithm': 'SHA256',
          'x-amz-checksum-sha256': Buffer.from(
            i.request.sha256,
            'hex',
          ).toString('base64'),
          'x-amz-server-side-encryption': 'AES256',
          success_action_status: '204',
        },
        Conditions: [
          ['content-length-range', i.request.bytes, i.request.bytes],
        ],
      });
      const policy = JSON.parse(
        Buffer.from(signed.fields.Policy, 'base64').toString(),
      );
      const expiresAt = Date.parse(policy.expiration);
      if (
        expiresAt > i.authorizationExpiresAt ||
        expiresAt <= this.now() ||
        expiresAt > credentialEnd ||
        signed.url !==
          `https://${this.config.bucket}.s3.${this.config.region}.amazonaws.com/`
      )
        throw new Error();
      return { ...signed, expiresAt };
    } catch {
      throw new MediaConflict('MEDIA_UPLOAD_UNAVAILABLE');
    }
  }
  async source(i: MediaIntent): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: stagingKey(i) }),
    );
    const body = response.Body;
    if (!body) throw new MediaConflict('MEDIA_SOURCE_UNAVAILABLE');
    try {
      if (
        response.ContentLength !== i.request.bytes ||
        response.ContentLength > MEDIA.maxInputBytes
      )
        throw new MediaConflict('INVALID_MEDIA');
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        length += chunk.length;
        if (length > i.request.bytes || length > MEDIA.maxInputBytes)
          throw new MediaConflict('INVALID_MEDIA');
        chunks.push(Buffer.from(chunk));
      }
      if (length !== i.request.bytes) throw new MediaConflict('INVALID_MEDIA');
      return Buffer.concat(chunks, length);
    } finally {
      if ('destroy' in body) (body as { destroy: () => void }).destroy();
    }
  }
  async output(
    i: MediaIntent,
    attemptId: string,
    v: { size: number; format: string; data: Buffer; sha256: string },
  ) {
    const key = outputKey(i, attemptId, v.size, v.format);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: v.data,
        ContentType: `image/${v.format}`,
        ChecksumSHA256: Buffer.from(v.sha256, 'hex').toString('base64'),
        ServerSideEncryption: 'AES256',
        IfNoneMatch: '*',
      }),
    );
    return key;
  }
}
export class LambdaMediaDispatch {
  private config: z.infer<typeof mediaServiceConfigSchema>;
  constructor(
    private client: LambdaClient,
    config: unknown,
  ) {
    this.config = mediaServiceConfigSchema.parse(config);
  }
  async invoke(i: MediaIntent) {
    try {
      const r = await this.client.send(
        new InvokeCommand({
          FunctionName: this.config.processorArn,
          InvocationType: 'Event',
          Payload: Buffer.from(
            JSON.stringify({
              version: 1,
              productId: i.productId,
              subject: i.subject,
              uploadId: i.uploadId,
            }),
          ),
        }),
      );
      if (r.StatusCode !== 202 || r.FunctionError) throw new Error();
    } catch {
      throw new MediaConflict('MEDIA_PROCESSOR_UNAVAILABLE');
    }
  }
}
