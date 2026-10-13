import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHandler, type ApiEvent } from '../src/api';
import { ADMIN_GROUP } from '../src/admin-auth';
import type { CatalogRepository } from '../src/repository';
import { dropStatusSchema } from '../src/domain';
import { drop, dropId } from './fixtures';

const route = 'GET /admin/storefront/assignment';
const claims = {
  token_use: 'access',
  sub: 'synthetic-subject',
  username: 'synthetic-admin',
  'cognito:groups': [ADMIN_GROUP],
};
function event(
  identity: Record<string, unknown> | undefined = claims,
): ApiEvent {
  return {
    routeKey: route,
    requestContext: {
      requestId: 'assignment-test',
      http: { method: 'GET' },
      authorizer: { jwt: { claims: identity } },
    },
  };
}
// Every access other than the two approved keyed reads fails, including writes,
// public composition reads, and any future scan capability.
function repository(
  reads: Pick<CatalogRepository, 'getStorefrontDropId' | 'getDrop'>,
) {
  return new Proxy(reads, {
    get(target, key) {
      assert.ok(
        key === 'getStorefrontDropId' || key === 'getDrop',
        `Unexpected repository access: ${String(key)}`,
      );
      return target[key];
    },
  }) as CatalogRepository;
}
for (const status of dropStatusSchema.options) {
  test(`assigned ${status} Drop is discoverable using only keyed reads`, async () => {
    const calls: string[] = [];
    const response = await createHandler(() =>
      repository({
        getStorefrontDropId: async () => {
          calls.push('assignment');
          return dropId;
        },
        getDrop: async (id) => {
          calls.push(id);
          return { ...drop, status };
        },
      }),
    )(event());
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), { dropId });
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(calls, ['assignment', dropId]);
  });
}
test('unassigned is explicit and does not read a Drop', async () => {
  const response = await createHandler(() =>
    repository({
      getStorefrontDropId: async () => undefined,
      getDrop: async () => {
        assert.fail('Unexpected Drop read');
      },
    }),
  )(event());
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { dropId: null });
});
test('broken assignment is a sanitized conflict, never unassigned', async () => {
  const response = await createHandler(() =>
    repository({
      getStorefrontDropId: async () => dropId,
      getDrop: async () => undefined,
    }),
  )(event());
  assert.equal(response.statusCode, 409);
  assert.deepEqual(JSON.parse(response.body), {
    code: 'BROKEN_STOREFRONT_ASSIGNMENT',
    message: 'The assigned Drop could not be found.',
    requestId: 'assignment-test',
  });
  assert.equal(response.headers['cache-control'], 'no-store');
});
for (const failingRead of ['assignment', 'drop']) {
  test(`${failingRead} read failure is sanitized, never successful empty data`, async () => {
    const fail = () => {
      throw new Error('sensitive-internal-detail');
    };
    const response = await createHandler(() =>
      repository({
        getStorefrontDropId: async () =>
          failingRead === 'assignment' ? fail() : dropId,
        getDrop: async () => fail(),
      }),
    )(event());
    assert.equal(response.statusCode, 500);
    assert.deepEqual(JSON.parse(response.body), {
      code: 'INTERNAL_ERROR',
      message: 'Unable to complete the request.',
      requestId: 'assignment-test',
    });
  });
}
for (const [identity, status] of [
  [null, 401],
  [{ ...claims, sub: '' }, 401],
  [{ ...claims, token_use: 'id' }, 403],
  [{ ...claims, 'cognito:groups': [] }, 403],
  [{ ...claims, 'cognito:groups': [`prefix-${ADMIN_GROUP}`] }, 403],
] as const) {
  test(`assignment rejects invalid identity ${JSON.stringify(identity)}`, async () => {
    const request = event(identity ?? {});
    if (!identity) delete request.requestContext.authorizer;
    request.headers = { Authorization: 'synthetic-untrusted-token' };
    request.body = JSON.stringify(claims);
    const response = await createHandler(() => {
      assert.fail('Unauthorized repository access');
    })(request);
    assert.equal(response.statusCode, status);
    assert.ok(!response.body.includes('synthetic-untrusted-token'));
  });
}
test('assignment has no mutation methods', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const request = event();
    request.routeKey = `${method} /admin/storefront/assignment`;
    request.requestContext.http.method = method;
    const response = await createHandler(() => {
      assert.fail('Unexpected repository access');
    })(request);
    assert.equal(response.statusCode, 404);
  }
});
// Expiry is enforced by API Gateway before Lambda invocation. CDK tests assert
// this route uses the existing JWT authorizer; synthetic Lambda claims cannot
// establish that managed AWS expiry validation works. No custom JWT model here.
