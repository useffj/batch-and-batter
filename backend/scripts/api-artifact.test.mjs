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
