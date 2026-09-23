import { randomBytes } from 'node:crypto';
import { idSchema } from './domain';

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// Standard ULID: 48 Unix-millisecond bits followed by 80 random bits.
// Same-millisecond IDs are random, not monotonically ordered.
export function generateUlid(): string {
  const milliseconds = Date.now();
  if (
    !Number.isInteger(milliseconds) ||
    milliseconds < 0 ||
    milliseconds > 0xffffffffffff
  )
    throw new Error('ULID timestamp out of range');
  let value = BigInt(milliseconds);
  for (const byte of randomBytes(10)) value = (value << 8n) | BigInt(byte);
  let result = '';
  for (let i = 0; i < 26; i++) {
    result = alphabet[Number(value & 31n)] + result;
    value >>= 5n;
  }
  return idSchema.parse(result);
}
