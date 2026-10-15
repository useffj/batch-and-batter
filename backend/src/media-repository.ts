import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { idSchema, productSchema } from './domain';
import { catalogKeys } from './keys';
import { integrityReadyKey, slugKey } from './product-integrity';
import { generateUlid } from './ulid';
import {
  MediaConflict,
  createIntent,
  mediaKeys,
  planManifest,
  manifestRequestSchema,
  queueIntent,
  claimIntent,
  finishIntent,
  expireIntent,
  compactReceipt,
  fenceDeletion,
} from './media-contract';
import {
  assetSchema,
  intentSchema,
  uploadSchema,
  manifestSchema,
  verifiedResultSchema,
  recordKey,
  type MediaAsset,
  type MediaIntent,
  type MediaUpload,
  type MediaManifest,
} from './media-records';
type Actions = NonNullable<TransactWriteCommandInput['TransactItems']>;
type Key = { PK: string; SK: string };
const fail = (code: string): never => {
  throw new MediaConflict(code);
};
// Not an authentication boundary. Future routes must enforce Cognito admin groups.
// Processor-only completion must never accept HTTP-supplied verification claims.
export class MediaRepository {
  constructor(
    private client: DynamoDBDocumentClient,
    private table: string,
    private now: () => number = Date.now,
  ) {}
  private async raw(key: Key) {
    try {
      return (
        await this.client.send(
          new GetCommand({
            TableName: this.table,
            Key: key,
            ConsistentRead: true,
          }),
        )
      ).Item;
    } catch {
      return fail('MEDIA_STORAGE_UNAVAILABLE');
    }
  }
  private async read<T>(
    key: Key,
    schema: z.ZodType<T>,
  ): Promise<T | undefined> {
    const raw = await this.raw(key);
    if (!raw) return undefined;
    const { PK, SK, ...body } = raw;
    const p = schema.safeParse(body);
    if (PK !== key.PK || SK !== key.SK || !p.success)
      return fail('MEDIA_RECORD_INVALID');
    return p.data;
  }
  async manifest(productId: string) {
    const v = await this.read(mediaKeys.manifest(productId), manifestSchema);
    if (v && v.productId !== productId) return fail('MEDIA_RECORD_INVALID');
    return v;
  }
  async readyAssets(productId: string, after?: string) {
    const key = mediaKeys.manifest(productId);
    let start: Key | undefined;
    if (after !== undefined) {
      const parts = after.split('.');
      if (
        parts.length !== 2 ||
        parts[0] !== productId ||
        !idSchema.safeParse(parts[1]).success
      )
        return fail('INVALID_MEDIA_CURSOR');
      start = mediaKeys.asset(productId, parts[1]);
    }
    // One bounded partition query per request, including filtered/empty pages.
    let page;
    try {
      page = await this.client.send(
        new QueryCommand({
          TableName: this.table,
          ConsistentRead: true,
          Limit: 12,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
          ExpressionAttributeValues: { ':pk': key.PK, ':prefix': 'ASSET#' },
          ...(start ? { ExclusiveStartKey: start } : {}),
        }),
      );
    } catch {
      return fail('MEDIA_STORAGE_UNAVAILABLE');
    }
    const manifest = await this.manifest(productId);
    const attached = new Set(manifest?.images.map((i) => i.mediaId));
    const assets: MediaAsset[] = [];
    for (const item of page.Items ?? []) {
      const { PK, SK, ...body } = item;
      const parsed = assetSchema.safeParse(body);
      if (
        !parsed.success ||
        PK !== key.PK ||
        parsed.data.productId !== productId ||
        SK !== 'ASSET#' + parsed.data.mediaId
      )
        return fail('MEDIA_RECORD_INVALID');
      if (parsed.data.state === 'READY' && !attached.has(parsed.data.mediaId))
        assets.push(parsed.data);
    }
    const last = page.LastEvaluatedKey;
    if (
      last &&
      (last.PK !== key.PK ||
        typeof last.SK !== 'string' ||
        !last.SK.startsWith('ASSET#') ||
        !idSchema.safeParse(last.SK.slice(6)).success)
    )
      return fail('MEDIA_RECORD_INVALID');
    return {
      assets,
      nextCursor: last ? productId + '.' + last.SK.slice(6) : null,
    };
  }
  async asset(productId: string, mediaId: string) {
    const v = await this.read(mediaKeys.asset(productId, mediaId), assetSchema);
    if (v && (v.productId !== productId || v.mediaId !== mediaId))
      return fail('MEDIA_RECORD_INVALID');
    return v;
  }
  async upload(productId: string, owner: string, id: string) {
    const v = await this.read(mediaKeys.upload(id), uploadSchema);
    if (
      v &&
      (v.productId !== productId || v.subject !== owner || v.uploadId !== id)
    )
      return fail('UPLOAD_NOT_FOUND');
    return v;
  }
  private put(
    v: MediaAsset | MediaUpload | MediaManifest,
    old?: { revision: number },
  ) {
    return {
      Put: {
        TableName: this.table,
        Item: { ...v, ...recordKey(v) },
        ConditionExpression: old
          ? '#revision = :revision'
          : 'attribute_not_exists(PK)',
        ...(old
          ? {
              ExpressionAttributeNames: { '#revision': 'revision' },
              ExpressionAttributeValues: { ':revision': old.revision },
            }
          : {}),
      },
    };
  }
  private check(key: Key, old?: { revision: number }) {
    return {
      ConditionCheck: {
        TableName: this.table,
        Key: key,
        ConditionExpression: old
          ? '#revision = :revision'
          : 'attribute_not_exists(PK)',
        ...(old
          ? {
              ExpressionAttributeNames: { '#revision': 'revision' },
              ExpressionAttributeValues: { ':revision': old.revision },
            }
          : {}),
      },
    };
  }
  private async guards(productId: string): Promise<Actions> {
    const raw = await this.raw(catalogKeys.product(productId));
    if (!raw) return fail('PRODUCT_NOT_FOUND');
    const { PK, SK, ...body } = raw,
      p = productSchema.safeParse(body);
    if (!p.success || p.data.productId !== productId)
      return fail('PRODUCT_INTEGRITY_CONFLICT');
    const product = p.data;
    return [
      {
        ConditionCheck: {
          TableName: this.table,
          Key: integrityReadyKey,
          ConditionExpression: '#version = :version AND #state = :ready',
          ExpressionAttributeNames: {
            '#version': 'version',
            '#state': 'state',
          },
          ExpressionAttributeValues: { ':version': 1, ':ready': 'READY' },
        },
      },
      {
        ConditionCheck: {
          TableName: this.table,
          Key: catalogKeys.product(productId),
          ConditionExpression:
            'productId = :id AND createdAt = :created AND updatedAt = :updated AND slug = :slug',
          ExpressionAttributeValues: {
            ':id': productId,
            ':created': product.createdAt,
            ':updated': product.updatedAt,
            ':slug': product.slug,
          },
        },
      },
      {
        ConditionCheck: {
          TableName: this.table,
          Key: slugKey(product.slug),
          ConditionExpression: 'canonicalSlug = :slug AND productId = :owner',
          ExpressionAttributeValues: {
            ':slug': product.slug,
            ':owner': productId,
          },
        },
      },
    ];
  }
  private async transact(actions: Actions, conflict: string) {
    const keys = actions.map((a) => {
      const op = a.Put ?? a.ConditionCheck!;
      const k = 'Item' in op ? op.Item! : op.Key!;
      return JSON.stringify([k.PK, k.SK]);
    });
    if (new Set(keys).size !== keys.length)
      return fail('MEDIA_TRANSACTION_INVALID');
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: actions,
          ClientRequestToken: randomUUID(),
        }),
      );
    } catch (error) {
      const e = error as {
          name?: string;
          CancellationReasons?: { Code?: string }[];
        },
        r =
          e.name === 'TransactionCanceledException'
            ? e.CancellationReasons
            : undefined;
      if (r?.length === actions.length) {
        if (r[0]?.Code === 'ConditionalCheckFailed')
          return fail('PRODUCT_WRITES_NOT_READY');
        if (r[1]?.Code === 'ConditionalCheckFailed')
          return fail('PRODUCT_CONFLICT');
        if (r[2]?.Code === 'ConditionalCheckFailed')
          return fail('PRODUCT_INTEGRITY_CONFLICT');
        if (r.slice(3).some((x) => x.Code === 'ConditionalCheckFailed'))
          return fail(conflict);
      }
      return fail('MEDIA_STORAGE_UNAVAILABLE');
    }
  }
  async replaceManifest(
    productId: string,
    raw: unknown,
  ): Promise<MediaManifest> {
    const req = manifestRequestSchema.parse(raw),
      current = await this.manifest(productId);
    if ((current?.revision ?? 0) !== req.expectedRevision)
      return fail('MEDIA_REVISION_CONFLICT');
    const ids = [
      ...new Set(
        [...(current?.images ?? []), ...req.images].map((i) => i.mediaId),
      ),
    ];
    const found = await Promise.all(ids.map((id) => this.asset(productId, id)));
    if (found.some((a) => !a)) return fail('ASSET_NOT_FOUND');
    const assets = found as MediaAsset[],
      plan = planManifest(
        productId,
        current,
        req,
        assets,
        this.now(),
        true,
        true,
      ),
      next = manifestSchema.parse({ version: 1, ...plan.manifest }),
      changes = new Map(plan.assets.map((a) => [a.mediaId, a]));
    const actions: Actions = [
      ...(await this.guards(productId)),
      this.put(next, current),
    ];
    for (const a of assets) {
      const change = changes.get(a.mediaId);
      actions.push(
        change
          ? this.put(assetSchema.parse({ ...a, ...change }), a)
          : this.check(mediaKeys.asset(productId, a.mediaId), a),
      );
    }
    await this.transact(actions, 'MEDIA_REVISION_CONFLICT');
    return next;
  }
  private replay(v: MediaUpload, hash: string) {
    if (v.requestHash !== hash) return fail('IDEMPOTENCY_CONFLICT');
    if (v.state === 'TOMBSTONE') return fail('UPLOAD_RESULT_EXPIRED');
    if (
      v.state === 'EXPIRED' ||
      (!['READY', 'FAILED'].includes(v.state) && this.now() >= v.expiresAt)
    )
      return fail('UPLOAD_EXPIRED');
    return v;
  }
  async createUpload(
    productId: string,
    owner: string,
    key: string,
    request: unknown,
  ): Promise<MediaIntent> {
    const candidate = intentSchema.parse({
      ...createIntent(
        productId,
        owner,
        key,
        generateUlid(),
        request,
        this.now(),
      ),
      attemptIds: [],
    });
    const old = await this.upload(productId, owner, candidate.uploadId);
    if (old) return this.replay(old, candidate.requestHash);
    try {
      await this.transact(
        [...(await this.guards(productId)), this.put(candidate)],
        'UPLOAD_CONFLICT',
      );
    } catch (error) {
      const saved = await this.upload(productId, owner, candidate.uploadId);
      if (saved) return this.replay(saved, candidate.requestHash);
      throw error;
    }
    return candidate;
  }
  private async full(productId: string, owner: string, id: string) {
    const i = await this.upload(productId, owner, id);
    if (!i) return fail('UPLOAD_NOT_FOUND');
    if (i.state === 'TOMBSTONE') return fail('UPLOAD_RESULT_EXPIRED');
    return i;
  }
  private async transition(old: MediaIntent, next: MediaIntent) {
    if (isDeepStrictEqual(old, next)) return next;
    try {
      const guards = await this.guards(old.productId);
      if (next.state === 'QUEUED' && this.now() >= next.expiresAt)
        return fail('UPLOAD_EXPIRED');
      if (
        next.state === 'PROCESSING' &&
        next.leaseToken !== old.leaseToken &&
        this.now() >= (next.leaseUntil ?? 0)
      )
        return fail('PROCESSING_CONFLICT');
      if (next.state === 'FAILED')
        finishIntent(old, next.leaseToken!, this.now(), false);
      await this.transact(
        [...guards, this.put(next, old)],
        'PROCESSING_CONFLICT',
      );
    } catch (error) {
      const saved = await this.upload(old.productId, old.subject, old.uploadId);
      if (isDeepStrictEqual(saved, next)) return next;
      throw error;
    }
    return next;
  }
  async assertWritable(productId: string) {
    await this.transact(await this.guards(productId), 'PRODUCT_CONFLICT');
  }
  async reserveDispatch(productId: string, owner: string, id: string) {
    const i = await this.full(productId, owner, id),
      now = this.now();
    if (i.state === 'READY') return { intent: i, dispatch: false };
    queueIntent(i, productId, owner, now);
    if (i.attempts >= 3) return fail('ATTEMPTS_EXHAUSTED');
    if (
      (i.dispatchAfter ?? 0) > now ||
      (i.state === 'PROCESSING' && (i.leaseUntil ?? 0) > now)
    )
      return { intent: i, dispatch: false };
    const queued = queueIntent(i, productId, owner, now);
    const next = intentSchema.parse({
      ...queued,
      revision: i.revision + 1,
      dispatchAfter: Math.min(now + 30000, i.expiresAt),
      dispatchToken: randomUUID(),
    });
    return { intent: await this.transition(i, next), dispatch: true };
  }
  async queue(productId: string, owner: string, id: string) {
    const i = await this.full(productId, owner, id);
    return this.transition(
      i,
      intentSchema.parse(queueIntent(i, productId, owner, this.now())),
    );
  }
  async claim(productId: string, owner: string, id: string, attemptId: string) {
    const i = await this.full(productId, owner, id);
    if (i.state === 'READY') return i;
    if (i.attemptIds.includes(attemptId)) return fail('ATTEMPT_ID_REUSED');
    return this.transition(
      i,
      intentSchema.parse({
        ...claimIntent(i, attemptId, this.now()),
        attemptIds: [...i.attemptIds, attemptId],
      }),
    );
  }
  // Trusted processor method: structural validation is NOT evidence of image decoding.
  async complete(
    productId: string,
    owner: string,
    id: string,
    attemptId: string,
    result: unknown,
  ) {
    const i = await this.full(productId, owner, id);
    if (i.state === 'READY') {
      if (i.leaseToken !== attemptId) return fail('PROCESSING_CONFLICT');
      return i;
    }
    const now = this.now(),
      next = finishIntent(i, attemptId, now, true),
      asset = assetSchema.parse({
        version: 1,
        productId,
        mediaId: i.mediaId,
        uploadId: id,
        revision: 1,
        state: 'READY',
        readyAt: now,
        attemptId,
        result: verifiedResultSchema.parse(result),
      }),
      completed = intentSchema.parse({ ...next, result: asset });
    try {
      const guards = await this.guards(productId);
      // Submission-time eligibility, not a DynamoDB commit-time clock cutoff.
      // A delayed write may win only while this revision/attempt is still PROCESSING.
      finishIntent(i, attemptId, this.now(), true);
      const completion: { Put: NonNullable<Actions[number]['Put']> } = this.put(
        completed,
        i,
      );
      completion.Put.ConditionExpression =
        '#revision = :revision AND #state = :processing AND leaseToken = :attempt';
      completion.Put.ExpressionAttributeNames = {
        ...completion.Put.ExpressionAttributeNames,
        '#state': 'state',
      };
      completion.Put.ExpressionAttributeValues = {
        ...completion.Put.ExpressionAttributeValues,
        ':processing': 'PROCESSING',
        ':attempt': attemptId,
      };
      await this.transact(
        [...guards, completion, this.put(asset)],
        'PROCESSING_CONFLICT',
      );
    } catch (error) {
      const saved = await this.upload(productId, owner, id);
      if (
        saved?.state === 'READY' &&
        saved.leaseToken === attemptId &&
        isDeepStrictEqual(saved.result?.result, asset.result)
      )
        return saved;
      throw error;
    }
    return completed;
  }
  async failProcessing(
    productId: string,
    owner: string,
    id: string,
    attemptId: string,
    code: 'INVALID_MEDIA' | 'PROCESSING_FAILED',
  ) {
    const i = await this.full(productId, owner, id);
    if (i.state === 'FAILED' && i.leaseToken === attemptId) return i;
    return this.transition(
      i,
      intentSchema.parse({
        ...finishIntent(i, attemptId, this.now(), false),
        failureCode: code,
      }),
    );
  }
  async expire(productId: string, owner: string, id: string) {
    const i = await this.full(productId, owner, id);
    return this.transition(i, intentSchema.parse(expireIntent(i, this.now())));
  }
  async compact(productId: string, owner: string, id: string) {
    const i = await this.upload(productId, owner, id);
    if (!i) return fail('UPLOAD_NOT_FOUND');
    if (i.state === 'TOMBSTONE') return i;
    const next = uploadSchema.parse(compactReceipt(i, this.now()));
    try {
      await this.transact(
        [...(await this.guards(productId)), this.put(next, i)],
        'RECEIPT_CONFLICT',
      );
    } catch (error) {
      const saved = await this.upload(productId, owner, id);
      if (isDeepStrictEqual(saved, next)) return next;
      throw error;
    }
    return next;
  }
  async fenceDeletion(productId: string, mediaId: string) {
    const a = await this.asset(productId, mediaId);
    if (!a) return fail('ASSET_NOT_FOUND');
    const m = await this.manifest(productId),
      next = assetSchema.parse({
        ...a,
        ...fenceDeletion(
          a,
          !!m?.images.some((i) => i.mediaId === mediaId),
          this.now(),
        ),
      });
    await this.transact(
      [
        ...(await this.guards(productId)),
        this.check(mediaKeys.manifest(productId), m),
        this.put(next, a),
      ],
      'DELETION_CONFLICT',
    );
    return next;
  }
}
