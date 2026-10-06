import { expect, it } from 'vitest';
import { normalizeUSPhone, phoneEntry } from './phone';
it.each([
  '3035550123',
  '(303) 555-0123',
  '303-555-0123',
  ' 303 555 0123 ',
  '+13035550123',
])('normalizes %s to the existing E.164 contract', (value) => {
  expect(normalizeUSPhone(value)).toBe('+13035550123');
});
it.each([
  '',
  '303555012',
  '30355501234',
  '+130355501234',
  '+443035550123',
  '00443035550123',
  '3035550123 ext 4',
  '+1+3035550123',
])('rejects unsupported input %s', (value) => {
  expect(() => normalizeUSPhone(value)).toThrow();
});
it('explains unsupported country prefixes', () => {
  expect(() => normalizeUSPhone('+443035550123')).toThrow(
    'Only U.S. phone numbers',
  );
});

it.each(['3035550123', '(303) 555-0123', '303-555-0123', '+1 303 555 0123'])(
  'sanitizes complete entry %s into national digits',
  (value) => {
    expect(phoneEntry(value)).toBe('3035550123');
    expect(normalizeUSPhone(phoneEntry(value))).toBe('+13035550123');
  },
);
it.each(['', '3', '303555012'])(
  'allows partial editing but rejects incomplete submission %s',
  (value) => {
    expect(phoneEntry(value)).toBe(value);
    expect(() => normalizeUSPhone(value)).toThrow();
  },
);
it.each([
  '30355501234',
  'abc',
  '303abc5550123',
  '+443035550123',
  '+130355501234',
])('rejects invalid entry %s without dropping extra content', (value) => {
  expect(() => phoneEntry(value)).toThrow();
});
