import type { PriceStats } from '../prices/types.ts';

export type Thresholds = {
  /** Fewer units listed than this makes a market thin. */
  thinQuantity: number;
  /** Max gap between the cheapest listing and the usual price, as a share of the usual price. */
  maxSpread: number;
  /** Max ratio between the highest and lowest price over the tracked period. */
  maxSwing: number;
  /** Max drift of the 7-day median away from the 30-day median, as a share. */
  maxTrend: number;
};

export const DEFAULT_THRESHOLDS: Thresholds = {
  thinQuantity: 5,
  maxSpread: 0.35,
  maxSwing: 3,
  maxTrend: 0.4,
};

/** Ordered from best to worst; a recipe takes the worst status of its parts. */
export const ITEM_STATUSES = ['stable', 'volatile', 'thin', 'none'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export type Classification = { status: ItemStatus; reasons: string[] };

const RECENT_DAYS = 7;

/** The usual price: recent medians when known, else the median of recent daily minimums. */
export function referencePrice(stats: PriceStats | undefined): number | undefined {
  if (!stats) return undefined;
  if (stats.median7d !== undefined) return stats.median7d;
  if (stats.median !== undefined) return stats.median;
  const recent = (stats.history ?? []).slice(-RECENT_DAYS).map((day) => day.min);
  return median(recent) ?? stats.min;
}

/** What buying a handful of units costs right now. */
export function buyPrice(stats: PriceStats | undefined): number | undefined {
  if (!stats || stats.quantity <= 0) return undefined;
  if (stats.median !== undefined) return stats.median;
  const reference = referencePrice(stats);
  if (stats.min === undefined) return reference;
  return reference === undefined ? stats.min : Math.max(stats.min, reference);
}

/** What a new listing can ask: no more than the cheapest competitor or the usual price. */
export function sellPrice(stats: PriceStats | undefined): number | undefined {
  if (!stats || stats.quantity <= 0) return undefined;
  const candidates = [stats.min, referencePrice(stats)].filter((p): p is number => p !== undefined);
  return candidates.length > 0 ? Math.min(...candidates) : undefined;
}

export function classify(
  stats: PriceStats | undefined,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): Classification {
  if (!stats || stats.quantity <= 0 || (stats.min === undefined && stats.median === undefined)) {
    return { status: 'none', reasons: ['nothing listed'] };
  }
  const reasons: string[] = [];
  let status: ItemStatus = 'stable';

  const reference = referencePrice(stats);
  if (reference && stats.min !== undefined) {
    const gap = (reference - stats.min) / reference;
    if (Math.abs(gap) > thresholds.maxSpread) {
      status = 'volatile';
      const direction = gap > 0 ? 'under' : 'over';
      reasons.push(`cheapest is ${Math.round(Math.abs(gap) * 100)}% ${direction} the usual price`);
    }
  }

  const swing = priceSwing(stats);
  if (swing !== undefined && swing > thresholds.maxSwing) {
    status = 'volatile';
    reasons.push(`price swung ${swing.toFixed(1)}x over the period`);
  }

  if (stats.median7d && stats.median30d) {
    const trend = stats.median7d / stats.median30d - 1;
    if (Math.abs(trend) > thresholds.maxTrend) {
      status = 'volatile';
      const sign = trend > 0 ? '+' : '';
      reasons.push(`7-day median ${sign}${Math.round(trend * 100)}% vs 30-day`);
    }
  }

  if (stats.quantity < thresholds.thinQuantity) {
    status = 'thin';
    reasons.push(`only ${stats.quantity} listed`);
  }
  return { status, reasons };
}

export function worstStatus(statuses: ItemStatus[]): ItemStatus {
  return statuses.reduce<ItemStatus>(
    (worst, s) => (ITEM_STATUSES.indexOf(s) > ITEM_STATUSES.indexOf(worst) ? s : worst),
    'stable',
  );
}

function priceSwing(stats: PriceStats): number | undefined {
  if (stats.low30d && stats.high30d) return stats.high30d / stats.low30d;
  const mins = (stats.history ?? []).map((day) => day.min).filter((p) => p > 0);
  if (mins.length < 2) return undefined;
  return Math.max(...mins) / Math.min(...mins);
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}
