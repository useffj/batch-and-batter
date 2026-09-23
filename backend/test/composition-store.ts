// Offline transaction evaluator: validates every condition against the current
// store before applying any action. Deliberately supports only this feature's expressions.
import assert from 'node:assert/strict';
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { DynamoCatalogRepository } from '../src/repository';
import { catalogKeys } from '../src/keys';
import { drop, product } from './fixtures';
export type Item = Record<string, unknown>;
const key = (item: Item) => `${item.PK}/${item.SK}`;
export function compositionStore() {
  const items = new Map<string, Item>();
  const commands: (GetCommand | QueryCommand | TransactWriteCommand)[] = [];
  const put = (item: Item) => items.set(key(item), structuredClone(item));
  const get = (item: Item) => items.get(key(item));
  const remove = (item: Item) => items.delete(key(item));
  put({ ...drop, status: 'DRAFT', ...catalogKeys.drop(drop.dropId) });
  put({ ...product, ...catalogKeys.product(product.productId) });
  const hooks = {
    beforeTransaction: () => {},
    failure: undefined as Error | undefined,
  };
  const client = {
    send: async (command: GetCommand | QueryCommand | TransactWriteCommand) => {
      commands.push(command);
      if (command instanceof GetCommand)
        return { Item: structuredClone(get(command.input.Key!)) };
      if (command instanceof QueryCommand) {
        const values = command.input.ExpressionAttributeValues!;
        return {
          Items: [...items.values()]
            .filter(
              (item) =>
                item.PK === values[':pk'] &&
                String(item.SK).startsWith(values[':prefix']),
            )
            .map((item) => structuredClone(item)),
        };
      }
      assert.ok(command instanceof TransactWriteCommand);
      hooks.beforeTransaction();
      if (hooks.failure) throw hooks.failure;
      const actions = command.input.TransactItems!;
      const targeted = new Set<string>();
      const reasons = actions.map((action) => {
        const operation = action.ConditionCheck ?? action.Put ?? action.Delete!;
        assert.equal(operation.TableName, 'test-catalog');
        const itemKey = 'Item' in operation ? operation.Item! : operation.Key!;
        assert.ok(!targeted.has(key(itemKey)), 'An item is targeted twice');
        targeted.add(key(itemKey));
        const current = get(itemKey);
        let passes: boolean;
        switch (operation.ConditionExpression) {
          case undefined:
            passes = true;
            break;
          case 'attribute_exists(PK)':
            passes = !!current;
            break;
          case 'attribute_not_exists(PK)':
            passes = !current;
            break;
          case 'attribute_exists(PK) AND #status = :draft':
            assert.deepEqual(operation.ExpressionAttributeNames, {
              '#status': 'status',
            });
            assert.deepEqual(operation.ExpressionAttributeValues, {
              ':draft': 'DRAFT',
            });
            passes = !!current && current.status === 'DRAFT';
            break;
          case 'attribute_exists(PK) AND #reserved = :zero AND #sold = :zero':
            assert.deepEqual(operation.ExpressionAttributeNames, {
              '#reserved': 'reserved',
              '#sold': 'sold',
            });
            assert.deepEqual(operation.ExpressionAttributeValues, {
              ':zero': 0,
            });
            passes = !!current && current.reserved === 0 && current.sold === 0;
            break;
          default:
            throw new Error('Unsupported condition');
        }
        return { Code: passes ? 'None' : 'ConditionalCheckFailed' };
      });
      if (reasons.some((reason) => reason.Code !== 'None'))
        throw cancellation(reasons.map((reason) => reason.Code));
      for (const action of actions) {
        if (action.Put) put(action.Put.Item!);
        if (action.Delete) remove(action.Delete.Key!);
      }
      return {};
    },
  } as unknown as Pick<DynamoDBDocumentClient, 'send'>;
  return {
    repository: new DynamoCatalogRepository(client, 'test-catalog'),
    items,
    put,
    get,
    remove,
    hooks,
    commands,
  };
}
export function cancellation(codes?: string[]) {
  return Object.assign(new Error('private SDK detail'), {
    name: 'TransactionCanceledException',
    CancellationReasons: codes?.map((Code) => ({
      Code,
      Message: 'private cancellation detail',
    })),
  });
}
