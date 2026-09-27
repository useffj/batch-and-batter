import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SQSClient } from '@aws-sdk/client-sqs';
import { SqsExpiryDispatch } from './cart-expiry';
export const expiryDocumentClient = () =>
  DynamoDBDocumentClient.from(
    new DynamoDBClient({
      maxAttempts: 1,
      requestHandler: {
        connectionTimeout: 300,
        requestTimeout: 700,
        throwOnRequestTimeout: true,
      },
    }),
  );
export const expiryDispatch = () =>
  new SqsExpiryDispatch(
    new SQSClient({
      maxAttempts: 1,
      requestHandler: {
        connectionTimeout: 300,
        requestTimeout: 700,
        throwOnRequestTimeout: true,
      },
    }),
    process.env.RESERVATION_QUEUE_URL ?? '',
  );
