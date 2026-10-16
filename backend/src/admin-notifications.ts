import {
  QueryCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { idSchema } from './domain';
import { operationSchema } from './notification-contract';
export class AdminNotifications {
  constructor(
    private client: Pick<DynamoDBDocumentClient, 'send'>,
    private table: string,
  ) {
    if (!table) throw Error('Operations table required');
  }
  async status(id: string) {
    idSchema.parse(id);
    const r = await this.client.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'PK=:pk',
        ExpressionAttributeValues: { ':pk': 'ORDER_NOTIFICATIONS#' + id },
        ConsistentRead: true,
        Limit: 50,
      }),
    );
    return {
      notifications: (r.Items ?? []).map(({ PK, SK, ...data }) => {
        const o = operationSchema.parse(data);
        if (o.orderId !== id || SK !== o.key)
          throw Error('Notification identity mismatch');
        return o;
      }),
      truncated: !!r.LastEvaluatedKey,
      confirmationSms: 'NOT_CONFIGURED',
    };
  }
}
