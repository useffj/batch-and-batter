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
  assert.deepEqual(Object.keys(manifest).sort(), ['/_not-found/page', '/page']);
  const routes = JSON.parse(
    await readFile(new URL('web/.next/routes-manifest.json', root), 'utf8'),
  );
  assert.equal(routes.dynamicRoutes.length, 0);
  assert.doesNotMatch(
    JSON.stringify(routes),
    /stripe|acceptance|\/cart|\/start/,
  );
});
test('actual browser/server bundles and Lambda inputs contain no harness or Stripe browser SDK', async () => {
  for (const path of ['web/.next/static/', 'web/.next/server/']) {
    for (const file of await walk(new URL(path, root))) {
      if (!/\.(js|json|html)$/.test(file.pathname)) continue;
      const content = await readFile(file, 'utf8');
      assert.doesNotMatch(
        content,
        /stripe-acceptance|STRIPE_ACCEPTANCE_|DEV \/ STRIPE SANDBOX ACCEPTANCE ONLY|js\.stripe\.com\/dahlia|127\.0\.0\.1:4242/,
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
