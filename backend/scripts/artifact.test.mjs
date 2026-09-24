import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyArtifact } from './verify-artifact.mjs';

const root = new URL('../', import.meta.url);
test('artifact contains only compiled runtime code and production dependencies', async () => {
  await verifyArtifact(root);
});
test('rebuilding produces byte-identical bundle and metadata', async () => {
  const bundle = await readFile(new URL('dist/lambda/handler.js', root));
  const metadata = await readFile(new URL('dist/bundle-meta.json', root));
  execFileSync(process.execPath, ['scripts/build.mjs'], {
    cwd: fileURLToPath(root),
  });
  assert.deepEqual(
    await readFile(new URL('dist/lambda/handler.js', root)),
    bundle,
  );
  assert.deepEqual(
    await readFile(new URL('dist/bundle-meta.json', root)),
    metadata,
  );
});
test('artifact guard rejects accidental files, including env, credentials, tests and source', async () => {
  for (const filename of [
    '.env',
    'credentials',
    'seed-dev.js',
    'domain.test.js',
    'development-stack.ts',
  ]) {
    const file = new URL(`dist/lambda/${filename}`, root);
    try {
      await writeFile(file, 'unsafe test fixture');
      await assert.rejects(verifyArtifact(root), /Only compiled handler/);
    } finally {
      await rm(file);
    }
  }
});
test('isolated deployment bundle loads and serves health without SDK, credentials or table config', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'batch-batter-artifact-'));
  try {
    await copyFile(
      new URL('dist/lambda/handler.js', root),
      join(directory, 'handler.js'),
    );
    const output = execFileSync(
      process.execPath,
      [
        '-e',
        `require('./handler.js').handler({ routeKey: 'GET /health', requestContext: { requestId: 'artifact-test', http: { method: 'GET' } } }, { awsRequestId: 'artifact-invocation' }).then(r => console.log(JSON.stringify(r)))`,
      ],
      { cwd: directory, env: { PATH: process.env.PATH }, encoding: 'utf8' },
    );
    const records = output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(records.length, 2);
    assert.deepEqual(records[0], {
      event: 'request.completed',
      requestId: 'artifact-test',
      lambdaRequestId: 'artifact-invocation',
      routeKey: 'GET /health',
      operation: 'health',
      statusCode: 200,
    });
    assert.deepEqual(records[1], {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'ok', service: 'batch-and-batter-api' }),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('artifact guard rejects embedded credential assignments without flagging SDK comparisons', async () => {
  const file = new URL('dist/lambda/handler.js', root);
  const original = await readFile(file, 'utf8');
  try {
    await writeFile(
      file,
      original + '\n// aws_secret_access_key = synthetic-test-value\n',
    );
    await assert.rejects(verifyArtifact(root), /Credential material/);
  } finally {
    await writeFile(file, original);
  }
});
