import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import {
  GetCommand,
  QueryCommand,
  PutCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { DynamoCartRepository } from '../src/cart-repository';
import { secretHash, ownsReserved, type CartRequest } from '../src/cart-domain';
import { catalogKeys } from '../src/keys';
import {
  drop,
  product,
  relation,
  inventory,
  dropId,
  productId,
  timestamp,
} from './fixtures';
export type Row = Record<string, any>;
export type Actions = NonNullable<TransactWriteCommandInput['TransactItems']>;
export const token = Buffer.alloc(32, 17).toString('base64url');
export const tokenHash = secretHash(token);
export const pid = (n: number) => `01K5J1${String(n).padStart(20, '0')}`;
export class CartStore {
  rows = new Map<string, Row>();
  transactions: Actions[] = [];
  commits = 0;
  now = Date.parse(timestamp);
  elapsed = 0;
  sequence = 100;
  keySequence = 0;
  before?: (actions: Actions) => void | Promise<void>;
  queryPageSize = 25;
  queries: any[] = [];
  beforeCursor?: () => void;
  after?: () => void;
  forcedCode?: string;
  sleeps: number[] = [];
  key(table: string, key: Row) {
    return `${table}|${key.PK}|${key.SK}`;
  }
  put(table: string, row: Row) {
    this.rows.set(this.key(table, row), structuredClone(row));
  }
  row(table: string, key: Row) {
    return this.rows.get(this.key(table, key));
  }
  seed(count = 2, total = 100) {
    this.put('catalog', {
      ...drop,
      quantityLimit: 10000,
      ...catalogKeys.drop(dropId),
    });
    this.put('catalog', {
      storefrontDropId: dropId,
      updatedAt: timestamp,
      ...catalogKeys.storefront,
    });
    for (let i = 2; i < count + 2; i++) {
      const id = pid(i);
      this.put('catalog', {
        ...product,
        productId: id,
        ...catalogKeys.product(id),
      });
      this.put('catalog', {
        ...relation,
        productId: id,
        ...catalogKeys.dropProduct(dropId, id),
      });
      this.put('catalog', {
        ...inventory,
        productId: id,
        total,
        reserved: 0,
        sold: 0,
        ...catalogKeys.inventory(dropId, id),
      });
    }
    return this;
  }
  keyValue(at = this.now) {
    return `v1.${at}.${Buffer.alloc(32, ++this.keySequence).toString('base64url')}`;
  }
  request(items = [{ productId, quantity: 10 }]): CartRequest {
    return {
      operation: 'create',
      tokenHash,
      key: this.keyValue(),
      dropId,
      items,
    };
  }
  repository(dispatch?: import('../src/cart-expiry').ExpiryDispatch) {
    return new DynamoCartRepository(
      { send: this.send.bind(this) } as unknown as Pick<
        DynamoDBDocumentClient,
        'send'
      >,
      'catalog',
      'commerce',
      'operations',
      {
        now: () => this.now,
        monotonic: () => this.elapsed,
        sleep: async (ms) => {
          this.sleeps.push(ms);
          this.elapsed += ms;
          await new Promise((resolve) => setImmediate(resolve));
        },
        random: () => 0.5,
        id: () => pid(++this.sequence),
      },
      dispatch,
    );
  }
  async send(command: unknown): Promise<any> {
    if (command instanceof GetCommand) {
      assert.equal(command.input.ConsistentRead, true);
      return {
        Item: structuredClone(
          this.row(command.input.TableName!, command.input.Key!),
        ),
      };
    }
    if (command instanceof QueryCommand) {
      const q = command.input;
      assert.equal(q.ConsistentRead, true);
      this.queries.push(q);
      const matches = [...this.rows.values()]
        .filter(
          (row) =>
            row.PK === q.ExpressionAttributeValues![':pk'] &&
            (!(':upper' in q.ExpressionAttributeValues!) ||
              row.SK <= q.ExpressionAttributeValues![':upper']) &&
            (!(':lower' in q.ExpressionAttributeValues!) ||
              row.SK > q.ExpressionAttributeValues![':lower']) &&
            (!q.ExclusiveStartKey || row.SK > q.ExclusiveStartKey.SK),
        )
        .sort((a, b) => a.SK.localeCompare(b.SK));
      const items = matches.slice(
        0,
        Math.min(this.queryPageSize, q.Limit ?? Infinity),
      );
      const last = items.at(-1);
      return {
        Items: structuredClone(items),
        ...(matches.length > items.length
          ? { LastEvaluatedKey: { PK: last!.PK, SK: last!.SK } }
          : {}),
      };
    }
    if (command instanceof PutCommand) {
      this.beforeCursor?.();
      const row = this.row(command.input.TableName!, command.input.Item!);
      if (
        row
          ? row.revision !==
            command.input.ExpressionAttributeValues?.[':revision']
          : command.input.ConditionExpression !== 'attribute_not_exists(PK)'
      )
        throw new Error('Cursor conflict');
      this.put(command.input.TableName!, command.input.Item!);
      return {};
    }
    assert.ok(command instanceof TransactWriteCommand);
    await new Promise((resolve) => setImmediate(resolve));
    const actions = command.input.TransactItems!;
    this.transactions.push(structuredClone(actions));
    await this.before?.(actions);
    const keys = actions.map((a) => {
      const op = a.Put ?? a.Delete ?? a.ConditionCheck!;
      return this.key(
        op.TableName!,
        a.Put?.Item ?? a.Delete?.Key ?? a.ConditionCheck!.Key!,
      );
    });
    assert.equal(new Set(keys).size, keys.length);
    const reasons = actions.map((a) => {
      const op = a.Put ?? a.Delete ?? a.ConditionCheck!;
      const row = this.row(
        op.TableName!,
        a.Put?.Item ?? a.Delete?.Key ?? a.ConditionCheck!.Key!,
      );
      const names = op.ExpressionAttributeNames ?? {},
        values = op.ExpressionAttributeValues ?? {};
      const condition = op.ConditionExpression!;
      const optional = condition.startsWith('attribute_not_exists(PK) OR (');
      const expression = optional
        ? condition.slice('attribute_not_exists(PK) OR ('.length, -1)
        : condition;
      const ok =
        (optional && !row) ||
        expression.split(' AND ').every((term) => {
          if (term === 'attribute_exists(PK)') return !!row;
          if (term === 'attribute_not_exists(PK)') return !row;
          if (term.startsWith('attribute_not_exists(#'))
            return row?.[names[term.slice(21, -1)]] === undefined;
          const match = /^(#[a-zA-Z]+) (=|>|<=) (:[a-zA-Z]+)$/.exec(term);
          assert.ok(match, `Unsupported condition ${term}`);
          const actual = row?.[names[match[1]]],
            expected = values[match[3]];
          return match[2] === '='
            ? isDeepStrictEqual(actual, expected)
            : actual !== undefined &&
                (match[2] === '>' ? actual > expected : actual <= expected);
        });
      return { Code: ok ? 'None' : 'ConditionalCheckFailed' };
    });
    if (this.forcedCode) reasons[0] = { Code: this.forcedCode };
    if (reasons.some((r) => r.Code !== 'None'))
      throw Object.assign(new Error('simulated cancellation'), {
        name: 'TransactionCanceledException',
        CancellationReasons: reasons,
      });
    for (const a of actions) {
      if (a.Put) this.put(a.Put.TableName!, a.Put.Item!);
      if (a.Delete)
        this.rows.delete(this.key(a.Delete.TableName!, a.Delete.Key!));
    }
    this.commits++;
    this.invariants();
    this.after?.();
    return {};
  }
  invariants() {
    for (const [key, row] of this.rows)
      if (key.includes('|INVENTORY#')) {
        assert.ok(
          row.reserved >= 0 &&
            row.sold >= 0 &&
            row.reserved + row.sold <= row.total,
        );
        let held = 0;
        for (const [k, c] of this.rows)
          if (
            k.startsWith('commerce|') &&
            k.includes('|CART#') &&
            ownsReserved(c.status) &&
            c.dropId === row.dropId
          )
            held += c.items
              .filter((i: Row) => i.productId === row.productId)
              .reduce((sum: number, i: Row) => sum + i.quantity, 0);
        assert.equal(
          row.reserved,
          held,
          'aggregate inventory equals active owners',
        );
      }
  }
}
