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
  const names = [
    'handler.js',
    'payment-worker-handler.js',
    'stripe-webhook-handler.js',
    'expiry-worker-handler.js',
    'expiry-reconciler-handler.js',
  ];
  const bundles = await Promise.all(
    names.map((name) => readFile(new URL(`dist/lambda/${name}`, root))),
  );
  const metadata = await readFile(new URL('dist/bundle-meta.json', root));
  execFileSync(process.execPath, ['scripts/build.mjs'], {
    cwd: fileURLToPath(root),
  });
  for (const [i, name] of names.entries())
    assert.deepEqual(
      await readFile(new URL(`dist/lambda/${name}`, root)),
      bundles[i],
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
      await assert.rejects(verifyArtifact(root), /Only the five compiled/);
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

test('dedicated expiry bundles load in isolation without source or installed SDK', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'batch-batter-expiry-artifact-'),
  );
  try {
    for (const name of ['expiry-worker-handler', 'expiry-reconciler-handler']) {
      await copyFile(
        new URL(`dist/lambda/${name}.js`, root),
        join(directory, `${name}.js`),
      );
      const result = execFileSync(
        process.execPath,
        ['-e', `console.log(typeof require('./${name}.js').handler)`],
        { cwd: directory, env: { PATH: process.env.PATH }, encoding: 'utf8' },
      );
      assert.equal(result.trim(), 'function');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const identity of ['configured', 'missing', 'malformed', 'mismatched'])
  test(`deployed app fails closed with ${identity} identity and default admission off`, () => {
    const output = execFileSync(
      process.execPath,
      [
        '-e',
        `
    const http = require('node:http');
    const targets = [];
    const server = http.createServer((req, res) => {
      targets.push(req.headers['x-amz-target']);
      req.resume(); req.on('end', () => { res.setHeader('content-type','application/x-amz-json-1.0'); res.end('{}'); });
    });
    server.listen(0, '127.0.0.1', async () => {
      process.env.AWS_ENDPOINT_URL_DYNAMODB = 'http://127.0.0.1:' + server.address().port;
      try {
        const r = await require('./dist/lambda/handler.js').handler({
          routeKey: 'POST /carts/{cartId}/payment/start',
          requestContext: { requestId: 'artifact-disabled', http: { method: 'POST' } },
          pathParameters: { cartId: '01K5J1' + '100'.padStart(20, '0') },
          headers: { 'x-cart-token': Buffer.alloc(32,17).toString('base64url'),
            'if-match': '"' + 'a'.repeat(64) + '"', 'idempotency-key': 'v1.' + Date.now() + '.' + Buffer.alloc(32,23).toString('base64url') },
          body: JSON.stringify({ confirmationTokenId: 'ctoken_ArtifactFixture', pickupDate: '2026-10-01',
            customer: { name: 'Artifact Fixture', email: 'artifact@example.test', phone: '+15555550123', smsTransactionalConsent: false } })
        });
        console.log(JSON.stringify({ r, targets }));
      } finally { server.close(); }
    });
  `,
      ],
      {
        cwd: fileURLToPath(root),
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          AWS_REGION: 'us-east-2',
          AWS_ACCESS_KEY_ID: 'synthetic',
          AWS_SECRET_ACCESS_KEY: 'synthetic',
          AWS_EC2_METADATA_DISABLED: 'true',
          CATALOG_TABLE_NAME: 'catalog',
          COMMERCE_TABLE_NAME: 'commerce',
          OPERATIONS_TABLE_NAME: 'operations',
          ...(identity === 'missing'
            ? {}
            : {
                STRIPE_ENVIRONMENT: 'dev',
                STRIPE_ACCOUNT_ID: 'acct_artifactActual',
                STRIPE_LEDGER_ACCOUNT_ID:
                  identity === 'mismatched'
                    ? 'acct_other'
                    : 'acct_artifactActual',
                STRIPE_LEDGER_NAMESPACE:
                  identity === 'malformed'
                    ? 'invalid-private-config'
                    : 'dev:acct_artifactHistorical',
              }),
        },
      },
    );
    const result = JSON.parse(output.trim().split('\n').at(-1));
    assert.equal(result.r.statusCode, 503);
    const code =
      identity === 'configured' ? 'PAYMENTS_DISABLED' : 'PAYMENT_UNAVAILABLE';
    assert.equal(JSON.parse(result.r.body).code, code);
    assert.equal(result.r.headers['cache-control'], 'no-store');
    assert.deepEqual(
      result.targets,
      identity === 'configured' ? ['DynamoDB_20120810.GetItem'] : [],
    );
    const log = JSON.parse(output.trim().split('\n')[0]);
    assert.deepEqual(log, { operation: 'beginPayment', statusCode: 503, code });
    assert.doesNotMatch(
      output,
      /acct_artifact|acct_other|invalid-private-config|PROVIDER_INVALID/,
    );
  });
