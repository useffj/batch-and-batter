import {
  financialGauges,
  observeFinancial,
  paymentMetrics,
} from './payment-metrics';
import {
  paymentWorkSchema,
  workflowWorkSchema,
  paymentWorkKey,
} from './payment-domain';
import type { PaymentMessage } from './payment-execution-domain';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import {
  canonicalTime,
  expiryKey,
  expiryMessage,
  expiryWorkSchema,
  expiryLog,
  type ExpiryDispatch,
} from './cart-expiry';
import { expiryRuntime, type ExpiryRuntime } from './expiry-repository';
const keySchema = z.strictObject({ PK: z.string(), SK: z.string() });
const cursorSchema = z.strictObject({
  roundCutoff: canonicalTime,
  lastProcessedKey: keySchema.nullable(),
  revision: z.string().uuid(),
});
export class ExpiryReconciler {
  constructor(
    private readonly client: Pick<DynamoDBDocumentClient, 'send'>,
    private readonly operations: string,
    private readonly dispatch: ExpiryDispatch,
    private readonly runtime: ExpiryRuntime = expiryRuntime,
    // Financial port keeps provider credentials and execution out of the reconciler.
    private readonly financial?: {
      message(row: Record<string, unknown>): PaymentMessage | undefined;
      send(message: PaymentMessage, timeoutMs: number): Promise<void>;
    },
  ) {
    if (!operations) throw new Error('Operations table required');
  }
  async run(context?: {
    awsRequestId?: string;
    getRemainingTimeInMillis?: () => number;
  }) {
    const start = this.runtime.monotonic();
    const left = () =>
      Math.min(
        25000 - (this.runtime.monotonic() - start),
        (context?.getRemainingTimeInMillis?.() ?? Infinity) - 1500,
      );
    const options = () => {
      if (left() <= 0) throw new Error('Reconciliation budget');
      return {
        abortSignal: AbortSignal.timeout(
          Math.max(1, Math.floor(Math.min(1000, left()))),
        ),
      };
    };
    const gauges = financialGauges();
    let financialFailures = 0,
      coverageComplete = true;
    let deferredPayment = 0;
    let examined = 0,
      sent = 0,
      failures = 0,
      oldest = 0,
      visited = 0,
      invalid = 0;
    // Rotate the first shard every minute so bounded invocations cannot privilege
    // the same prefix forever. Within each shard persist a fixed-cutoff round.
    const first = Math.floor(this.runtime.now() / 60000) % 16;
    for (let index = 0; index < 16; index++) {
      if (left() < 1500) break;
      const shard = ((first + index) % 16)
        .toString(16)
        .toUpperCase()
        .padStart(2, '0');
      const pk = `CART_EXPIRY#V1#${shard}`;
      const cursorKey = {
        PK: 'CART_EXPIRY_RECONCILE#V1',
        SK: `SHARD#${shard}`,
      };
      try {
        const { Item } = await this.client.send(
          new GetCommand({
            TableName: this.operations,
            Key: cursorKey,
            ConsistentRead: true,
          }),
          options(),
        );
        let prior: z.infer<typeof cursorSchema> | undefined;
        if (Item) {
          const { PK, SK, ...data } = Item;
          if (PK !== cursorKey.PK || SK !== cursorKey.SK)
            throw new Error('Invalid cursor');
          prior = cursorSchema.parse(data);
          if (
            prior.lastProcessedKey &&
            (prior.lastProcessedKey.PK !== pk ||
              prior.lastProcessedKey.SK > `${prior.roundCutoff}#~`)
          )
            throw new Error('Invalid cursor key');
        }
        const cutoff = prior?.lastProcessedKey
          ? prior.roundCutoff
          : new Date(this.runtime.now()).toISOString();
        let last = prior?.lastProcessedKey ?? undefined;
        // Oldest overdue age is independent of pagination progress, so poison work
        // cannot disappear from the age alarm behind a cursor.
        const oldestPage = await this.client.send(
          new QueryCommand({
            TableName: this.operations,
            ConsistentRead: true,
            KeyConditionExpression: 'PK = :pk AND SK <= :upper',
            ExpressionAttributeValues: {
              ':pk': pk,
              ':upper': `${new Date(this.runtime.now()).toISOString()}#~`,
            },
            Limit: 1,
          }),
          options(),
        );
        if (oldestPage.Items?.length) {
          const date = canonicalTime.safeParse(
            String(oldestPage.Items[0].SK).split('#')[0],
          );
          if (date.success)
            oldest = Math.max(
              oldest,
              this.runtime.now() - Date.parse(date.data),
            );
          else invalid++;
        }
        // Independent bounded monitoring pass includes future retries and work behind the dispatch cursor.
        // Incomplete coverage suppresses healthy zero gauges and the heartbeat.
        if (this.financial) {
          const future = await this.client.send(
            new QueryCommand({
              TableName: this.operations,
              ConsistentRead: true,
              KeyConditionExpression: 'PK = :pk',
              ExpressionAttributeValues: { ':pk': pk },
              Limit: 25,
            }),
            options(),
          );
          for (const row of future.Items ?? [])
            if (this.financial.message(row))
              observeFinancial(gauges, row, this.runtime.now());
          if (future.LastEvaluatedKey) coverageComplete = false;
        }
        let count = 0;
        let complete = false;
        while (count < 25 && left() >= 1500) {
          const page = await this.client.send(
            new QueryCommand({
              TableName: this.operations,
              ConsistentRead: true,
              KeyConditionExpression: 'PK = :pk AND SK <= :upper',
              ExpressionAttributeValues: { ':pk': pk, ':upper': `${cutoff}#~` },
              Limit: 25 - count,
              ...(last ? { ExclusiveStartKey: last } : {}),
            }),
            options(),
          );
          const rows = page.Items ?? [];
          let processed = 0;
          const done = new Set<string>();
          const shopping = rows.filter((r) => r.deadlineType === 'SHOPPING');
          const other = rows.filter((r) => r.deadlineType !== 'SHOPPING');
          const interleaved = this.financial
            ? Array.from(
                { length: Math.max(shopping.length, other.length) },
                (_, i) => [shopping[i], other[i]],
              )
                .flat()
                .filter(Boolean)
            : rows;
          for (const row of interleaved) {
            if (left() < 1000) break;
            const { PK, SK, ...data } = row;
            const actualKey = keySchema.parse({ PK, SK });
            if (PK !== pk) throw new Error('Invalid query key');
            const financialMessage = this.financial?.message(row);
            const payment = paymentWorkSchema
              .or(workflowWorkSchema)
              .safeParse(data);
            const work = expiryWorkSchema.safeParse(data);
            if (financialMessage) {
              observeFinancial(gauges, row, this.runtime.now());
              try {
                const timeoutMs = Math.max(1, Math.min(400, left()));
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                  await Promise.race([
                    this.financial!.send(financialMessage, timeoutMs),
                    new Promise<never>((_, reject) => {
                      timer = setTimeout(
                        () => reject(new Error('Financial dispatch timeout')),
                        timeoutMs,
                      );
                    }),
                  ]);
                } finally {
                  if (timer) clearTimeout(timer);
                }
                sent++;
              } catch {
                failures++;
                financialFailures++;
              }
            } else if (
              payment.success &&
              JSON.stringify(paymentWorkKey(payment.data)) ===
                JSON.stringify(actualKey)
            ) {
              // Foundation only: retain recognizable work, never pretend financial processing succeeded.
              deferredPayment++;
            } else if (
              !work.success ||
              JSON.stringify(
                expiryKey(work.data.cartId, work.data.deadline),
              ) !== JSON.stringify(actualKey)
            )
              invalid++;
            else {
              try {
                await this.dispatch.send(
                  expiryMessage(work.data.cartId, work.data.deadline),
                  0,
                  Math.min(400, left()),
                );
                sent++;
              } catch {
                failures++;
              }
            }
            // Advance past examined poison/failed records for fairness. Work is
            // NEVER deleted or marked sent; next round revisits every failure.
            done.add(`${actualKey.PK}|${actualKey.SK}`);
            count++;
            examined++;
            processed++;
          }
          // Advance only the contiguous chronological prefix, even when dispatch was interleaved.
          for (const row of rows) {
            if (!done.has(`${row.PK}|${row.SK}`)) break;
            last = { PK: row.PK, SK: row.SK };
          }
          if (processed < rows.length) break;
          if (!page.LastEvaluatedKey) {
            complete = true;
            break;
          }
          last = keySchema.parse(page.LastEvaluatedKey);
        }
        await this.client.send(
          new PutCommand({
            TableName: this.operations,
            Item: {
              ...cursorKey,
              roundCutoff: cutoff,
              lastProcessedKey: complete ? null : (last ?? null),
              revision: randomUUID(),
            },
            ConditionExpression: prior
              ? '#revision = :revision'
              : 'attribute_not_exists(PK)',
            ...(prior
              ? {
                  ExpressionAttributeNames: { '#revision': 'revision' },
                  ExpressionAttributeValues: { ':revision': prior.revision },
                }
              : {}),
          }),
          options(),
        );
        if (!complete) coverageComplete = false;
        visited++;
      } catch {
        failures++;
      }
    }
    if (this.financial) {
      const complete =
        coverageComplete && visited === 16 && failures === 0 && invalid === 0;
      paymentMetrics('reconciler', {
        ...Object.fromEntries(
          Object.entries(gauges).filter(([, v]) => complete || v > 0),
        ),
        FinancialRoutingFailure: financialFailures,
        RecoveryHeartbeat: complete ? 1 : 0,
      });
    }
    expiryLog(
      'reconcileCartExpiry',
      failures ? 'partial_failure' : 'complete',
      {
        ReconcileHeartbeat: 1,
        PaymentWorkDeferred: deferredPayment,
        ReconcileFailure: failures,
        InvalidWork: invalid,
        Examined: examined,
        Sent: sent,
        DueWorkBacklogLowerBound: examined,
        OldestOverdueMs: Math.max(0, oldest),
        ShardsVisited: visited,
      },
      { awsRequestId: context?.awsRequestId },
    );
    if (failures) throw new Error('Cart expiry reconciliation incomplete');
    return { examined, sent, visited, invalid };
  }
}
export const reconcileEventSchema = z.strictObject({
  source: z.literal('batch-and-batter.cart-expiry'),
  operation: z.literal('reconcileCartExpiry'),
  schemaVersion: z.literal(1),
});
