import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHandler, type ApiEvent } from '../src/api';

const claims = {
  token_use: 'access',
  sub: 'test-subject',
  username: 'test-admin',
};
function event(
  authorizer?: ApiEvent['requestContext']['authorizer'],
): ApiEvent {
  return {
    routeKey: 'GET /admin/me',
    requestContext: {
      requestId: 'admin-test',
      http: { method: 'GET' },
      authorizer,
    },
  };
}
const handler = createHandler(() => {
  throw new Error('Admin identity must not initialize Catalog access');
});

test('admin access claims return only minimal identity without database access', async () => {
  const response = await handler(
    event({
      jwt: {
        claims: {
          ...claims,
          email: 'unused',
          scope: 'unused',
          extra: 'not-public',
        },
      },
    }),
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(response.body), {
    authenticated: true,
    subject: 'test-subject',
    username: 'test-admin',
  });
});
for (const authorizer of [undefined, {}, { jwt: {} }]) {
  test(`missing authorizer claims ${JSON.stringify(authorizer)} deny access`, async () => {
    const response = await handler(event(authorizer));
    assert.equal(response.statusCode, 401);
    assert.deepEqual(JSON.parse(response.body), {
      code: 'UNAUTHORIZED',
      message: 'Authentication required.',
      requestId: 'admin-test',
    });
  });
}
for (const token_use of ['id', 'refresh', 'ACCESS', undefined, null, 1]) {
  test(`admin rejects token_use ${String(token_use)}`, async () => {
    const response = await handler(
      event({ jwt: { claims: { ...claims, token_use } } }),
    );
    assert.equal(response.statusCode, 403);
    assert.deepEqual(JSON.parse(response.body), {
      code: 'FORBIDDEN',
      message: 'An access token is required.',
      requestId: 'admin-test',
    });
  });
}
for (const patch of [
  { sub: undefined },
  { sub: '' },
  { sub: ' ' },
  { sub: 1 },
  { username: undefined },
  { username: '' },
  { username: ['test-admin'] },
]) {
  test(`malformed identity ${JSON.stringify(patch)} fails closed`, async () => {
    const response = await handler(
      event({ jwt: { claims: { ...claims, ...patch } } }),
    );
    assert.equal(response.statusCode, 401);
  });
}
test('caller-provided identity outside the authorizer context is ignored', async () => {
  const untrusted = {
    ...event(),
    headers: { Authorization: 'not-a-token' },
    body: JSON.stringify(claims),
  };
  assert.equal((await handler(untrusted)).statusCode, 401);
});
test('admin route remains read-only and unknown admin routes are not exposed', async () => {
  const write = event({ jwt: { claims } });
  write.requestContext.http.method = 'POST';
  assert.equal((await handler(write)).statusCode, 404);
  assert.equal(
    (
      await handler({
        ...event({ jwt: { claims } }),
        routeKey: 'GET /admin/products',
      })
    ).statusCode,
    404,
  );
});
