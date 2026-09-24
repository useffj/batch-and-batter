import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHandler, type ApiEvent } from '../src/api';
import { ADMIN_GROUP, AdminError } from '../src/admin-auth';
import { CatalogWriteError } from '../src/repository';
import { dropId, fakeRepository } from './fixtures';

const secrets = [
  'private-token',
  'private-password',
  'private-cookie',
  'private-email',
  'private-phone',
  'private-payment',
  'private-api-key',
];
function event(routeKey: string) {
  return {
    routeKey,
    headers: {
      Authorization: `Bearer ${secrets[0]}`,
      cookie: secrets[2],
      'x-api-key': secrets[6],
    },
    body: '{}',
    rawPath: `/private/${secrets[3]}`,
    rawQueryString: `password=${secrets[1]}`,
    pathParameters: { dropId },
    requestContext: {
      requestId: 'gateway-request',
      http: { method: routeKey.split(' ')[0] },
      authorizer: {
        jwt: {
          claims: {
            token_use: 'access',
            sub: secrets[3],
            username: secrets[4],
            'cognito:groups': [ADMIN_GROUP],
            payment: secrets[5],
          },
        },
      },
    },
  } satisfies ApiEvent & {
    headers: unknown;
    rawPath: string;
    rawQueryString: string;
  };
}

for (const scenario of [
  { route: 'GET /drops/current', operation: 'getCurrentDrop', status: 200 },
  { route: 'GET /admin/me', operation: 'getAdminIdentity', status: 200 },
  {
    route: 'POST /admin/drops/{dropId}/publish',
    operation: 'publishDrop',
    status: 409,
    code: 'STOREFRONT_OCCUPIED',
  },
  {
    route: 'POST /admin/drops/{dropId}/publish',
    operation: 'publishDrop',
    status: 500,
    code: 'INTERNAL_ERROR',
  },
  {
    route: 'GET /drops/current',
    operation: 'getCurrentDrop',
    status: 500,
    code: 'INTERNAL_ERROR',
  },
] as const) {
  test(`${scenario.route} logs one safe correlated completion for ${scenario.status}`, async (t) => {
    const info = t.mock.method(console, 'info', () => {});
    const errors = t.mock.method(console, 'error', () => {});
    const repository = fakeRepository({
      publishDraft: async () => {
        if (scenario.status === 409)
          throw new CatalogWriteError('STOREFRONT_OCCUPIED');
        throw new Error(secrets.join(' '));
      },
      ...(scenario.status === 500
        ? {
            getStorefrontDrop: async () => {
              throw new Error(secrets.join(' '));
            },
          }
        : {}),
    });
    const request = event(scenario.route);
    // Public and identity routes ignore bodies; deliberately supply sensitive content.
    if (scenario.route.startsWith('GET'))
      request.body = JSON.stringify({
        password: secrets[1],
        token: secrets[0],
      });
    const response = await createHandler(() => repository)(request, {
      awsRequestId: 'lambda-request',
    });
    assert.equal(response.statusCode, scenario.status);
    const calls = [...info.mock.calls, ...errors.mock.calls];
    assert.equal(calls.length, 1);
    assert.equal(errors.mock.callCount(), scenario.status === 500 ? 1 : 0);
    assert.equal(calls[0].arguments.length, 1);
    const text = calls[0].arguments[0];
    assert.deepEqual(JSON.parse(text), {
      event: 'request.completed',
      requestId: 'gateway-request',
      lambdaRequestId: 'lambda-request',
      routeKey: scenario.route,
      operation: scenario.operation,
      statusCode: scenario.status,
      ...('code' in scenario ? { code: scenario.code } : {}),
    });
    for (const secret of [
      ...secrets,
      'Authorization',
      'headers',
      'claims',
      'body',
      'rawQueryString',
      'pathParameters',
    ]) {
      assert.equal(
        text.includes(secret),
        false,
        `Unexpected logged data: ${secret}`,
      );
    }
    if ('code' in scenario)
      assert.equal(
        JSON.parse(response.body).requestId,
        JSON.parse(text).requestId,
      );
  });
}

