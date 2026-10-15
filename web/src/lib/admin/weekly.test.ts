import { describe, it, expect } from 'vitest';
import {
  cents,
  priceText,
  denverUtc,
  denverLocal,
  pickupDates,
  weeklyDefaults,
} from './weekly';
describe('weekly Drop owner inputs', () => {
  it('uses integer cents without floating point multiplication of decimal input', () => {
    expect(cents('4.29')).toBe(429);
    expect(cents('0')).toBe(0);
    expect(priceText(Number.MAX_SAFE_INTEGER)).toBe('90071992547409.91');
    expect(cents(priceText(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    for (const x of ['-1', '1.001', 'NaN', '1e2', ''])
      expect(() => cents(x)).toThrow();
  });
  it('handles winter/summer and rejects DST gaps/ambiguity', () => {
    expect(denverUtc('2026-10-18T12:00')).toBe('2026-10-18T18:00:00.000Z');
    expect(denverUtc('2026-11-08T12:00')).toBe('2026-11-08T19:00:00.000Z');
    expect(() => denverUtc('2026-03-08T02:30')).toThrow();
    expect(() => denverUtc('2026-11-01T01:30')).toThrow();
    expect(denverLocal('2026-11-08T19:00:00Z')).toBe('2026-11-08T12:00');
  });
  it('defaults next Sunday noon and following Thu–Sat', () => {
    expect(weeklyDefaults(new Date('2026-10-15T20:00Z'))).toBe(
      '2026-10-18T12:00',
    );
    expect(pickupDates('2026-10-18T12:00')).toEqual([
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
    ]);
  });
});
