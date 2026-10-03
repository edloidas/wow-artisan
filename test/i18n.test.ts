import { describe, expect, test } from 'bun:test';
import { en, resolveLang, ru } from '../src/i18n/index.ts';
import { wowheadUrl } from '../src/wowhead.ts';

describe('i18n', () => {
  test('the language comes from the flag, else English, and unknown ones are rejected', () => {
    expect(resolveLang('RU')).toBe('ru');
    expect(resolveLang('')).toBe('en');
    expect(() => resolveLang('de')).toThrow();
  });

  test('Russian day counts take the right plural form', () => {
    expect(ru.stale(2)).toContain('2 дня');
    expect(ru.stale(5)).toContain('5 дней');
    expect(ru.stale(11)).toContain('11 дней');
    expect(ru.stale(21)).toContain('21 день');
  });

  test('issues render with each language money format', () => {
    const issue = { kind: 'vendor-beats-auction', auctionNet: 950, vendor: 1000 } as const;
    expect(en.issue(issue)).toBe("auction nets 9s50c/u, under the vendor's 10s00c/u");
    expect(ru.issue(issue)).toContain('9с50м/шт');
  });

  test('Wowhead links put the locale after the Forever segment', () => {
    expect(wowheadUrl('item', 2841)).toBe('https://www.wowhead.com/forever/item=2841');
    expect(wowheadUrl('spell', 2660, 'ru')).toBe('https://www.wowhead.com/forever/ru/spell=2660');
  });
});