test('all registered routes have stable operation names, including authentication rejection', async (t) => {
  const logs = t.mock.method(console, 'info', () => {});
  const routes = [
    ['GET /health', 'health'],
    ['GET /drops/current', 'getCurrentDrop'],
    ['GET /drops/{dropId}', 'getDrop'],
    ['GET /admin/me', 'getAdminIdentity'],
    ['POST /admin/products', 'createProduct'],
    ['PUT /admin/products/{productId}', 'replaceProduct'],
    ['POST /admin/drops', 'createDraftDrop'],
    ['PUT /admin/drops/{dropId}', 'replaceDraftDrop'],
    ['GET /admin/drops/{dropId}/composition', 'getDropComposition'],
    ['POST /admin/drops/{dropId}/products', 'attachDropProduct'],
    ['PUT /admin/drops/{dropId}/products/{productId}', 'replaceDropProduct'],
    ['DELETE /admin/drops/{dropId}/products/{productId}', 'removeDropProduct'],
    ['PUT /admin/drops/{dropId}/pickups/{date}', 'putPickup'],
    ['DELETE /admin/drops/{dropId}/pickups/{date}', 'removePickup'],
    ['POST /admin/drops/{dropId}/publish', 'publishDrop'],
    ['POST /admin/drops/{dropId}/open', 'openDrop'],
  ];
  for (const [route, operation] of routes) {
    const request: ApiEvent = event(route);
    delete request.requestContext.authorizer;
    const response = await createHandler(() => fakeRepository())(request);
    assert.deepEqual(JSON.parse(logs.mock.calls.at(-1)!.arguments[0]), {
      event: 'request.completed',
      requestId: 'gateway-request',
      routeKey: route,
      operation,
      statusCode: route.includes('/admin/') ? 401 : 200,
      ...(route.includes('/admin/') ? { code: 'UNAUTHORIZED' } : {}),
    });
    assert.equal(response.statusCode, route.includes('/admin/') ? 401 : 200);
  }
  assert.equal(logs.mock.callCount(), routes.length);
});

test('unknown routes, malformed IDs and unexpected error codes cannot introduce arbitrary log fields', async (t) => {
  const logs = t.mock.method(console, 'info', () => {});
  const request = event(`GET /${secrets[0]}`);
  request.requestContext.requestId = 'bad\nrequest';
  await createHandler(() => fakeRepository())(request, {
    awsRequestId: 'bad\ncontext',
  });
  assert.deepEqual(JSON.parse(logs.mock.calls[0].arguments[0]), {
    event: 'request.completed',
    routeKey: 'unmatched',
    operation: 'unmatched',
    statusCode: 404,
    code: 'NOT_FOUND',
  });
  await createHandler(() =>
    fakeRepository({
      publishDraft: async () => {
        throw new AdminError(409, secrets[0], secrets[1]);
      },
    }),
  )(event('POST /admin/drops/{dropId}/publish'));
  assert.equal('code' in JSON.parse(logs.mock.calls[1].arguments[0]), false);
});

test('a failed logging transport preserves the completed response and does not retry publication', async (t) => {
  t.mock.method(console, 'info', () => {
    throw new Error('log transport failed');
  });
  let publications = 0;
  const repository = fakeRepository({
    publishDraft: async () => {
      publications++;
      return {
        drop: {
          ...(await fakeRepository().getDrop(dropId))!,
          status: 'SCHEDULED',
        },
        storefront: {
          storefrontDropId: dropId,
          updatedAt: '2026-09-24T00:00:00.000Z',
        },
      };
    },
  });
  const response = await createHandler(() => repository)(
    event('POST /admin/drops/{dropId}/publish'),
  );
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).storefront.storefrontDropId, dropId);
  assert.equal(publications, 1);
});
