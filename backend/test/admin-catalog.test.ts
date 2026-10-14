import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ScanCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { createHandler, type ApiEvent } from '../src/api';
import { DynamoCatalogRepository } from '../src/repository';
import { fakeRepository, product } from './fixtures';
import { catalogKeys } from '../src/keys';
import { productSummary, summaryText } from '../src/admin-catalog';
const claims = {
  token_use: 'access',
  sub: 'synthetic',
  username: 'synthetic',
  'cognito:groups': ['batch-and-batter-admins'],
};
function event(route = 'GET /admin/products'): ApiEvent {
  return {
    routeKey: route,
    headers: { 'idempotency-key': '11111111-1111-4111-8111-111111111111' },
    pathParameters: { productId: product.productId },
    requestContext: {
      requestId: 'catalog-test',
      http: { method: route.split(' ')[0] },
      authorizer: { jwt: { claims } },
    },
  };
}
for (const route of [
  'GET /admin/products',
  'GET /admin/products/{productId}',
]) {
  test(
    route + ' rejects missing/nonadmin authorization before repository access',
    async () => {
      for (const c of [
        undefined,
        { ...claims, 'cognito:groups': ['customers'] },
        { ...claims, token_use: 'id' },
      ]) {
        const e = event(route);
        e.requestContext.authorizer = c ? { jwt: { claims: c } } : undefined;
        const r = await createHandler(() => {
          throw new Error('Must not access');
        })(e);
        assert.equal(r.statusCode, c ? 403 : 401);
      }
    },
  );
}
test('catalog includes inactive products and projects only the Product DTO', async () => {
  const r = await createHandler(() =>
    fakeRepository({
      listProducts: async () => ({ products: [{ ...product, active: false }] }),
    }),
  )(event());
  assert.equal(r.statusCode, 200);
  const b = JSON.parse(r.body);
  assert.equal(b.products[0].active, false);
  assert.equal(b.nextCursor, null);
  assert.equal(b.products[0].priceCents, undefined);
  assert.equal(b.products[0].PK, undefined);
});
test('filtered empty page retains continuation and cursor reaches repository', async () => {
  const cursor = { PK: 'DROP#synthetic', SK: 'META' };
  const h = createHandler(() =>
    fakeRepository({
      listProducts: async (key) => {
        assert.deepEqual(key, cursor);
        return { products: [], cursor };
      },
    }),
  );
  const e = event();
  e.queryStringParameters = {
    cursor: Buffer.from(JSON.stringify(cursor)).toString('base64url'),
  };
  const r = await h(e);
  assert.equal(JSON.parse(r.body).nextCursor, e.queryStringParameters.cursor);
});
test('invalid cursors rejected before data access', async () => {
  for (const cursor of [
    '!',
    Buffer.from('{}').toString('base64url'),
    'a'.repeat(8193),
  ]) {
    const e = event();
    e.queryStringParameters = { cursor };
    const r = await createHandler(() => {
      throw new Error('Must not access');
    })(e);
    assert.equal(r.statusCode, 400);
  }
});
test('missing product and repository outage have safe errors', async () => {
  const r = await createHandler(() =>
    fakeRepository({ getProduct: async () => undefined }),
  )(event('GET /admin/products/{productId}'));
  assert.equal(r.statusCode, 404);
  const outage = await createHandler(() =>
    fakeRepository({
      listProducts: async () => {
        throw new Error('private diagnostic');
      },
    }),
  )(event());
  assert.equal(outage.statusCode, 500);
  assert.ok(!outage.body.includes('private diagnostic'));
});
test('catalog scan is one bounded strongly consistent request; no write or recursive scan', async () => {
  let calls = 0;
  const cursor = { PK: 'DROP#synthetic', SK: 'META' };
  const client = {
    send: async (c: ScanCommand) => {
      calls++;
      assert.ok(c instanceof ScanCommand);
      assert.equal(c.input.Limit, 100);
      assert.equal(c.input.ConsistentRead, true);
      assert.deepEqual(c.input.ExclusiveStartKey, cursor);
      assert.equal(
        c.input.FilterExpression,
        'begins_with(#pk, :product) AND #sk = :meta',
      );
      return {
        Items: [{ ...product, ...catalogKeys.product(product.productId) }],
        LastEvaluatedKey: cursor,
      };
    },
  } as unknown as Pick<DynamoDBDocumentClient, 'send'>;
  const r = await new DynamoCatalogRepository(
    client,
    'synthetic-catalog',
  ).listProducts(cursor);
  assert.equal(calls, 1);
  assert.deepEqual(r, { products: [product], cursor });
});
test('stale browser revision never overwrites a product', async () => {
  const e = event('PUT /admin/products/{productId}');
  e.headers = { 'if-match': '2000-01-01T00:00:00.000Z' };
  const { productId: _id, createdAt: _c, updatedAt: _u, ...fields } = product;
  e.body = JSON.stringify(fields);
  const r = await createHandler(() =>
    fakeRepository({
      replaceProduct: async () => {
        assert.fail('No write');
      },
    }),
  )(e);
  assert.equal(r.statusCode, 409);
});
test('matching revision preserves ID and audit identity, writes only product', async () => {
  const e = event('PUT /admin/products/{productId}');
  e.headers = { 'if-match': product.updatedAt };
  const { productId: _id, createdAt: _c, updatedAt: _u, ...fields } = product;
  e.body = JSON.stringify({
    ...fields,
    active: !product.active,
    ingredients: ['Butter'],
    allergens: ['Milk'],
  });
  let writes = 0;
  const r = await createHandler(
    () =>
      new Proxy(
        fakeRepository({
          replaceProduct: async (next, previous) => {
            writes++;
            assert.equal(next.productId, product.productId);
            assert.equal(next.createdAt, product.createdAt);
            assert.deepEqual(previous, product);
            assert.deepEqual(next.ingredients, ['Butter']);
          },
        }),
        {
          get(target, key) {
            if (!['getProduct', 'replaceProduct'].includes(String(key)))
              throw new Error('Unrelated repository operation');
            return Reflect.get(target, key);
          },
        },
      ),
  )(e);
  assert.equal(r.statusCode, 200);
  assert.equal(writes, 1);
});

