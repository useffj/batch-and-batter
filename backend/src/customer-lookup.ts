import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { orderSchema } from './payment-domain';
type Order = z.infer<typeof orderSchema>;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
// NFC preserves punctuation and accents. These are whitespace tokens, not legal names.
export const normalizeName = (s: string) =>
  s.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase();
export const normalizeEmail = (s: string) => s.trim().toLowerCase();
export function nameTerms(name: string) {
  const full = normalizeName(name),
    tokens = full.split(' ');
  return [...new Set([full, tokens[0], tokens.at(-1)!])];
}
export const contactKey = (c: Order['customer']) =>
  hash(JSON.stringify([c.name, c.email, c.phone]));
export const lookupPartition = (
  kind: 'name' | 'email' | 'contact',
  value: string,
) => `CUSTOMER_LOOKUP#v1#${kind}#${kind === 'contact' ? value : hash(value)}`;
export const lookupSort = (o: Pick<Order, 'createdAt' | 'orderId'>) =>
  `ORDER#${o.createdAt}#${o.orderId}`;
export function customerLookupRecords(o: Order) {
  const contact = contactKey(o.customer);
  return [
    ...nameTerms(o.customer.name).map((t) => lookupPartition('name', t)),
    lookupPartition('email', normalizeEmail(o.customer.email)),
    lookupPartition('contact', contact),
  ].map((PK) => ({
    PK,
    SK: lookupSort(o),
    orderId: o.orderId,
    contactKey: contact,
  }));
}
export function searchPartition(query: string) {
  const q = query.trim();
  if (q.includes('@'))
    return lookupPartition(
      'email',
      normalizeEmail(z.email().max(254).parse(q)),
    );
  return lookupPartition(
    'name',
    normalizeName(z.string().min(1).max(200).parse(q)),
  );
}
