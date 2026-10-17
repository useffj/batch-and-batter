import { createHash } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { AdminError } from './admin-auth';
import type { ApiEvent, ApiResponse } from './api';
import { idSchema } from './domain';
import type { CatalogRepository } from './repository';
import { MediaRepository } from './media-repository';
import { S3MediaStorage, LambdaMediaDispatch } from './media-storage';
import { MediaOrchestration } from './media-orchestration';
import { ISOLATED_TABLE } from './isolated-catalog-contract';
export const ISOLATED_MEDIA_BUCKET =
  'batch-and-batter-dev-isolated-media-302154194958-us-east-2';
export const ISOLATED_PROCESSOR =
  'arn:aws:lambda:us-east-2:302154194958:function:batch-and-batter-dev-isolated-media-processor';
export function mediaConfiguration(env: NodeJS.ProcessEnv) {
  if (
    env.CATALOG_TABLE_NAME !== ISOLATED_TABLE ||
    env.PAYMENT_START_ENABLED !== 'false' ||
    env.MEDIA_ENABLED !== 'isolated' ||
    env.MEDIA_BUCKET_NAME !== ISOLATED_MEDIA_BUCKET ||
    env.MEDIA_PROCESSOR_ARN !== ISOLATED_PROCESSOR ||
    env.AWS_REGION !== 'us-east-2'
  )
    throw new AdminError(
      503,
      'MEDIA_UPLOAD_UNAVAILABLE',
      'Isolated media is disabled.',
    );
  return {
    enabled: true as const,
    region: 'us-east-2' as const,
    bucket: ISOLATED_MEDIA_BUCKET,
    processorArn: ISOLATED_PROCESSOR,
  };
}
export class IsolatedMedia {
  constructor(
    readonly repository: MediaRepository,
    readonly services: MediaOrchestration,
    private s3: S3Client,
  ) {}
  async image(
    e: ApiEvent,
    catalog: () => CatalogRepository,
  ): Promise<ApiResponse & { isBase64Encoded: boolean }> {
    const p = idSchema.safeParse(e.pathParameters?.productId),
      m = idSchema.safeParse(e.pathParameters?.mediaId);
    if (
      !p.success ||
      !m.success ||
      e.body ||
      Object.keys(e.queryStringParameters ?? {}).some((k) => k !== 'view') ||
      e.queryStringParameters?.view !== 'image'
    )
      throw new AdminError(400, 'VALIDATION_ERROR', 'Invalid image request.');
    if (!(await catalog().getProduct(p.data)))
      throw new AdminError(404, 'PRODUCT_NOT_FOUND', 'Product unavailable.');
    const asset = await this.repository.asset(p.data, m.data);
    if (!asset || !['READY', 'ATTACHED'].includes(asset.state))
      throw new AdminError(404, 'ASSET_NOT_FOUND', 'Image unavailable.');
    const v = asset.result.variants.find(
      (v) => v.size === 480 && v.format === 'webp',
    );
    if (!v) throw new AdminError(404, 'ASSET_NOT_FOUND', 'Image unavailable.');
    const r = await this.s3.send(
      new GetObjectCommand({ Bucket: ISOLATED_MEDIA_BUCKET, Key: v.key }),
    );
    if (!r.Body) throw new Error('Image unavailable');
    const chunks: Buffer[] = [];
    let length = 0;
    try {
      if (r.ContentLength !== v.bytes || r.ContentType !== 'image/webp')
        throw new Error('Invalid derivative');
      for await (const part of r.Body as AsyncIterable<Uint8Array>) {
        length += part.length;
        if (length > v.bytes || length > 1048576)
          throw new Error('Invalid derivative');
        chunks.push(Buffer.from(part));
      }
    } finally {
      if ('destroy' in r.Body) (r.Body as { destroy: () => void }).destroy();
    }
    const bytes = Buffer.concat(chunks);
    if (
      length !== v.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== v.sha256
    )
      throw new Error('Invalid derivative');
    return {
      statusCode: 200,
      isBase64Encoded: true,
      headers: {
        'content-type': 'image/webp',
        'cache-control': 'no-store, private',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      },
      body: bytes.toString('base64'),
    };
  }
}
let instance: IsolatedMedia | undefined;
export function isolatedMedia(env: NodeJS.ProcessEnv) {
  const c = mediaConfiguration(env);
  if (!instance) {
    const options = { region: c.region, maxAttempts: 1 };
    const repository = new MediaRepository(
      DynamoDBDocumentClient.from(new DynamoDBClient(options)),
      ISOLATED_TABLE,
    );
    const s3 = new S3Client(options);
    instance = new IsolatedMedia(
      repository,
      new MediaOrchestration(
        repository,
        new S3MediaStorage(s3, c),
        new LambdaMediaDispatch(new LambdaClient(options), c),
      ),
      s3,
    );
  }
  return instance;
}
