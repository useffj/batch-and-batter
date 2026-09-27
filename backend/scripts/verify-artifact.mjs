import assert from 'node:assert/strict';
import { isBuiltin } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';

export async function verifyArtifact(root) {
  const files = await readdir(new URL('dist/lambda/', root));
  assert.deepEqual(
    files,
    ['expiry-reconciler-handler.js', 'expiry-worker-handler.js', 'handler.js'],
    'Only the three compiled Lambda entry points may be deployed',
  );
  const metadata = JSON.parse(
    await readFile(new URL('dist/bundle-meta.json', root), 'utf8'),
  );
  const lock = JSON.parse(
    await readFile(new URL('package-lock.json', root), 'utf8'),
  );
  const inputs = Object.keys(metadata.inputs);
  const forbidden =
    /(^|\/)(tools|test|tests|scripts|infra|credentials|\.aws)(\/|$)|(^|\/)\.env(?:\.|$)|\.(?:test|spec)\.|credential-providers\//;
  for (const input of inputs) {
    assert.ok(!forbidden.test(input), `Forbidden bundle input: ${input}`);
    assert.ok(
      input.startsWith('src/') || input.startsWith('node_modules/'),
      `Unexpected input: ${input}`,
    );
    if (input.startsWith('node_modules/')) {
      const packagePath = Object.keys(lock.packages)
        .filter((name) => name && input.startsWith(name + '/'))
        .sort((a, b) => b.length - a.length)[0];
      assert.ok(
        packagePath && !lock.packages[packagePath].dev,
        `Development dependency in artifact: ${input}`,
      );
    }
  }
  for (const packageName of [
    '@aws-sdk/client-dynamodb',
    '@aws-sdk/client-scheduler',
    '@aws-sdk/client-sqs',
    '@aws-sdk/lib-dynamodb',
    'zod',
  ]) {
    assert.ok(
      inputs.some((input) => input.startsWith(`node_modules/${packageName}/`)),
      `${packageName} must be bundled`,
    );
  }
  for (const output of Object.values(metadata.outputs)) {
    for (const imported of output.imports)
      assert.ok(
        imported.external && isBuiltin(imported.path),
        `Unbundled runtime dependency: ${imported.path}`,
      );
  }
  for (const file of files) {
    const bundle = await readFile(new URL(`dist/lambda/${file}`, root), 'utf8');
    assert.ok(
      !/(?:AKIA|ASIA)[A-Z0-9]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|aws_(?:secret_access_key|access_key_id)\s*=(?!=|>)\s*\S+/i.test(
        bundle,
      ),
      'Credential material in bundle',
    );
  }
}
