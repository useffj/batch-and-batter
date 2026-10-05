import {
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
const script = resolve('scripts/prepare-amplify-env.mjs');
function run(values: Record<string, string | undefined>, existing?: string) {
  const cwd = mkdtempSync(join(tmpdir(), 'storefront-env-test-'));
  try {
    if (existing) writeFileSync(join(cwd, '.env.production'), existing);
    const r = spawnSync(process.execPath, [script], {
      cwd,
      env: { NODE_ENV: 'production', ...values },
      encoding: 'utf8',
    });
    return {
      status: r.status,
      log: r.stdout + r.stderr,
      content: existsSync(join(cwd, '.env.production'))
        ? readFileSync(join(cwd, '.env.production'), 'utf8')
        : null,
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
const valid = {
  STOREFRONT_API_BASE_URL: 'https://public.example.test/stage',
  STOREFRONT_CURRENCY: 'USD',
};
it('writes exactly the allowlisted public settings and never prints their values', () => {
  const r = run({ ...valid, UNRELATED_SECRET: 'DO_NOT_COPY_THIS_VALUE' });
  expect(r.status).toBe(0);
  expect(r.content).toBe(
    'STOREFRONT_API_BASE_URL=https://public.example.test/stage\nSTOREFRONT_CURRENCY=USD\n',
  );
  expect(r.log).not.toContain(valid.STOREFRONT_API_BASE_URL);
  expect(r.content + r.log).not.toContain('DO_NOT_COPY_THIS_VALUE');
});
it.each([
  {},
  { STOREFRONT_CURRENCY: 'USD' },
  { STOREFRONT_API_BASE_URL: valid.STOREFRONT_API_BASE_URL },
  { ...valid, STOREFRONT_CURRENCY: 'EUR' },
])('fails before writing when configuration is absent/invalid %#', (env) => {
  const r = run(env);
  expect(r.status).toBe(1);
  expect(r.content).toBeNull();
  expect(r.log).toMatch(/required|must be USD/);
});
it.each([
  'http://localhost:1234',
  'https://user:secret@example.test',
  'https://example.test?token=secret',
  'https://example.test#fragment',
  'https://example.test/$SECRET',
  'https://example.test/\nSECRET=x',
  'https://example.test/"',
  'not-a-url',
])('rejects unsafe URL without echoing it %#', (url) => {
  const r = run({ ...valid, STOREFRONT_API_BASE_URL: url });
  expect(r.status).toBe(1);
  expect(r.content).toBeNull();
  expect(r.log).not.toContain(url);
});
it('preserves an existing operator environment file', () => {
  const r = run(valid, 'EXISTING_SETTING=keep\n');
  expect(r.status).toBe(1);
  expect(r.content).toBe('EXISTING_SETTING=keep\n');
});
it('build specification stays web-only and packages SSR output', () => {
  const yaml = readFileSync(resolve('../amplify.yml'), 'utf8');
  for (const value of [
    'appRoot: web',
    'npm ci --cache .npm --prefer-offline',
    'node scripts/prepare-amplify-env.mjs',
    'npm run build',
    'baseDirectory: .next',
    '.next/cache/**/*',
  ])
    expect(yaml).toContain(value);
  expect(yaml).not.toMatch(/amplifyPush|cdk|backend:|out\/|env \|/);
});
