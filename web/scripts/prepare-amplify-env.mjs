import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Hosting configuration is public. Never serialize the rest of process.env.
function prepare() {
  const raw = process.env.STOREFRONT_API_BASE_URL;
  if (!raw) throw new Error('STOREFRONT_API_BASE_URL is required.');
  if (!process.env.STOREFRONT_CURRENCY)
    throw new Error('STOREFRONT_CURRENCY is required.');
  if (process.env.STOREFRONT_CURRENCY !== 'USD')
    throw new Error('STOREFRONT_CURRENCY must be USD.');
  // Reject dotenv expansion, quoting, newline injection and ambiguous URL input.
  if (raw.length > 2048 || /[\s\x00-\x1f\x7f$'"\\#]/.test(raw))
    throw new Error('STOREFRONT_API_BASE_URL must be a public HTTPS base URL.');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('STOREFRONT_API_BASE_URL must be a public HTTPS base URL.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('STOREFRONT_API_BASE_URL must be a public HTTPS base URL.');
  // Optional for storefront-only builds. Missing checkout settings stay absent,
  // so the existing server-side checkout gate continues to fail closed.
  const submissionMode = process.env.CHECKOUT_SUBMISSION_MODE;
  if (
    submissionMode !== undefined &&
    !['locked', 'enabled'].includes(submissionMode)
  )
    throw new Error(
      'CHECKOUT_SUBMISSION_MODE must be locked or enabled when set.',
    );
  const pricingMode = process.env.CHECKOUT_PRICING_MODE;
  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  if (pricingMode !== undefined && pricingMode !== 'dev-zero-tax-fee')
    throw new Error('CHECKOUT_PRICING_MODE must be dev-zero-tax-fee when set.');
  if (
    publishableKey !== undefined &&
    !/^pk_test_[a-zA-Z0-9]+$/.test(publishableKey)
  )
    throw new Error(
      'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY must be a test publishable key when set.',
    );
  // Explicit non-secret allowlist; never copy arbitrary NEXT_PUBLIC_ variables,
  // credentials, capabilities, provider tokens/secrets or customer data.
  const lines = [
    `STOREFRONT_API_BASE_URL=${url.href}`,
    'STOREFRONT_CURRENCY=USD',
  ];
  if (pricingMode !== undefined)
    lines.push(`CHECKOUT_PRICING_MODE=${pricingMode}`);
  if (submissionMode !== undefined)
    lines.push(`CHECKOUT_SUBMISSION_MODE=${submissionMode}`);
  if (publishableKey !== undefined)
    lines.push(`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=${publishableKey}`);
  // Admin values are optional for storefront-only deployments. Validate every
  // supplied value before writing; never copy the actual session key.
  if (process.env.ADMIN_CATALOG_MODE !== undefined) {
    if (
      process.env.ADMIN_CATALOG_MODE !== 'isolated' ||
      process.env.AWS_BRANCH !== 'admin-dev-3b23b18' ||
      raw !== 'https://storefront.invalid' ||
      submissionMode !== 'locked' ||
      process.env.ADMIN_ORIGIN !==
        'https://admin-dev-3b23b18.d1aw7cfglvejmo.amplifyapp.com' ||
      !process.env.ADMIN_API_BASE_URL ||
      process.env.ADMIN_API_BASE_URL.includes('7otpu9y03a')
    )
      throw new Error(
        'Isolated catalog requires the restricted branch and locked public paths.',
      );
    lines.push('ADMIN_CATALOG_MODE=isolated');
  }
  const adminNames = [
    'ADMIN_ORIGIN',
    'ADMIN_API_BASE_URL',
    'ADMIN_COGNITO_REGION',
    'ADMIN_COGNITO_CLIENT_ID',
    'ADMIN_SESSION_KEY_PARAMETER',
  ];
  for (const name of adminNames) {
    const value = process.env[name];
    if (value === undefined) continue;
    let valid =
      value.length > 0 &&
      value.length <= 2048 &&
      !/[\s\x00-\x1f\x7f$'"\\#]/.test(value);
    if (name === 'ADMIN_ORIGIN' || name === 'ADMIN_API_BASE_URL') {
      try {
        const parsed = new URL(value);
        valid &&=
          parsed.protocol === 'https:' &&
          !parsed.username &&
          !parsed.password &&
          !parsed.search &&
          !parsed.hash &&
          (name !== 'ADMIN_ORIGIN' || parsed.pathname === '/');
      } catch {
        valid = false;
      }
    } else if (name === 'ADMIN_COGNITO_REGION') {
      valid &&= /^[a-z]{2}(?:-[a-z]+)+-\d$/.test(value);
    } else if (name === 'ADMIN_COGNITO_CLIENT_ID') {
      valid &&= /^[a-zA-Z0-9]{1,128}$/.test(value);
    } else {
      valid &&= value === '/batch-and-batter/dev/admin/session-key';
    }
    if (!valid) throw new Error('Invalid nonsecret admin SSR configuration.');
    lines.push(`${name}=${value}`);
  }
  // Exclusive creation prevents silently overwriting operator-owned local files.
  writeFileSync(resolve('.env.production'), `${lines.join('\n')}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
}
try {
  prepare();
  console.log(
    'Prepared explicitly allowlisted non-secret application settings for SSR.',
  );
} catch (error) {
  const allowed = [
    'Invalid nonsecret admin SSR configuration.',
    'STOREFRONT_API_BASE_URL is required.',
    'STOREFRONT_CURRENCY is required.',
    'STOREFRONT_CURRENCY must be USD.',
    'STOREFRONT_API_BASE_URL must be a public HTTPS base URL.',
    'CHECKOUT_PRICING_MODE must be dev-zero-tax-fee when set.',
    'CHECKOUT_SUBMISSION_MODE must be locked or enabled when set.',
    'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY must be a test publishable key when set.',
  ];
  console.error(
    error instanceof Error && allowed.includes(error.message)
      ? error.message
      : 'Cannot create .env.production; use a clean build workspace without an existing environment file.',
  );
  process.exitCode = 1;
}
