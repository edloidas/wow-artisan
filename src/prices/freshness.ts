import type { Market } from './types.ts';

/** Scans this many days old or more are stale; prices on a young realm move daily. */
export const STALE_SCAN_DAYS = 2;
const DAY_MS = 86_400_000;

export type Freshness = { latestScan?: string; scanAgeDays?: number; stale: boolean };

/**
 * Age of the newest full scan in whole days. Auctionator counts scan days from the
 * client's local midnight, so "today" is the local calendar date, not the UTC one.
 */
export function marketFreshness(market: Market, now = new Date()): Freshness {
  if (!market.latestScan) return { stale: false };
  const [year = 0, month = 1, day = 1] = market.latestScan.split('-').map(Number);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const scanAgeDays = Math.max(0, Math.round((today - Date.UTC(year, month - 1, day)) / DAY_MS));
  return { latestScan: market.latestScan, scanAgeDays, stale: scanAgeDays >= STALE_SCAN_DAYS };
}
