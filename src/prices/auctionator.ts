import { readFileSync, statSync } from 'node:fs';
import { Decoder } from 'cbor-x';
import { isTable, type LuaTable, type LuaValue, luaBytes, readSavedVariables } from '../lua.ts';
import type { DailyPrice, Market, PriceStats } from './types.ts';

// Auctionator counts scan days from 2020-01-01 (Source/Constants/Main.lua).
const SCAN_DAY_0 = Date.UTC(2020, 0, 1);
const DAY_MS = 86_400_000;

const cbor = new Decoder({ mapsAsObjects: false });

/** WoW's CBOR encodes Lua strings as byte strings, keys included; turn them back into strings. */
function decodeCbor(bytes: Uint8Array): unknown {
  return normalize(cbor.decode(bytes));
}

function normalize(value: unknown): unknown {
  if (value instanceof Uint8Array) return Buffer.from(value).toString('latin1');
  if (value instanceof Map) {
    const object: Record<string, unknown> = {};
    for (const [key, entry] of value) object[String(normalize(key))] = normalize(entry);
    return object;
  }
  if (Array.isArray(value)) return value.map(normalize);
  return value;
}

export type AuctionatorData = {
  /** Realm key -> item id -> stats. The key is the realm only, never the faction. */
  realms: Map<string, Map<number, PriceStats>>;
  /** Item id -> copper a vendor charges, for items the player has seen at a vendor. */
  vendorBuy: Map<number, number>;
  modifiedAt: string;
};

export function readAuctionator(file: string): AuctionatorData {
  const vars = readSavedVariables(readFileSync(file));
  return {
    realms: decodePriceDatabase(vars.AUCTIONATOR_PRICE_DATABASE),
    vendorBuy: decodeVendorCache(vars.AUCTIONATOR_VENDOR_PRICE_CACHE),
    modifiedAt: statSync(file).mtime.toISOString(),
  };
}

export function auctionatorMarket(data: AuctionatorData, realm?: string): Market {
  const entries = [...data.realms];
  const chosen = realm
    ? entries.find(([key]) => key === realm)
    : entries.sort((a, b) => b[1].size - a[1].size)[0];
  if (!chosen) {
    const known = entries.map(([key]) => key).join(', ') || 'none';
    throw new Error(`Auctionator has no realm '${realm ?? ''}' (known: ${known})`);
  }
  return {
    id: `auctionator:${chosen[0]}`,
    label: `${chosen[0]} (your Auctionator scans)`,
    source: 'auctionator',
    observedAt: data.modifiedAt,
    prices: chosen[1],
  };
}

function decodePriceDatabase(db: LuaValue | undefined): Map<string, Map<number, PriceStats>> {
  const realms = new Map<string, Map<number, PriceStats>>();
  if (!isTable(db)) return realms;
  for (const [realm, value] of Object.entries(db)) {
    if (realm.startsWith('__')) continue;
    const decoded = typeof value === 'string' ? decodeCbor(luaBytes(value)) : value;
    if (decoded && typeof decoded === 'object') {
      realms.set(realm, decodeRealm(decoded as Record<string, unknown>));
    }
  }
  return realms;
}

type RawEntry = { m?: number; h?: DayMap; l?: DayMap; a?: DayMap };
type DayMap = Record<string, number>;

function decodeRealm(raw: Record<string, unknown>): Map<number, PriceStats> {
  const items = new Map<number, PriceStats>();
  for (const [key, value] of Object.entries(raw)) {
    // Plain item ids only; "gr:" keys are gear with random suffixes, "p:" are pets.
    if (!/^\d+$/.test(key)) continue;
    // Older database versions stored each item as its own CBOR string.
    const entry = (typeof value === 'string' ? decodeCbor(luaBytes(value)) : value) as RawEntry;
    if (!entry || typeof entry !== 'object') continue;
    items.set(Number(key), toStats(entry));
  }
  return items;
}

function toStats(entry: RawEntry): PriceStats {
  const days = Object.keys(entry.h ?? {}).sort((a, b) => Number(a) - Number(b));
  const history: DailyPrice[] = days.map((day) => {
    const daily: DailyPrice = {
      date: new Date(SCAN_DAY_0 + Number(day) * DAY_MS).toISOString().slice(0, 10),
      // `l` is stored only when it differs from `h`, i.e. on days with several scans.
      min: entry.l?.[day] ?? entry.h?.[day] ?? 0,
    };
    const quantity = entry.a?.[day];
    if (quantity !== undefined) daily.quantity = quantity;
    return daily;
  });
  const stats: PriceStats = { quantity: history.at(-1)?.quantity ?? 0, history };
  if (entry.m !== undefined) stats.min = entry.m;
  return stats;
}

function decodeVendorCache(cache: LuaValue | undefined): Map<number, number> {
  const prices = new Map<number, number>();
  if (!isTable(cache)) return prices;
  for (const [key, value] of Object.entries(cache as LuaTable)) {
    if (typeof value === 'number' && /^\d+$/.test(key)) prices.set(Number(key), value);
  }
  return prices;
}
