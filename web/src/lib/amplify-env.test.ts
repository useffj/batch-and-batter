import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const helper = resolve('scripts/prepare-amplify-env.mjs');
const directories: string[] = [];
const storefront = {
  STOREFRONT_API_BASE_URL: 'https://api.example.invalid',
  STOREFRONT_CURRENCY: 'USD',
};
const checkout = {
  CHECKOUT_PRICING_MODE: 'dev-zero-tax-fee',
  CHECKOUT_SUBMISSION_MODE: 'locked',
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_LocalBuildPlaceholder',
};
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function run(env: Record<string, string | undefined>, existing?: string) {
  const cwd = mkdtempSync(join(tmpdir(), 'bb-amplify-env-'));
  directories.push(cwd);
  const path = join(cwd, '.env.production');
  if (existing !== undefined) writeFileSync(path, existing);
  // Deliberately do not inherit developer credentials or real public keys.
  const result = spawnSync(process.execPath, [helper], {
    cwd,
    env: { NODE_ENV: 'production', ...env },
    encoding: 'utf8',
  });
  return { ...result, path, output: result.stdout + result.stderr };
}

describe('Amplify SSR environment preparation', () => {
  it('writes exactly five reviewed settings and excludes all unrelated values', () => {
    const prohibited = {
      NEXT_PUBLIC_UNREVIEWED: 'unreviewed-placeholder',
      STRIPE_SECRET_KEY: 'sk_test_placeholder',
      STRIPE_RESTRICTED_KEY: 'rk_test_placeholder',
      STRIPE_LIVE_KEY: 'sk_live_placeholder',
      STRIPE_LIVE_RESTRICTED_KEY: 'rk_live_placeholder',
      STRIPE_WEBHOOK_SECRET: 'whsec_placeholder',
      COGNITO_ADMIN_TOKEN: 'admin-placeholder',
      AWS_ACCESS_KEY_ID: 'aws-id-placeholder',
      AWS_SECRET_ACCESS_KEY: 'aws-secret-placeholder',
      AWS_SESSION_TOKEN: 'aws-session-placeholder',
      CART_CAPABILITY: 'capability-placeholder',
      PAYMENT_CLIENT_SECRET: 'pi_placeholder_secret_placeholder',
      CONFIRMATION_TOKEN: 'ctoken_placeholder',
      CUSTOMER_EMAIL: 'customer@example.invalid',
    };
    const result = run({ ...storefront, ...checkout, ...prohibited });
    expect(result.status).toBe(0);
    const text = readFileSync(result.path, 'utf8');
    expect(text).toBe(
      'STOREFRONT_API_BASE_URL=https://api.example.invalid/\n' +
        'STOREFRONT_CURRENCY=USD\n' +
        'CHECKOUT_PRICING_MODE=dev-zero-tax-fee\n' +
        'CHECKOUT_SUBMISSION_MODE=locked\n' +
        'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_LocalBuildPlaceholder\n',
    );
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
    for (const [name, value] of Object.entries(prohibited)) {
      expect(text).not.toContain(name);
      expect(text).not.toContain(value);
      expect(result.output).not.toContain(value);
    }
    expect(result.output).not.toContain(
      checkout.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
    );
  });
  it('preserves storefront-only builds when optional checkout settings are missing', () => {
    const result = run(storefront);
    expect(result.status).toBe(0);
    expect(readFileSync(result.path, 'utf8')).toBe(
      'STOREFRONT_API_BASE_URL=https://api.example.invalid/\nSTOREFRONT_CURRENCY=USD\n',
    );
  });
  it.each(Object.keys(checkout))(
    'omits missing %s rather than inventing a fallback',
    (name) => {
      const result = run({ ...storefront, ...checkout, [name]: undefined });
      expect(result.status).toBe(0);
      expect(readFileSync(result.path, 'utf8')).not.toContain(`${name}=`);
    },
  );
  it.each(Object.keys(storefront))(
    'rejects missing required %s without writing',
    (name) => {
      const result = run({ ...storefront, [name]: undefined });
      expect(result.status).toBe(1);
      expect(() => readFileSync(result.path)).toThrow();
    },
  );
  it.each(['', 'production', 'dev-zero-tax-fee\nINJECTED=value'])(
    'rejects unsupported pricing mode %j',
    (value) => {
      const result = run({ ...storefront, CHECKOUT_PRICING_MODE: value });
      expect(result.status).toBe(1);
      expect(() => readFileSync(result.path)).toThrow();
    },
  );
  it.each([
    '',
    'pk_live_placeholder',
    'sk_test_placeholder',
    'sk_live_placeholder',
    'rk_test_placeholder',
    'rk_live_placeholder',
    'whsec_placeholder',
    'ctoken_placeholder',
    'pi_placeholder_secret_placeholder',
    'pk_test_placeholder\nINJECTED=value',
    'pk_test_${SECRET}',
  ])(
    'rejects invalid publishable-key configuration %j without logging it',
    (value) => {
      const result = run({
        ...storefront,
        NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: value,
      });
      expect(result.status).toBe(1);
      expect(() => readFileSync(result.path)).toThrow();
      if (value) expect(result.output).not.toContain(value);
    },
  );
  it.each(['EUR', '', 'USD\nINJECTED=value'])(
    'rejects unsupported currency %j',
    (value) => {
      const result = run({ ...storefront, STOREFRONT_CURRENCY: value });
      expect(result.status).toBe(1);
      expect(() => readFileSync(result.path)).toThrow();
    },
  );
  it.each([
    'http://api.example.invalid',
    'https://user:secret@api.example.invalid',
    'https://api.example.invalid/?secret=value',
    'https://api.example.invalid/#fragment',
    'https://api.example.invalid/\nINJECTED=value',
    'https://api.example.invalid/$SECRET',
  ])('preserves URL validation for %j', (value) => {
    const result = run({ ...storefront, STOREFRONT_API_BASE_URL: value });
    expect(result.status).toBe(1);
    expect(() => readFileSync(result.path)).toThrow();
    expect(result.output).not.toContain(value);
  });
  it('does not overwrite an existing operator-owned environment file', () => {
    const result = run(
      { ...storefront, ...checkout },
      'existing-placeholder\n',
    );
    expect(result.status).toBe(1);
    expect(readFileSync(result.path, 'utf8')).toBe('existing-placeholder\n');
  });
});

