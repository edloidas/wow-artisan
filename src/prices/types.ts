export type DailyPrice = { date: string; min: number; quantity?: number };

/** What one market knows about one item. All prices are copper per unit. */
export type PriceStats = {
  /** Cheapest listing in the latest scan. */
  min?: number;
  /** Median across all listed units in the latest scan; AHledger only. */
  median?: number;
  /** Units listed in the latest scan. */
  quantity: number;
  median7d?: number;
  median30d?: number;
  low30d?: number;
  high30d?: number;
  /** Per-day minimum from local scans; Auctionator only. */
  history?: DailyPrice[];
};

export type MarketSource = 'auctionator' | 'ahledger';

export type Market = {
  id: string;
  label: string;
  source: MarketSource;
  observedAt?: string;
  prices: Map<number, PriceStats>;
};
