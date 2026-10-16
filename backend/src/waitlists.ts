import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  GetCommand,
  QueryCommand,
  PutCommand,
  UpdateCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { AdminError } from './admin-auth';
import { catalogKeys } from './keys';
import {
  idSchema,
  productSchema,
  dropSchema,
  dropProductSchema,
  inventorySchema,
  availableInventory,
} from './domain';
import {
  DeliveryFailure,
  type MessageProvider,
} from './notification-providers';

export const waitlistScope = z.strictObject({
  dropId: idSchema,
  productId: idSchema,
});
export const waitlistSignup = waitlistScope.extend({
  email: z
    .email()
    .max(254)
    .transform((v) => v.toLowerCase()),
  consent: z.literal(true),
});
const entrySchema = waitlistScope.extend({
  id: z.uuid(),
  email: z.email().max(254),
  joinedAt: z.iso.datetime(),
  consentVersion: z.literal('availability-email-v1'),
  suppressed: z.boolean(),
});
type Entry = z.infer<typeof entrySchema>;
type Scope = z.infer<typeof waitlistScope>;
export const waitlistMessage = waitlistScope.extend({
  type: z.literal('WAITLIST'),
  event: z.string().regex(/^[a-f0-9]{64}$/),
  entryKey: z.string().max(100),
});
export type WaitlistMessage = z.infer<typeof waitlistMessage>;
const unavailable = () =>
  new AdminError(
    409,
    'WAITLIST_UNAVAILABLE',
    'This waitlist or availability event is no longer eligible. Refresh and try again.',
  );
const conflict = (e: unknown) =>
  ['ConditionalCheckFailedException', 'TransactionCanceledException'].includes(
    (e as Error)?.name,
  );
