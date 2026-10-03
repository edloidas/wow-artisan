import type { Market, PriceStats } from './types.ts';

// Free public API, attribution required: https://ahledger.com/developers
const API = 'https://api.ahledger.com/v1';

export type AhledgerMarketInfo = { id: string; label: string; game: string; region: string };

export async function listAhledgerMarkets(): Promise<AhledgerMarketInfo[]> {
  const response = await fetch(`${API}/markets`);
  if (!response.ok) throw new Error(`AHledger markets: HTTP ${response.status}`);
  const body = (await response.json()) as { markets: AhledgerMarketInfo[] };
  return body.markets.filter((market) => market.game === 'forever');
}

export async function fetchAhledgerMarket(marketId: string): Promise<Market> {
  const response = await fetch(`${API}/pricetable/${marketId}`);
  if (!response.ok) throw new Error(`AHledger price table ${marketId}: HTTP ${response.status}`);
  return parsePriceTable(marketId, await response.text());
}

/**
 * Header: `AHL1|market|unix time|row count`. Rows: item id, median, min buyout,
 * quantity, 7d median, 30d median, 30d low, 30d high. Empty means unknown.
 */
export function parsePriceTable(marketId: string, text: string): Market {
  const [header = '', ...rows] = text.split(/\r?\n/).filter(Boolean);
  const [, , unixTime] = header.split('|');
  const prices = new Map<number, PriceStats>();
  for (const row of rows) {
    const [id, median, min, quantity, median7d, median30d, low30d, high30d] = row.split(':');
    const stats: PriceStats = { quantity: Number(quantity) || 0 };
    assign(stats, 'median', median);
    assign(stats, 'min', min);
    assign(stats, 'median7d', median7d);
    assign(stats, 'median30d', median30d);
    assign(stats, 'low30d', low30d);
    assign(stats, 'high30d', high30d);
    prices.set(Number(id), stats);
  }
  const market: Market = {
    id: `ahledger:${marketId}`,
    label: `${marketId} (AHledger)`,
    source: 'ahledger',
    prices,
  };
  if (unixTime) market.observedAt = new Date(Number(unixTime) * 1000).toISOString();
  return market;
}

type NumericKey = 'median' | 'min' | 'median7d' | 'median30d' | 'low30d' | 'high30d';

function assign(stats: PriceStats, key: NumericKey, raw: string | undefined): void {
  if (raw !== undefined && raw !== '') stats[key] = Number(raw);
}
