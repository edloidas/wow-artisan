// Parser for the Lua subset WoW writes into SavedVariables files: top-level
// `NAME = value` assignments of tables, strings, numbers, booleans and nil.
//
// Input is decoded as latin1 so every byte maps to one char: some addons store
// binary blobs (CBOR) in strings, and those must survive untouched. Use
// `luaText` to turn a parsed string into readable UTF-8.

export type LuaValue = string | number | boolean | null | LuaTable;
export type LuaTable = { [key: string]: LuaValue };

const ESCAPES: Record<string, number> = {
  n: 10,
  r: 13,
  t: 9,
  a: 7,
  b: 8,
  f: 12,
  v: 11,
  '"': 34,
  "'": 39,
  '\\': 92,
};

export function readSavedVariables(bytes: Uint8Array): Record<string, LuaValue> {
  return parseSavedVariables(Buffer.from(bytes).toString('latin1'));
}

export function luaText(value: string): string {
  return Buffer.from(value, 'latin1').toString('utf8');
}

export function luaBytes(value: string): Uint8Array {
  return Buffer.from(value, 'latin1');
}

export function parseSavedVariables(source: string): Record<string, LuaValue> {
  const parser = new Parser(source);
  const result: Record<string, LuaValue> = {};
  for (;;) {
    parser.skipTrivia();
    if (parser.done()) return result;
    const name = parser.identifier();
    parser.skipTrivia();
    parser.expect('=');
    result[name] = parser.value();
  }
}

class Parser {
  private pos = 0;

  constructor(private readonly src: string) {}

  done(): boolean {
    return this.pos >= this.src.length;
  }

  skipTrivia(): void {
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        this.pos++;
      } else if (c === '-' && this.src[this.pos + 1] === '-') {
        const end = this.src.indexOf('\n', this.pos);
        this.pos = end === -1 ? this.src.length : end + 1;
      } else {
        return;
      }
    }
  }

  expect(char: string): void {
    if (this.src[this.pos] !== char) {
      throw new Error(`Expected '${char}' at ${this.pos}, found '${this.src[this.pos] ?? 'EOF'}'`);
    }
    this.pos++;
  }

  identifier(): string {
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos, this.pos + 256));
    if (!match) throw new Error(`Expected identifier at ${this.pos}`);
    this.pos += match[0].length;
    return match[0];
  }

  value(): LuaValue {
    this.skipTrivia();
    const c = this.src[this.pos];
    if (c === '{') return this.table();
    if (c === '"' || c === "'") return this.string();
    if (this.src.startsWith('true', this.pos)) {
      this.pos += 4;
      return true;
    }
    if (this.src.startsWith('false', this.pos)) {
      this.pos += 5;
      return false;
    }
    if (this.src.startsWith('nil', this.pos)) {
      this.pos += 3;
      return null;
    }
    return this.number();
  }

  private number(): number {
    const match = /^-?(?:0x[0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|inf|nan)/.exec(
      this.src.slice(this.pos, this.pos + 64),
    );
    if (!match) throw new Error(`Unexpected '${this.src[this.pos] ?? 'EOF'}' at ${this.pos}`);
    this.pos += match[0].length;
    return Number(match[0]);
  }

  private string(): string {
    const quote = this.src[this.pos];
    this.pos++;
    let out = '';
    let chunkStart = this.pos;
    for (;;) {
      const c = this.src[this.pos];
      if (c === undefined) throw new Error('Unterminated string');
      if (c === quote) {
        out += this.src.slice(chunkStart, this.pos);
        this.pos++;
        return out;
      }
      if (c !== '\\') {
        this.pos++;
        continue;
      }
      out += this.src.slice(chunkStart, this.pos);
      const next = this.src[this.pos + 1] ?? '';
      const digits = /^\d{1,3}/.exec(this.src.slice(this.pos + 1, this.pos + 4));
      if (digits) {
        out += String.fromCharCode(Number(digits[0]));
        this.pos += 1 + digits[0].length;
      } else if (next === '\n' || next === '\r') {
        out += '\n';
        this.pos += this.src.startsWith('\r\n', this.pos + 1) ? 3 : 2;
      } else {
        const code = ESCAPES[next];
        if (code === undefined) throw new Error(`Unknown escape '\\${next}' at ${this.pos}`);
        out += String.fromCharCode(code);
        this.pos += 2;
      }
      chunkStart = this.pos;
    }
  }

  private table(): LuaTable {
    this.expect('{');
    const table: LuaTable = {};
    let index = 1;
    for (;;) {
      this.skipTrivia();
      if (this.src[this.pos] === '}') {
        this.pos++;
        return table;
      }
      if (this.src[this.pos] === '[') {
        this.pos++;
        const key = this.value();
        this.skipTrivia();
        this.expect(']');
        this.skipTrivia();
        this.expect('=');
        table[String(key)] = this.value();
      } else {
        table[String(index++)] = this.value();
      }
      this.skipTrivia();
      if (this.src[this.pos] === ',' || this.src[this.pos] === ';') this.pos++;
    }
  }
}

export function isTable(value: LuaValue | undefined): value is LuaTable {
  return typeof value === 'object' && value !== null;
}
