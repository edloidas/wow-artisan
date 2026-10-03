import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Encoder } from 'cbor-x';
import { parseCsv } from '../src/gamedata/csv.ts';
import { parsePriceTable } from '../src/prices/ahledger.ts';
import { auctionatorMarket, readAuctionator } from '../src/prices/auctionator.ts';

/** Lua string literal for arbitrary bytes, escaped the way WoW does. */
function luaLiteral(bytes: Uint8Array): string {
  let out = '"';
  for (const byte of bytes) {
    if (byte === 34 || byte === 92) out += `\\${String.fromCharCode(byte)}`;
    else if (byte < 32 || byte > 126) out += `\\${byte}`;
    else out += String.fromCharCode(byte);
  }
  return `${out}"`;
}

/** WoW's CBOR writes Lua strings, keys included, as byte strings. */
function bytesKeyed(entries: Record<string, unknown>): Map<Uint8Array, unknown> {
  return new Map(
    Object.entries(entries).map(([key, value]) => [
      Buffer.from(key),
      value && typeof value === 'object' ? bytesKeyed(value as Record<string, unknown>) : value,
    ]),
  );
}

describe('Auctionator', () => {
  test('decodes the per-realm CBOR price database and the vendor cache', () => {
    const realm = bytesKeyed({
      // Day 2463 is 2026-09-29; `l` exists only on days with several scans.
      '2840': {
        m: 136,
        h: { '2461': 105, '2463': 140 },
        l: { '2463': 120 },
        a: { '2461': 3559, '2463': 6102 },
      },
      'gr:1234:of the Bear': { m: 5 },
    });
    const blob = new Encoder({ mapsAsObjects: false, useRecords: false }).encode(realm);
    const file = join(mkdtempSync(join(tmpdir(), 'wow-artisan-')), 'Auctionator.lua');
    writeFileSync(
      file,
      Buffer.from(
        `AUCTIONATOR_PRICE_DATABASE = {\r\n["__dbversion"] = 8,\r\n["TestRealm"] = ${luaLiteral(blob)},\r\n}\r\n` +
          `AUCTIONATOR_VENDOR_PRICE_CACHE = {\r\n["2880"] = 100,\r\n["2516"] = 0.045,\r\n}\r\n`,
        'latin1',
      ),
    );

    const data = readAuctionator(file);
    const market = auctionatorMarket(data);
    expect(market.id).toBe('auctionator:TestRealm');
    expect([...market.prices.keys()]).toEqual([2840]);
    expect(market.prices.get(2840)).toEqual({
      min: 136,
      quantity: 6102,
      history: [
        { date: '2026-09-27', min: 105, quantity: 3559 },
        { date: '2026-09-29', min: 120, quantity: 6102 },
      ],
    });
    expect(data.vendorBuy.get(2880)).toBe(100);
    expect(() => auctionatorMarket(data, 'Elsewhere')).toThrow('known: TestRealm');
  });
});

describe('AHledger price table', () => {
  test('reads rows and leaves empty fields unknown', () => {
    const market = parsePriceTable(
      'forever.normal.alliance.us',
      'AHL1|forever/normal/alliance/us|1790990105|2\n3859:2900:2500:282:2210:2900:1800:9000\n36:100:100:1::::\n',
    );
    expect(market.observedAt).toBe('2026-10-03T01:15:05.000Z');
    expect(market.prices.get(3859)).toEqual({
      median: 2900,
      min: 2500,
      quantity: 282,
      median7d: 2210,
      median30d: 2900,
      low30d: 1800,
      high30d: 9000,
    });
    expect(market.prices.get(36)).toEqual({ median: 100, min: 100, quantity: 1 });
  });
});

describe('parseCsv', () => {
  test('handles quoted commas, doubled quotes, newlines and CRLF', () => {
    const rows = parseCsv('ID,Name\r\n1,"Plans: ""Big"" Hammer, Heavy"\r\n2,"two\nlines"\r\n');
    expect(rows).toEqual([
      { ID: '1', Name: 'Plans: "Big" Hammer, Heavy' },
      { ID: '2', Name: 'two\nlines' },
    ]);
  });
});
