import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = new URL('../out/', import.meta.url);
// Separate production-only library artifact. No deployable handler until the
// durable lease/store adapter is implemented. Never touches backend/dist/lambda.
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const file of ['package.json', 'package-lock.json', 'src'])
  await cp(new URL(`../${file}`, import.meta.url), new URL(file, out), {
    recursive: true,
  });
execFileSync(
  'npm',
  ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
  { cwd: fileURLToPath(out), stdio: 'inherit' },
);
execFileSync(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    "import sharp from 'sharp'; import {processImage} from './src/process-image.mjs'; if(sharp.versions.sharp!=='0.35.5'||typeof processImage!=='function')process.exit(1); await sharp({create:{width:1,height:1,channels:3,background:'white'}}).png().toBuffer();",
  ],
  { cwd: fileURLToPath(out), stdio: 'inherit' },
);
await writeFile(
  new URL('BUILD.json', out),
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      sharp: '0.35.5',
      deployable: false,
    },
    null,
    2,
  ),
);
console.log(
  `Verified isolated ${process.platform}/${process.arch} library artifact under ${root}out. Linux validation remains required on Linux.`,
);
