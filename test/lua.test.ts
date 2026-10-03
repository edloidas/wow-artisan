import { describe, expect, test } from 'bun:test';
import { luaBytes, luaText, parseSavedVariables } from '../src/lua.ts';

describe('parseSavedVariables', () => {
  test('reads nested tables, positional entries and the comments WoW writes after them', () => {
    const vars = parseSavedVariables(`
DB = {
["name"] = "Bar",
["count"] = -12.5,
["flags"] = { true, false, nil, -- [3]
},
[7] = "seven",
}
OTHER = 3
`);
    expect(vars).toEqual({
      DB: { name: 'Bar', count: -12.5, flags: { '1': true, '2': false, '3': null }, '7': 'seven' },
      OTHER: 3,
    });
  });

  test('decodes escapes, including decimal bytes and an escaped CRLF line break', () => {
    const vars = parseSavedVariables('S = "a\\"b\\\\c\\nd\\000e\\255f\\\r\ng"\r\n');
    expect(vars.S).toBe('a"b\\c\nd\u0000eÿf\ng');
  });

  test('keeps binary strings byte-exact and decodes text as UTF-8', () => {
    const bytes = Buffer.from([0xa1, 0x41, 0x00, 0xff]);
    const source = Buffer.concat([Buffer.from('B = "'), bytes, Buffer.from('"\nT = "Вкладка"\n')]);
    const vars = parseSavedVariables(source.toString('latin1'));
    expect([...luaBytes(vars.B as string)]).toEqual([...bytes]);
    expect(luaText(vars.T as string)).toBe('Вкладка');
  });

  test('fails loudly on malformed input', () => {
    expect(() => parseSavedVariables('X = "unterminated')).toThrow('Unterminated string');
    expect(() => parseSavedVariables('X = ?')).toThrow();
  });
});