const pk = (s: Scope) => `WAITLIST#${s.dropId}#${s.productId}`;
const key = (s: Scope, sk: string) => ({ PK: pk(s), SK: sk });
const entryKey = (e: Entry) => `${e.joinedAt}#${e.id}`;
/** Source-only service. Delivery/key provisioning require a separately approved rollout. */
export class Waitlists {
  constructor(
    private db: Pick<DynamoDBDocumentClient, 'send'>,
    private catalog: string,
    private commerce: string,
    private operations: string,
    private secret: Buffer,
    private origin: string,
    private queue: { enqueue(message: WaitlistMessage): Promise<void> },
    private email: MessageProvider,
    private now = Date.now,
  ) {
    if (
      secret.length !== 32 ||
      new URL(origin).origin !== origin ||
      !/^https:\/\//.test(origin)
    )
      throw Error('Invalid waitlist configuration');
  }
  private mac(value: string) {
    return createHmac('sha256', this.secret).update(value).digest('hex');
  }
  private async read(table: string, k: { PK: string; SK: string }) {
    return (
      await this.db.send(
        new GetCommand({ TableName: table, Key: k, ConsistentRead: true }),
      )
    ).Item;
  }
  async rateLimit(identity: string) {
    if (!identity || identity.length > 128)
      throw new AdminError(429, 'RATE_LIMITED', 'Please try again later.');
    const Key = { PK: `WAITLIST_RATE#${this.mac(identity)}`, SK: 'META' },
      bucket = Math.floor(this.now() / 60000);
    try {
      await this.db.send(
        new UpdateCommand({
          TableName: this.operations,
          Key,
          UpdateExpression: 'SET #bucket = :b, attempts = :one',
          ConditionExpression: 'attribute_not_exists(PK) OR #bucket <> :b',
          ExpressionAttributeNames: { '#bucket': 'bucket' },
          ExpressionAttributeValues: { ':b': bucket, ':one': 1 },
        }),
      );
    } catch (e) {
      if (!conflict(e)) throw e;
      try {
        await this.db.send(
          new UpdateCommand({
            TableName: this.operations,
            Key,
            UpdateExpression: 'SET attempts = attempts + :one',
            ConditionExpression: '#bucket = :b AND attempts < :max',
            ExpressionAttributeNames: { '#bucket': 'bucket' },
            ExpressionAttributeValues: { ':b': bucket, ':one': 1, ':max': 20 },
          }),
        );
      } catch {
        throw new AdminError(429, 'RATE_LIMITED', 'Please try again later.');
      }
    }
  }
  private async availability(s: Scope, purchasing: boolean) {
    const keys = [
      catalogKeys.drop(s.dropId),
      catalogKeys.product(s.productId),
      catalogKeys.dropProduct(s.dropId, s.productId),
      catalogKeys.inventory(s.dropId, s.productId),
    ];
    const assignment = await this.read(this.catalog, catalogKeys.storefront);
    if (assignment?.storefrontDropId !== s.dropId) throw unavailable();
    const rows = await Promise.all(keys.map((k) => this.read(this.catalog, k)));
    const strip = (v: Record<string, unknown> | undefined) => {
      if (!v) throw unavailable();
      const { PK, SK, ...data } = v;
      void PK;
      void SK;
      return data;
    };
    const d = dropSchema.parse(strip(rows[0])),
      p = productSchema.parse(strip(rows[1])),
      r = dropProductSchema.parse(strip(rows[2])),
      i = inventorySchema.parse(strip(rows[3]));
    if (
      d.dropId !== s.dropId ||
      p.productId !== s.productId ||
      r.dropId !== s.dropId ||
      r.productId !== s.productId ||
      i.dropId !== s.dropId ||
      i.productId !== s.productId
    )
      throw unavailable();
    const available = availableInventory(i);
    if (
      !p.active ||
      !r.active ||
      (d.closesAt && Date.parse(d.closesAt) <= this.now()) ||
      (purchasing
        ? d.status !== 'OPEN' ||
          Date.parse(d.opensAt) > this.now() ||
          available <= 0
        : !['SCHEDULED', 'OPEN', 'PAUSED', 'SOLD_OUT'].includes(d.status) ||
          available !== 0)
    )
      throw unavailable();
    // Guards bind the write to the authoritative snapshot, without reserving inventory.
    const guards = rows.map((row, index) => {
      const names: Record<string, string> = {},
        values: Record<string, unknown> = {};
      const fields =
        index === 2
          ? ['active', 'priceCents', 'cookieUnits']
          : index === 3
            ? ['total', 'reserved', 'sold', 'updatedAt']
            : ['updatedAt', 'active', 'status'];
      const terms = fields
        .filter((f) => row?.[f] !== undefined)
        .map((f, n) => {
          names[`#f${n}`] = f;
          values[`:v${n}`] = row![f];
          return `#f${n} = :v${n}`;
        });
      return {
        ConditionCheck: {
          TableName: this.catalog,
          Key: keys[index],
          ConditionExpression: terms.join(' AND '),
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        },
      };
    });
    guards.push({
      ConditionCheck: {
        TableName: this.catalog,
        Key: catalogKeys.storefront,
        ConditionExpression: '#drop = :drop',
        ExpressionAttributeNames: { '#drop': 'storefrontDropId' },
        ExpressionAttributeValues: { ':drop': s.dropId },
      },
    });
    return {
      guards,
      available,
      product: p.name,
      drop: d.name,
      event: this.mac(
        JSON.stringify({
          s: { dropId: s.dropId, productId: s.productId },
          inventory: i,
          dropRevision: d.updatedAt,
          productRevision: p.updatedAt,
        }),
      ),
    };
  }
  async join(input: unknown) {
    const s = waitlistSignup.parse(input),
      a = await this.availability(s, false);
    const identity = {
      PK: `WAITLIST_IDENTITY#${s.dropId}#${s.productId}`,
      SK: this.mac(s.email),
    };
    const accepted = {
      message:
        'Your availability-alert request has been received. Cookies are first-come, first-served; joining does not reserve or guarantee availability.',
    };
    if (await this.read(this.commerce, identity)) return accepted;
    const entry: Entry = {
      dropId: s.dropId,
      productId: s.productId,
      email: s.email,
      id: randomUUID(),
      joinedAt: new Date(this.now()).toISOString(),
      consentVersion: 'availability-email-v1',
      suppressed: false,
    };
    try {
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            ...a.guards,
            {
              Put: {
                TableName: this.commerce,
                Item: { ...key(s, entryKey(entry)), ...entry },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            {
              Put: {
                TableName: this.commerce,
                Item: { ...identity, entryKey: entryKey(entry) },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
          ],
        }),
      );
    } catch (e) {
      if (await this.read(this.commerce, identity)) return accepted;
      if (conflict(e)) throw unavailable();
      throw e;
    }
    return accepted;
  }
  private token(payload: unknown) {
    const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${data}.${this.mac(data)}`;
  }
  private decode(token: string) {
    if (token.length > 2048) throw unavailable();
    const [data, sig, ...extra] = token.split('.');
    if (
      extra.length ||
      !sig ||
      !/^[a-f0-9]{64}$/.test(sig) ||
      !timingSafeEqual(Buffer.from(sig), Buffer.from(this.mac(data)))
    )
      throw unavailable();
    return JSON.parse(Buffer.from(data, 'base64url').toString());
  }
  async unsubscribe(token: string) {
    const payload = z
      .strictObject({
        purpose: z.literal('unsubscribe'),
        scope: waitlistScope,
        key: z.string().max(100),
      })
      .parse(this.decode(token));
    const current = await this.read(
      this.commerce,
      key(payload.scope, payload.key),
    );
    if (current)
      await this.db.send(
        new UpdateCommand({
          TableName: this.commerce,
          Key: key(payload.scope, payload.key),
          UpdateExpression: 'SET suppressed = :yes, suppressedAt = :at',
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeValues: {
            ':yes': true,
            ':at': new Date(this.now()).toISOString(),
          },
        }),
      );
    return {
      message: 'Availability alerts for this cookie and Drop are now stopped.',
    };
  }
  async list(input: unknown, cursor?: string) {
    const s = waitlistScope.parse(input);
    let after: string | undefined;
    if (cursor) {
      const p = z
        .strictObject({
          purpose: z.literal('page'),
          scope: waitlistScope,
          after: z.string().max(100),
        })
        .parse(this.decode(cursor));
      if (pk(p.scope) !== pk(s)) throw unavailable();
      after = p.after;
    }
    const page = await this.db.send(
      new QueryCommand({
        TableName: this.commerce,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': pk(s) },
        Limit: 20,
        ConsistentRead: true,
        ...(after ? { ExclusiveStartKey: key(s, after) } : {}),
      }),
    );
    const entries = (page.Items ?? []).map((row) =>
      entrySchema.parse(
        Object.fromEntries(
          Object.entries(row).filter(([k]) =>
            [
              'dropId',
              'productId',
              'id',
              'email',
              'joinedAt',
              'consentVersion',
              'suppressed',
            ].includes(k),
          ),
        ),
      ),
    );
    const statuses = await Promise.all(
      entries.map(async (e) => ({
        ...e,
        notification:
          (
            await this.read(this.operations, {
              PK: `WAITLIST_HISTORY#${e.id}`,
              SK: 'LATEST',
            })
          )?.status ?? 'NOT_NOTIFIED',
      })),
    );
    return {
      entries: statuses,
      cursor: page.LastEvaluatedKey
        ? this.token({
            purpose: 'page',
            scope: s,
            after: page.LastEvaluatedKey.SK,
          })
        : null,
    };
  }
  async review(input: unknown) {
    const s = waitlistScope.parse(input);
    const a = await this.availability(s, true);
    return {
      event: a.event,
      available: a.available,
      product: a.product,
      drop: a.drop,
    };
  }
  /** Each call advances at most 20 entries; retrying a page reuses durable entry/event operations. */
  async campaign(input: unknown, event: string, actor: string) {
    const s = waitlistScope.parse(input),
      a = await this.availability(s, true);
    if (event !== a.event || !actor) throw unavailable();
    const campaignKey = {
      PK: `WAITLIST_CAMPAIGN#${s.dropId}#${s.productId}`,
      SK: event,
    };
    let campaign = await this.read(this.operations, campaignKey);
    if (!campaign) {
      try {
        await this.db.send(
          new TransactWriteCommand({
            TransactItems: [
              ...a.guards,
              {
                Put: {
                  TableName: this.operations,
                  Item: {
                    ...campaignKey,
                    createdAt: new Date(this.now()).toISOString(),
                    actor,
                    done: false,
                    after: '',
                  },
                  ConditionExpression: 'attribute_not_exists(PK)',
                },
              },
            ],
          }),
        );
      } catch (e) {
        if (!conflict(e)) throw e;
      }
      campaign = await this.read(this.operations, campaignKey);
    }
    if (!campaign) throw unavailable();
    if (campaign.done) return { done: true };
    const after = String(campaign.after),
      cutoff = String(campaign.createdAt) + '~';
    const page = await this.db.send(
      new QueryCommand({
        TableName: this.commerce,
        KeyConditionExpression: 'PK = :pk AND SK <= :cutoff',
        ExpressionAttributeValues: { ':pk': pk(s), ':cutoff': cutoff },
        Limit: 20,
        ConsistentRead: true,
        ...(after ? { ExclusiveStartKey: key(s, after) } : {}),
      }),
    );
    for (const row of page.Items ?? []) {
      if (row.suppressed || row.consentVersion !== 'availability-email-v1')
        continue;
      const sk = String(row.SK),
        opKey = { PK: `WAITLIST_DELIVERY#${row.id}`, SK: event };
      const current = await this.availability(s, true);
      if (current.event !== event) throw unavailable();
      try {
        await this.db.send(
          new TransactWriteCommand({
            TransactItems: [
              ...current.guards,
              {
                ConditionCheck: {
                  TableName: this.commerce,
                  Key: key(s, sk),
                  ConditionExpression:
                    'suppressed = :no AND consentVersion = :v',
                  ExpressionAttributeValues: {
                    ':no': false,
                    ':v': 'availability-email-v1',
                  },
                },
              },
              {
                Put: {
                  TableName: this.operations,
                  Item: {
                    ...opKey,
                    status: 'PENDING',
                    createdAt: new Date(this.now()).toISOString(),
                  },
                  ConditionExpression: 'attribute_not_exists(PK)',
                },
              },
              {
                Put: {
                  TableName: this.operations,
                  Item: {
                    PK: `WAITLIST_HISTORY#${row.id}`,
                    SK: 'LATEST',
                    status: 'PENDING',
                    event,
                    updatedAt: new Date(this.now()).toISOString(),
                  },
                },
              },
            ],
          }),
        );
      } catch (e) {
        if (!conflict(e)) throw e;
        const existing = await this.read(this.operations, opKey);
        if (!existing) {
          const latest = await this.read(this.commerce, key(s, sk));
          if (latest?.suppressed) continue;
          throw unavailable(); // A conflict is not evidence that this entry was processed.
        }
      }
      if ((await this.read(this.operations, opKey))?.status === 'PENDING')
        await this.queue.enqueue({
          type: 'WAITLIST',
          ...s,
          event,
          entryKey: sk,
        });
    }
    const next = page.LastEvaluatedKey?.SK ?? '';
    try {
      await this.db.send(
        new UpdateCommand({
          TableName: this.operations,
          Key: campaignKey,
          UpdateExpression: 'SET #after = :next, done = :done',
          ConditionExpression: '#after = :old AND done = :no',
          ExpressionAttributeNames: { '#after': 'after' },
          ExpressionAttributeValues: {
            ':next': next,
            ':done': !page.LastEvaluatedKey,
            ':old': after,
            ':no': false,
          },
        }),
      );
    } catch (e) {
      if (!conflict(e)) throw e;
    }
    return { done: !page.LastEvaluatedKey };
  }
  async deliver(input: unknown) {
    const m = waitlistMessage.parse(input),
      row = await this.read(this.commerce, key(m, m.entryKey));
    if (!row) throw unavailable();
    const opKey = { PK: `WAITLIST_DELIVERY#${row.id}`, SK: m.event };
    const op = await this.read(this.operations, opKey);
    if (!op || op.status !== 'PENDING') return;
    const finish = async (status: string) => {
      try {
        await this.db.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: this.operations,
                  Key: opKey,
                  UpdateExpression: 'SET #s = :s',
                  ExpressionAttributeNames: { '#s': 'status' },
                  ConditionExpression: '#s = :expected',
                  ExpressionAttributeValues: {
                    ':s': status,
                    ':expected': status.startsWith('SUPPRESSED')
                      ? 'PENDING'
                      : 'DISPATCHED',
                  },
                },
              },
              {
                Put: {
                  TableName: this.operations,
                  Item: {
                    PK: `WAITLIST_HISTORY#${row.id}`,
                    SK: 'LATEST',
                    status,
                    event: m.event,
                    updatedAt: new Date(this.now()).toISOString(),
                  },
                },
              },
            ],
          }),
        );
      } catch (e) {
        if (!conflict(e)) throw e;
        const expected = status.startsWith('SUPPRESSED')
          ? 'PENDING'
          : 'DISPATCHED';
        if ((await this.read(this.operations, opKey))?.status === expected)
          throw e;
      }
    };
    let a: Awaited<ReturnType<Waitlists['availability']>>;
    try {
      a = await this.availability(m, true);
    } catch (e) {
      if (e instanceof AdminError) {
        await finish('SUPPRESSED_UNAVAILABLE');
        return;
      }
      throw e;
    }
    if (row.suppressed || a.event !== m.event) {
      await finish('SUPPRESSED');
      return;
    }
    try {
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            ...a.guards,
            {
              ConditionCheck: {
                TableName: this.commerce,
                Key: key(m, m.entryKey),
                ConditionExpression: 'suppressed = :no AND consentVersion = :v',
                ExpressionAttributeValues: {
                  ':no': false,
                  ':v': 'availability-email-v1',
                },
              },
            },
            {
              Update: {
                TableName: this.operations,
                Key: opKey,
                UpdateExpression: 'SET #s = :claimed',
                ConditionExpression: '#s = :pending',
                ExpressionAttributeNames: { '#s': 'status' },
                ExpressionAttributeValues: {
                  ':claimed': 'DISPATCHED',
                  ':pending': 'PENDING',
                },
              },
            },
            {
              Put: {
                TableName: this.operations,
                Item: {
                  PK: `WAITLIST_HISTORY#${row.id}`,
                  SK: 'LATEST',
                  status: 'DISPATCHED_OUTCOME_UNKNOWN',
                  event: m.event,
                  updatedAt: new Date(this.now()).toISOString(),
                },
              },
            },
          ],
        }),
      );
    } catch (e) {
      if (conflict(e)) {
        if ((await this.read(this.operations, opKey))?.status !== 'PENDING')
          return;
        throw unavailable(); // Retain queue delivery when a transient conflict prevented the claim.
      }
      throw e;
    }
    const optout = this.token({
      purpose: 'unsubscribe',
      scope: { dropId: m.dropId, productId: m.productId },
      key: m.entryKey,
    });
    try {
      await this.email.send({
        to: String(row.email),
        subject: `Cookie availability: ${a.product}`,
        operationId: `waitlist-${row.id}-${m.event}`,
        text: `${a.product} is available in ${a.drop}. Return to ${this.origin}/ to check current availability. Purchasing is first-come, first-served. Availability is not guaranteed and no cookies are reserved for you. Stop these availability alerts: ${this.origin}/waitlist/unsubscribe#${optout}`,
      });
    } catch (e) {
      await finish(e instanceof DeliveryFailure ? 'FAILED' : 'UNCERTAIN');
      return;
    }
    await finish('SENT');
  }
}