it.each(['locked', 'enabled'])(
  'explicit submission mode %s is propagated',
  (mode) => {
    const result = run({ ...storefront, CHECKOUT_SUBMISSION_MODE: mode });
    expect(result.status).toBe(0);
    expect(readFileSync(result.path, 'utf8')).toContain(
      `CHECKOUT_SUBMISSION_MODE=${mode}\n`,
    );
  },
);
it.each(['', 'ENABLED', 'enabled\nSECRET=value'])(
  'invalid submission mode %j fails closed without a file',
  (mode) => {
    const result = run({ ...storefront, CHECKOUT_SUBMISSION_MODE: mode });
    expect(result.status).toBe(1);
    expect(() => readFileSync(result.path)).toThrow();
  },
);

const admin = {
  ADMIN_ORIGIN: 'https://shop.test',
  ADMIN_API_BASE_URL: 'https://api.test/dev',
  ADMIN_COGNITO_REGION: 'us-east-2',
  ADMIN_COGNITO_CLIENT_ID: 'syntheticClient',
  ADMIN_SESSION_KEY_PARAMETER: '/batch-and-batter/dev/admin/session-key',
};
it('allowlists only the five nonsecret admin settings, excluding keys and passwords', () => {
  const secret = 'ab'.repeat(32);
  const result = run({
    ...storefront,
    ...admin,
    ADMIN_SESSION_KEY: secret,
    NEXT_PUBLIC_ADMIN_SESSION_KEY: secret,
    COGNITO_PASSWORD: 'private-password',
  });
  expect(result.status).toBe(0);
  const artifact = readFileSync(result.path, 'utf8');
  for (const [name, value] of Object.entries(admin))
    expect(artifact).toContain(`${name}=${value}\n`);
  expect(artifact + result.output).not.toContain(secret);
  expect(artifact + result.output).not.toContain('private-password');
  expect(artifact).not.toContain('ADMIN_SESSION_KEY=');
  expect(artifact.split('\n').filter(Boolean)).toHaveLength(7);
});
it.each([
  ['ADMIN_ORIGIN', 'https://user:password@shop.test'],
  ['ADMIN_ORIGIN', 'https://shop.test/path'],
  ['ADMIN_API_BASE_URL', 'http://api.test'],
  ['ADMIN_API_BASE_URL', 'https://api.test?secret=value'],
  ['ADMIN_COGNITO_REGION', 'us-east-2\nINJECTED=value'],
  ['ADMIN_COGNITO_CLIENT_ID', '$SECRET'],
  ['ADMIN_SESSION_KEY_PARAMETER', '/unapproved/parameter'],
  ...Object.keys(admin).map((name) => [name, '']),
])(
  'rejects unsafe admin setting %s without writing or printing values',
  (name, value) => {
    const result = run({ ...storefront, ...admin, [name]: value });
    expect(result.status).toBe(1);
    expect(() => readFileSync(result.path)).toThrow();
    if (value) expect(result.output).not.toContain(value);
  },
);

it('restricts isolated catalog configuration to the locked Admin DEV branch', () => {
  const isolated = {
    STOREFRONT_API_BASE_URL: 'https://storefront.invalid',
    STOREFRONT_CURRENCY: 'USD',
    CHECKOUT_SUBMISSION_MODE: 'locked',
    ADMIN_CATALOG_MODE: 'isolated',
    AWS_BRANCH: 'admin-dev-3b23b18',
    ADMIN_ORIGIN: 'https://admin-dev-3b23b18.d1aw7cfglvejmo.amplifyapp.com',
    ADMIN_API_BASE_URL: 'https://isolated.example.invalid',
  };
  const good = run(isolated);
  expect(good.status).toBe(0);
  expect(readFileSync(good.path, 'utf8')).toContain(
    'ADMIN_CATALOG_MODE=isolated',
  );
  for (const patch of [
    { AWS_BRANCH: 'main' },
    { STOREFRONT_API_BASE_URL: 'https://public.example.invalid' },
    { CHECKOUT_SUBMISSION_MODE: 'enabled' },
    {
      ADMIN_API_BASE_URL:
        'https://7otpu9y03a.execute-api.us-east-2.amazonaws.com',
    },
    { ADMIN_CATALOG_MODE: 'other' },
  ])
    expect(run({ ...isolated, ...patch }).status).toBe(1);
});
