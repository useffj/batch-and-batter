import { build } from 'esbuild';
import { verifyArtifact } from './verify-artifact.mjs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// Only this generated directory is packaged by CDK. Never copy a source tree.
await rm(new URL('../dist/lambda/', import.meta.url), {
  recursive: true,
  force: true,
});
await mkdir(new URL('../dist/lambda/', import.meta.url), { recursive: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: [
    'src/handler.ts',
    'src/payment-worker-handler.ts',
    'src/stripe-webhook-handler.ts',
    'src/expiry-worker-handler.ts',
    'src/expiry-reconciler-handler.ts',
  ],
  outdir: 'dist/lambda',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  packages: 'bundle',
  minify: false,
  sourcemap: false,
  legalComments: 'inline',
  metafile: true,
  write: true,
});
// Build evidence stays outside the deployed directory; no timestamps or host paths.
await writeFile(
  new URL('../dist/bundle-meta.json', import.meta.url),
  JSON.stringify(result.metafile, null, 2) + '\n',
);

await verifyArtifact(new URL('../', import.meta.url));
