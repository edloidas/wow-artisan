export type DailyPrice = { date: string; min: number; quantity?: number };

/** What one market knows about one item. All prices are copper per unit. */
export type PriceStats = {
  /** Cheapest listing in the latest scan. */
  min?: number;
  /** Median across all listed units in the latest scan; AHledger only. */
  median?: number;
  /** Units listed now (AHledger), or the most seen on `lastSeen` (Auctionator). */
  quantity: number;
  median7d?: number;
  median30d?: number;
  low30d?: number;
  high30d?: number;
  /** Per-day minimum from local scans; Auctionator only. */
  history?: DailyPrice[];
  /**
   * Day of the last scan that saw the item; Auctionator only. On those scans
   * `quantity` is the most units seen that day, not what is listed now.
   */
  lastSeen?: string;
};

export type MarketSource = 'auctionator' | 'ahledger';

export type Market = {
  id: string;
  label: string;
  source: MarketSource;
  observedAt?: string;
  /** Day of the newest local scan; an item last seen before it was missing from that scan. */
  latestScan?: string;
  prices: Map<number, PriceStats>;
};