test('large catalog is compact, byte bounded and retains every ID and cursor', async () => {
  const products = Array.from({ length: 100 }, (_, i) => ({
    ...product,
    productId: '01K' + String(i).padStart(23, '0'),
    name: '🍪'.repeat(300),
    description: '\u0000東京'.repeat(5000),
    ingredients: ['x'.repeat(2000)],
  }));
  const cursor = { PK: 'P'.repeat(2048), SK: 'S'.repeat(1024) };
  const r = await createHandler(() =>
    fakeRepository({ listProducts: async () => ({ products, cursor }) }),
  )(event());
  assert.equal(r.statusCode, 200);
  assert.ok(Buffer.byteLength(r.body) < 262144 - 128); // reserve proxy loadedAt envelope
  const body = JSON.parse(r.body);
  assert.deepEqual(
    body.products.map((p: { productId: string }) => p.productId),
    products.map((p) => p.productId),
  );
  assert.deepEqual(
    JSON.parse(Buffer.from(body.nextCursor, 'base64url').toString()),
    cursor,
  );
  assert.ok(
    body.products.every(
      (p: { descriptionTruncated: boolean }) => p.descriptionTruncated,
    ),
  );
  assert.equal(body.products[0].ingredients, undefined);
  assert.equal(products[0].description, '\u0000東京'.repeat(5000));
});
test('summary boundaries include quotes, escapes and Unicode without splitting code points', () => {
  assert.deepEqual(summaryText('a'.repeat(510), 512), {
    text: 'a'.repeat(510),
    truncated: false,
  });
  assert.deepEqual(summaryText('a'.repeat(511), 512), {
    text: 'a'.repeat(510),
    truncated: true,
  });
  assert.deepEqual(summaryText('🍪🍪', 6), { text: '🍪', truncated: true });
  assert.deepEqual(summaryText('\u0000\u0000', 8), {
    text: '\u0000',
    truncated: true,
  });
  assert.equal(productSummary(product).nameTruncated, false);
});
test('large full product details remain unchanged', async () => {
  const full = {
    ...product,
    description: '\u0000'.repeat(350000),
    ingredients: ['東京'],
    allergens: ['Milk'],
  };
  const r = await createHandler(() =>
    fakeRepository({ getProduct: async () => full }),
  )(event('GET /admin/products/{productId}'));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(JSON.parse(r.body).product, full);
});
test('mock persistence survives new catalog and detail requests after creation and edit', async () => {
  let saved: typeof product | undefined;
  const repository = fakeRepository({
    createProduct: async (p) => {
      saved = p;
    },
    getProduct: async () => saved,
    replaceProduct: async (p) => {
      saved = p;
    },
    listProducts: async () => ({ products: saved ? [saved] : [] }),
  });
  const h = createHandler(() => repository);
  const { productId: _id, createdAt: _c, updatedAt: _u, ...fields } = product;
  const create = event('POST /admin/products');
  create.body = JSON.stringify(fields);
  assert.equal((await h(create)).statusCode, 201);
  const list = JSON.parse((await h(event())).body);
  assert.deepEqual(list.products, [productSummary(saved!)]);
  const edit = event('PUT /admin/products/{productId}');
  edit.pathParameters = { productId: saved!.productId };
  edit.headers = { 'if-match': saved!.updatedAt };
  edit.body = JSON.stringify({ ...fields, description: 'Updated' });
  assert.equal((await h(edit)).statusCode, 200);
  const detail = event('GET /admin/products/{productId}');
  detail.pathParameters = edit.pathParameters;
  assert.equal(
    JSON.parse((await h(detail)).body).product.description,
    'Updated',
  );
  assert.equal(
    JSON.parse((await h(event())).body).products[0].description,
    'Updated',
  );
});
