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
  // Exclusive creation prevents silently overwriting operator-owned local files.
  writeFileSync(
    resolve('.env.production'),
    `STOREFRONT_API_BASE_URL=${url.href}\nSTOREFRONT_CURRENCY=USD\n`,
    { encoding: 'utf8', mode: 0o600, flag: 'wx' },
  );
}
try {
  prepare();
  console.log('Prepared the two public storefront settings for SSR.');
} catch (error) {
  const allowed = [
    'STOREFRONT_API_BASE_URL is required.',
    'STOREFRONT_CURRENCY is required.',
    'STOREFRONT_CURRENCY must be USD.',
    'STOREFRONT_API_BASE_URL must be a public HTTPS base URL.',
  ];
  console.error(
    error instanceof Error && allowed.includes(error.message)
      ? error.message
      : 'Cannot create .env.production; use a clean build workspace without an existing environment file.',
  );
  process.exitCode = 1;
}
