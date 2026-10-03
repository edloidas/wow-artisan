import { readFileSync } from 'node:fs';
import { isTable, type LuaTable, type LuaValue, luaText, readSavedVariables } from '../lua.ts';

/** Containers that are not spare stock: worn gear and items already on the auction house. */
const SKIPPED_CONTAINERS = new Set(['equipped', 'auctions']);

export type Character = {
  name: string;
  money: number;
  items: Map<number, number>;
};

export type Inventory = {
  characters: Character[];
  totals: Map<number, number>;
  /** Item names read from item links; covers items missing from client data. */
  names: Map<number, string>;
};

export function readSyndicator(file: string): Inventory {
  const vars = readSavedVariables(readFileSync(file));
  const data = vars.SYNDICATOR_DATA;
  const characters: Character[] = [];
  const totals = new Map<number, number>();
  const names = new Map<number, string>();
  const byName = isTable(data) ? data.Characters : undefined;
  if (isTable(byName)) {
    for (const [name, raw] of Object.entries(byName)) {
      if (!isTable(raw)) continue;
      const items = new Map<number, number>();
      collectItems(raw, items, names);
      for (const [id, count] of items) totals.set(id, (totals.get(id) ?? 0) + count);
      characters.push({ name: luaText(name), money: Number(raw.money) || 0, items });
    }
  }
  return { characters, totals, names };
}

function collectItems(table: LuaTable, items: Map<number, number>, names: Map<number, string>) {
  const id = table.itemID;
  if (typeof id === 'number') {
    const count = typeof table.itemCount === 'number' ? table.itemCount : 1;
    items.set(id, (items.get(id) ?? 0) + count);
    const link = typeof table.itemLink === 'string' ? luaText(table.itemLink) : '';
    const name = /\|h\[(.+?)\]\|h/.exec(link)?.[1];
    if (name) names.set(id, name);
    return;
  }
  for (const [key, value] of Object.entries(table) as [string, LuaValue][]) {
    if (isTable(value) && !SKIPPED_CONTAINERS.has(key)) collectItems(value, items, names);
  }
}
