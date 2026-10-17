import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { MediaRepository } from '../../backend/src/media-repository';
import { S3MediaStorage } from '../../backend/src/media-storage';
import { processMedia } from '../../backend/src/media-orchestration';
import { processImage } from './process-image.mjs';

export function configuration(env: NodeJS.ProcessEnv) {
  const region = env.AWS_REGION;
  const bucket = env.MEDIA_BUCKET_NAME;
  const table = env.CATALOG_TABLE_NAME;
  if (
    region !== 'us-east-2' ||
    bucket !== 'batch-and-batter-dev-isolated-media-302154194958-us-east-2' ||
    table !== 'batch-and-batter-dev-isolated-catalog'
  )
    throw new Error('MEDIA_PROCESSOR_CONFIGURATION_INVALID');
  return { region, bucket, table };
}

// Injection is for local tests only. The exported Lambda handler always constructs
// real adapters; event fields cannot select dependencies, buckets, keys or endpoints.
export function createProcessor(
  repository: MediaRepository,
  storage: Pick<S3MediaStorage, 'source' | 'output'>,
) {
  return async (event: unknown) => {
    try {
      return await processMedia(event, repository, storage, processImage);
    } catch {
      // Lambda retries a thrown error. Do not log identities, object keys, image
      // bytes, credentials, decoder messages or raw SDK exceptions.
      throw new Error('MEDIA_PROCESSOR_FAILED');
    }
  };
}
let processor: ReturnType<typeof createProcessor> | undefined;
export async function handler(event: unknown) {
  if (!processor) {
    const c = configuration(process.env);
    const options = {
      region: c.region,
      maxAttempts: 1,
      requestHandler: {
        connectionTimeout: 500,
        requestTimeout: 3000,
        throwOnRequestTimeout: true,
      },
    };
    processor = createProcessor(
      new MediaRepository(
        DynamoDBDocumentClient.from(new DynamoDBClient(options)),
        c.table,
      ),
      new S3MediaStorage(new S3Client(options), {
        enabled: true,
        region: c.region,
        bucket: c.bucket,
        processorArn:
          'arn:aws:lambda:us-east-2:302154194958:function:batch-and-batter-dev-isolated-media-processor',
      }),
    );
  }
  return processor(event);
}
