import { expect, it } from 'vitest';
import { normalizeUSPhone } from './phone';
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
