import { mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const root = fileURLToPath(new URL('../', import.meta.url));
const linux = process.argv.includes('--linux');
const out = new URL(linux ? '../out/linux/' : '../out/host/', import.meta.url);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const bundle = await build({
  absWorkingDir: root,
  entryPoints: ['src/handler.ts'],
  outfile: fileURLToPath(new URL('index.cjs', out)),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external: ['sharp'],
  metafile: true,
  sourcemap: false,
});
if (
  Object.keys(bundle.metafile.inputs).some((p) =>
    /stripe|payment-|webhook|cart-repository|expiry-worker/.test(p),
  )
)
  throw new Error('Unrelated runtime in processor');
// Derive Sharp-only runtime lock from the reviewed lock, retaining integrity.
// SDK/Zod dependencies are bundled, with no installed development dependencies.
const lock = JSON.parse(
  await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'),
);
const packages = {};
function include(name) {
  const key = 'node_modules/' + name;
  if (packages[key]) return;
  const p = lock.packages[key];
  if (!p) throw new Error('Missing locked runtime package: ' + name);
  packages[key] = p;
  for (const dep of Object.keys({
    ...p.dependencies,
    ...p.optionalDependencies,
  }))
    include(dep);
}
include('sharp');
const pkg = {
  name: 'batch-and-batter-media-runtime',
  version: '0.1.0',
  private: true,
  dependencies: { sharp: '0.35.5' },
};
await writeFile(new URL('package.json', out), JSON.stringify(pkg, null, 2));
await writeFile(
  new URL('package-lock.json', out),
  JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      lockfileVersion: 3,
      requires: true,
      packages: { '': pkg, ...packages },
    },
    null,
    2,
  ),
);
execFileSync(
  'npm',
  [
    'ci',
    '--omit=dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    ...(linux ? ['--os=linux', '--cpu=x64', '--libc=glibc'] : []),
  ],
  { cwd: fileURLToPath(out), stdio: 'inherit' },
);
const native = await readdir(new URL('node_modules/@img/', out));
if (
  linux &&
  (!native.includes('sharp-linux-x64') ||
    !native.includes('sharp-libvips-linux-x64') ||
    native.some((n) => n.includes('darwin')))
)
  throw new Error('Invalid target natives');
if (!linux || (process.platform === 'linux' && process.arch === 'x64')) {
  execFileSync(
    process.execPath,
    [
      '-e',
      "const {handler}=require('./index.cjs'); const sharp=require('sharp'); if(typeof handler!=='function'||sharp.versions.sharp!=='0.35.5')throw Error(); sharp({create:{width:480,height:480,channels:3,background:'white'}}).webp().toBuffer().catch(()=>process.exit(1));",
    ],
    { cwd: fileURLToPath(out), stdio: 'inherit' },
  );
}
await writeFile(
  new URL('../out/build-evidence.json', import.meta.url),
  JSON.stringify(
    {
      target: linux ? 'linux/x64' : process.platform + '/' + process.arch,
      executionVerified:
        !linux || (process.platform === 'linux' && process.arch === 'x64'),
      inputs: Object.keys(bundle.metafile.inputs),
      native,
    },
    null,
    2,
  ),
);
console.log('Artifact directory: ' + fileURLToPath(out));
await rm(
  new URL(
    linux ? '../out/processor-linux-x64.zip' : '../out/processor-host.zip',
    import.meta.url,
  ),
  { force: true },
);
execFileSync(
  'python3',
  [
    '-c',
    `import pathlib,zipfile
root=pathlib.Path('.')
out=pathlib.Path('../${linux ? 'processor-linux-x64.zip' : 'processor-host.zip'}')
with zipfile.ZipFile(out,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
 for p in sorted(root.rglob('*')):
  if p.is_file():
   info=zipfile.ZipInfo(p.as_posix(),(1980,1,1,0,0,0));info.create_system=3;info.external_attr=(0o100755 if p.stat().st_mode & 0o111 else 0o100644)<<16;info.compress_type=zipfile.ZIP_DEFLATED
   z.writestr(info,p.read_bytes(),compresslevel=9)
`,
  ],
  { cwd: fileURLToPath(out), stdio: 'inherit' },
);
