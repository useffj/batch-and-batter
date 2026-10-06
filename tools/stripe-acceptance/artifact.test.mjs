import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
const root = new URL('../../', import.meta.url);
async function walk(url) {
  const files = [];
  for (const item of await readdir(url, { withFileTypes: true })) {
    const next = new URL(item.name + (item.isDirectory() ? '/' : ''), url);
    if (item.isDirectory()) files.push(...(await walk(next)));
    else files.push(next);
  }
  return files;
}
test('actual Next production route manifest excludes acceptance endpoints', async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL('web/.next/server/app-paths-manifest.json', root),
      'utf8',
    ),
  );
  assert.deepEqual(Object.keys(manifest).sort(), [
    '/_not-found/page',
    '/api/cart/route',
    '/api/cart/session/route',
    '/api/checkout/continue/route',
    '/api/checkout/route',
    '/api/checkout/start/route',
    '/checkout/page',
    '/page',
  ]);
  const routes = JSON.parse(
    await readFile(new URL('web/.next/routes-manifest.json', root), 'utf8'),
  );
  assert.equal(routes.dynamicRoutes.length, 0);
  assert.doesNotMatch(
    JSON.stringify(routes),
    /stripe-acceptance|acceptance|\/setup|\/preview/,
  );
});
test('actual browser/server bundles and Lambda inputs contain no harness or secret payment configuration', async () => {
  for (const path of ['web/.next/static/', 'web/.next/server/']) {
    for (const file of await walk(new URL(path, root))) {
      if (!/\.(js|json|html)$/.test(file.pathname)) continue;
      const content = await readFile(file, 'utf8');
      if (path === 'web/.next/static/')
        assert.doesNotMatch(
          content,
          /X-Cart-Token|__Host-bb-cart|bb-cart-local/,
          file.pathname,
        );
      assert.doesNotMatch(
        content,
        /CHECKOUT_MOCK_BROWSER_ONLY|__checkoutMock|__checkout_mock_action|stripe-acceptance|STRIPE_ACCEPTANCE_|DEV \/ STRIPE SANDBOX ACCEPTANCE ONLY|127\.0\.0\.1:4242/,
        file.pathname,
      );
      assert.doesNotMatch(
        content,
        /STRIPE_(?:WORKER|READ|SECRET|RESTRICTED)_KEY|STRIPE_WEBHOOK_SECRET|pk_test_mock|pi_[A-Za-z0-9]+_secret_[A-Za-z0-9]{8,}|ctoken_[A-Za-z0-9]{8,}|(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{16,}|acceptanceCapability/,
        file.pathname,
      );
    }
  }
  const meta = await readFile(
    new URL('backend/dist/bundle-meta.json', root),
    'utf8',
  );
  assert.doesNotMatch(meta, /stripe-acceptance/);
});
