import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
test('API ZIP is reproducible locally, single-entry, self-contained and invokes synthetic health', async () => {
  const build = () =>
    execFileSync(process.execPath, ['scripts/build-api.mjs'], { cwd: root });
  build();
  const first = readFileSync(
    new URL('../dist/api-release/api.zip', import.meta.url),
  );
  build();
  assert.deepEqual(
    readFileSync(new URL('../dist/api-release/api.zip', import.meta.url)),
    first,
  );
  execFileSync(
    'python3',
    [
      '-c',
      "import zipfile; z=zipfile.ZipFile('dist/api-release/api.zip'); assert z.namelist()==['handler.js']; assert z.testzip() is None",
    ],
    { cwd: root },
  );
  const { handler } = await import('../dist/api-release/handler.js');
  const response = await handler({
    routeKey: 'GET /health',
    requestContext: { http: { method: 'GET', path: '/health' } },
    rawPath: '/health',
    headers: {},
  });
  assert.equal(response.statusCode, 200);
});

test('isolated catalog ZIP is deterministic and excludes financial and dispatch modules', () => {
  const build = () =>
    execFileSync(
      process.execPath,
      ['scripts/build-api.mjs', '--isolated-catalog'],
      { cwd: root },
    );
  build();
  const path = new URL(
    '../dist/isolated-catalog-release/api.zip',
    import.meta.url,
  );
  const first = readFileSync(path);
  build();
  assert.deepEqual(readFileSync(path), first);
  const meta = JSON.parse(
    readFileSync(
      new URL(
        '../dist/isolated-catalog-release/bundle-meta.json',
        import.meta.url,
      ),
    ),
  );
  assert.ok(
    Object.keys(meta.inputs).some((p) =>
      p.endsWith('isolated-catalog-handler.ts'),
    ),
  );
  assert.ok(
    !Object.keys(meta.inputs).some((p) =>
      /stripe|payment|cart-|refund|media-|notification|waitlist/.test(p),
    ),
  );
});

test('media Catalog candidate is separate from the accepted Catalog and contains no Sharp or financial runtime', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  execFileSync(
    process.execPath,
    ['scripts/build-api.mjs', '--isolated-media'],
    { cwd: root },
  );
  const path = new URL(
    '../dist/isolated-media-release/api.zip',
    import.meta.url,
  );
  const first = readFileSync(path);
  execFileSync(
    process.execPath,
    ['scripts/build-api.mjs', '--isolated-media'],
    { cwd: root },
  );
  assert.deepEqual(readFileSync(path), first);
  const meta = JSON.parse(
    readFileSync(
      new URL(
        '../dist/isolated-media-release/bundle-meta.json',
        import.meta.url,
      ),
    ),
  );
  assert.ok(
    Object.keys(meta.inputs).some((p) =>
      p.endsWith('isolated-media-handler.ts'),
    ),
  );
  assert.ok(
    !Object.keys(meta.inputs).some((p) =>
      /sharp|stripe|payment-|refund|notification|waitlist|cart-repository/.test(
        p,
      ),
    ),
  );
});
