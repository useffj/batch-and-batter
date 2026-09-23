import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { generateUlid } from '../src/ulid';
import { idSchema } from '../src/domain';
import { catalogKeys } from '../src/keys';
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function timestamp(id: string) {
  return [...id.slice(0, 10)].reduce(
    (value, char) => value * 32 + alphabet.indexOf(char),
    0,
  );
}
test('ULIDs have standard encoding, current milliseconds, unique randomness and valid catalog keys', () => {
  const before = Date.now();
  const ids = Array.from({ length: 1000 }, generateUlid);
  const after = Date.now();
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    assert.equal(id.length, 26);
    assert.match(id, /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    assert.equal(idSchema.parse(id), id);
    assert.equal(z.ulid().parse(id), id);
    assert.ok(timestamp(id) >= before && timestamp(id) <= after);
    assert.deepEqual(catalogKeys.product(id), {
      PK: `PRODUCT#${id}`,
      SK: 'META',
    });
    assert.deepEqual(catalogKeys.drop(id), { PK: `DROP#${id}`, SK: 'META' });
  }
});
test('timestamp encoding handles zero, maximum and the canonical specification example', (t) => {
  for (const [milliseconds, prefix] of [
    [0, '0000000000'],
    [0xffffffffffff, '7ZZZZZZZZZ'],
    [1469918176385, '01ARYZ6S41'],
  ] as const) {
    t.mock.method(Date, 'now', () => milliseconds);
    assert.equal(generateUlid().slice(0, 10), prefix);
    t.mock.restoreAll();
  }
});
test('same-millisecond generation stays distinct without changing timestamp', (t) => {
  t.mock.method(Date, 'now', () => 1469918176385);
  const ids = Array.from({ length: 1000 }, generateUlid);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => timestamp(id) === 1469918176385));
});
test('out of range and fractional timestamps are rejected', (t) => {
  for (const milliseconds of [-1, 0x1000000000000, NaN, 1.5]) {
    t.mock.method(Date, 'now', () => milliseconds);
    assert.throws(generateUlid, /timestamp out of range/);
    t.mock.restoreAll();
  }
});
