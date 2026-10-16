import { build } from 'esbuild';
import { isBuiltin } from 'node:module';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const isolated = process.argv.includes('--isolated-catalog');
if (process.argv.slice(2).some((a) => a !== '--isolated-catalog'))
  throw Error('UNKNOWN_BUILD_OPTION');
const out = new URL(
  isolated ? '../dist/isolated-catalog-release/' : '../dist/api-release/',
  import.meta.url,
);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: [
    isolated ? 'src/isolated-catalog-handler.ts' : 'src/handler.ts',
  ],
  outfile: fileURLToPath(new URL('handler.js', out)),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  packages: 'bundle',
  minify: false,
  sourcemap: false,
  legalComments: 'inline',
  metafile: true,
});
const lock = JSON.parse(
  await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'),
);
for (const input of Object.keys(result.metafile.inputs)) {
  if (
    isolated &&
    /(?:stripe|payment|cart-|refund|guest-order|waitlist|notification|media-|client-s3|client-sqs|client-ssm|client-scheduler)/i.test(
      input,
    )
  )
    throw Error('FORBIDDEN_ISOLATED_INPUT: ' + input);
  if (
    !/^(src|node_modules)\//.test(input) ||
    /(?:^|\/)(?:test|tests|tools|scripts|credentials|\.aws|sharp|@img)(?:\/|$)|(?:payment-worker|stripe-webhook|expiry-worker|expiry-reconciler)-handler|\.test\.|\.env/.test(
      input,
    )
  )
    throw Error('FORBIDDEN_API_INPUT: ' + input);
  if (input.startsWith('node_modules/')) {
    const key = Object.keys(lock.packages)
      .filter((k) => k && input.startsWith(k + '/'))
      .sort((a, b) => b.length - a.length)[0];
    if (!key || lock.packages[key].dev)
      throw Error('UNLOCKED_OR_DEV_API_INPUT');
  }
}
for (const output of Object.values(result.metafile.outputs)) {
  for (const imported of output.imports) {
    if (!imported.external || !isBuiltin(imported.path))
      throw Error('UNBUNDLED_API_DEPENDENCY');
  }
}
const bundle = await readFile(new URL('handler.js', out), 'utf8');
if (
  /(?:AKIA|ASIA)[A-Z0-9]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|aws_(?:secret_access_key|access_key_id)\s*=(?!=|>)\s*\S+/i.test(
    bundle,
  )
)
  throw Error('CREDENTIAL_MATERIAL_IN_API_BUNDLE');
execFileSync(
  process.execPath,
  [
    '-e',
    "if(typeof require('./handler.js').handler!=='function')process.exit(1)",
  ],
  { cwd: fileURLToPath(out) },
);
// Fixed metadata and stored compression avoid timestamps and zlib-version variation.
execFileSync(
  'python3',
  [
    '-c',
    `import zipfile,pathlib
p=pathlib.Path('.')
i=zipfile.ZipInfo('handler.js',(1980,1,1,0,0,0));i.create_system=3;i.external_attr=0o100644<<16
with zipfile.ZipFile('api.zip','w',compression=zipfile.ZIP_STORED) as z:z.writestr(i,p.joinpath('handler.js').read_bytes())`,
  ],
  { cwd: fileURLToPath(out) },
);
const bytes = await readFile(new URL('api.zip', out));
const evidence = {
  handler: 'handler.handler',
  files: ['handler.js'],
  sha256: createHash('sha256').update(bytes).digest('hex'),
  lockSha256: createHash('sha256')
    .update(await readFile(new URL('../package-lock.json', import.meta.url)))
    .digest('hex'),
  node: process.version,
  bytes: bytes.length,
};
await writeFile(
  new URL('evidence.json', out),
  JSON.stringify(evidence, null, 2) + '\n',
);
await writeFile(
  new URL('bundle-meta.json', out),
  JSON.stringify(result.metafile, null, 2) + '\n',
);
console.log(JSON.stringify(evidence));
