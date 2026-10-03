import { describe, expect, test } from 'bun:test';
import { formatMoney, parseMoney } from '../src/money.ts';

describe('money', () => {
  test('formats the two largest denominations', () => {
    expect(formatMoney(65_687)).toBe('6g56s');
    expect(formatMoney(136)).toBe('1s36c');
    expect(formatMoney(7)).toBe('7c');
    expect(formatMoney(-19)).toBe('-19c');
    expect(formatMoney(undefined)).toBe('-');
  });

  test('exact amounts keep copper above a gold', () => {
    expect(formatMoney(65_687, true)).toBe('6g56s87c');
    expect(formatMoney(65_600, true)).toBe('6g56s');
    expect(formatMoney(136, true)).toBe('1s36c');
  });

  test('parses gold/silver/copper notation; a bare number is copper', () => {
    expect(parseMoney('1g20s5c')).toBe(12_005);
    expect(parseMoney('50s')).toBe(5_000);
    expect(parseMoney('1.5g')).toBe(15_000);
    expect(parseMoney('250')).toBe(250);
    expect(parseMoney(42)).toBe(42);
  });

  test('Russian coin letters format and parse', () => {
    expect(formatMoney(65_687, true, ['з', 'с', 'м'])).toBe('6з56с87м');
    expect(parseMoney('1з20с5м')).toBe(12_005);
    expect(parseMoney('50с')).toBe(5_000);
  });

  test('rejects amounts it cannot read', () => {
    expect(() => parseMoney('')).toThrow();
    expect(() => parseMoney('5x')).toThrow();
  });
});
