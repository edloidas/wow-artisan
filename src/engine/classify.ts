import type { Market, PriceStats } from '../prices/types.ts';

export type Thresholds = {
  /** Fewer units listed than this makes a market thin. */
  thinQuantity: number;
  /** Max gap between the cheapest listing and the usual price, as a share of the usual price. */
  maxSpread: number;
  /** Max ratio between the highest and lowest price over the tracked period. */
  maxSwing: number;
  /** Max drift of the 7-day median away from the 30-day median, as a share. */
  maxTrend: number;
  /** Least share of recent full scans an item must appear on to count as a steady market. */
  minPresence: number;
  /** Least number of recent full scans an item must appear on, capped by how many exist. */
  minSeenScans: number;
};

export const DEFAULT_THRESHOLDS: Thresholds = {
  thinQuantity: 5,
  maxSpread: 0.35,
  maxSwing: 3,
  maxTrend: 0.4,
  minPresence: 0.5,
  minSeenScans: 3,
};

export type Scans = Pick<Market, 'latestScan' | 'fullScans'>;

/** Ordered from best to worst; a recipe takes the worst status of its parts. */
export const ITEM_STATUSES = ['stable', 'volatile', 'thin', 'none'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/** Why a market is weaker than steady, as data; `src/i18n` turns it into text. */
export type MarketIssue =
  | { kind: 'nothing-listed' }
  | { kind: 'missing-from-scan'; lastSeen: string }
  | { kind: 'few-seen'; quantity: number; date: string }
  | { kind: 'few-listed'; quantity: number }
  | { kind: 'short-supply'; need: number; listed: number }
  | { kind: 'rarely-scanned'; seen: number; scans: number }
  | { kind: 'undercut'; percent: number }
  | { kind: 'swing'; ratio: number }
  | { kind: 'trend'; percent: number };

export type Classification = { status: ItemStatus; reasons: MarketIssue[] };

const RECENT_DAYS = 7;
export const PRESENCE_WINDOW = 7;

/** The usual price: recent medians when known, else the median of recent daily minimums. */
export function referencePrice(stats: PriceStats | undefined): number | undefined {
  if (!stats) return undefined;
  if (stats.median7d !== undefined) return stats.median7d;
  if (stats.median !== undefined) return stats.median;
  const recent = (stats.history ?? []).slice(-RECENT_DAYS).map((day) => day.min);
  return median(recent) ?? stats.min;
}

/**
 * Least rise from the cheapest listing to the unit in the middle of the market, as a share of
 * the cheapest, when no listing median says how steep the ladder is. A guess: local scans keep
 * only the cheapest price, and listings above it are never all at that price.
 */
export const MIN_LADDER_RISE = 0.2;

export type AuctionBuy = {
  /** Copper per unit, averaged over every unit bought. */
  unit: number;
  /** Where prices start: the cheapest listing, or the usual price when that one is an outlier. */
  cheapest: number;
  /** Units on the market. */
  listed: number;
};

/**
 * What buying `units` costs per unit, averaged. Scans keep no price ladder, only the cheapest
 * listing and the units on offer, so the ladder is modelled: prices climb linearly from the
 * cheapest listing to the listing median (AHledger) at the middle unit, or to the usual price
 * and at least `MIN_LADDER_RISE` above the cheapest when no median is known. Units beyond what
 * is listed cost the top of the ladder. A cheapest listing far under the usual price is likely
 * a lone unit, so the ladder starts at the usual price instead.
 */
export function buyPrice(
  stats: PriceStats | undefined,
  units = 1,
  maxSpread = DEFAULT_THRESHOLDS.maxSpread,
): AuctionBuy | undefined {
  if (!stats || stats.quantity <= 0) return undefined;
  const reference = referencePrice(stats);
  const outlier =
    stats.min !== undefined &&
    reference !== undefined &&
    (reference - stats.min) / reference > maxSpread;
  const start = stats.min === undefined || outlier ? reference : stats.min;
  if (start === undefined) return undefined;
  const middle =
    stats.median !== undefined
      ? Math.max(stats.median, start)
      : Math.max(reference ?? start, start * (1 + MIN_LADDER_RISE));
  const listed = stats.quantity;
  if (units <= listed) {
    return { unit: start + ((middle - start) * units) / listed, cheapest: start, listed };
  }
  const top = 2 * middle - start;
  return { unit: (listed * middle + (units - listed) * top) / units, cheapest: start, listed };
}

/** What a new listing can ask: no more than the cheapest competitor or the usual price. */
export function sellPrice(stats: PriceStats | undefined): number | undefined {
  if (!stats || stats.quantity <= 0) return undefined;
  const candidates = [stats.min, referencePrice(stats)].filter((p): p is number => p !== undefined);
  return candidates.length > 0 ? Math.min(...candidates) : undefined;
}

/**
 * Why the market can't be counted on to hold enough units, or undefined when it can.
 * Local scans keep only the most units seen per day, and an item missing from the newest
 * scan keeps its old figures, so a stale item says nothing about what is listed now.
 */
export function availabilityProblem(
  stats: PriceStats,
  thresholds: Thresholds,
  latestScan?: string,
): MarketIssue | undefined {
  if (stats.lastSeen && latestScan && stats.lastSeen < latestScan) {
    return { kind: 'missing-from-scan', lastSeen: stats.lastSeen };
  }
  if (stats.quantity < thresholds.thinQuantity) {
    return stats.lastSeen
      ? { kind: 'few-seen', quantity: stats.quantity, date: stats.lastSeen }
      : { kind: 'few-listed', quantity: stats.quantity };
  }
  return undefined;
}

/** A batch that needs more units than the market shows; they are priced at the ladder's top. */
export function supplyProblem(need: number, listed: number): MarketIssue | undefined {
  return need > listed ? { kind: 'short-supply', need: Math.ceil(need), listed } : undefined;
}

/**
 * Why the item can't be called a steady market from how rarely the recent full scans saw it,
 * or undefined when it was seen often enough. Searches between scans don't count.
 */
export function presenceProblem(
  stats: PriceStats,
  thresholds: Thresholds,
  fullScans: string[] | undefined,
): MarketIssue | undefined {
  if (!fullScans || fullScans.length === 0) return undefined;
  const window = fullScans.slice(-PRESENCE_WINDOW);
  const days = new Set((stats.history ?? []).map((day) => day.date));
  const seen = window.filter((date) => days.has(date)).length;
  const tooFew = seen < Math.min(thresholds.minSeenScans, window.length);
  if (!tooFew && seen / window.length >= thresholds.minPresence) return undefined;
  return { kind: 'rarely-scanned', seen, scans: window.length };
}

export function classify(
  stats: PriceStats | undefined,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
  scans: Scans = {},
): Classification {
  if (!stats || stats.quantity <= 0 || (stats.min === undefined && stats.median === undefined)) {
    return { status: 'none', reasons: [{ kind: 'nothing-listed' }] };
  }
  const reasons: MarketIssue[] = [];
  let status: ItemStatus = 'stable';

  // Only a cheap outlier is a risk: a seller undercuts it. A cheapest listing above the
  // usual price changes nothing, because the sale price already takes the lower of the two.
  const reference = referencePrice(stats);
  if (reference && stats.min !== undefined) {
    const gap = (reference - stats.min) / reference;
    if (gap > thresholds.maxSpread) {
      status = 'volatile';
      reasons.push({ kind: 'undercut', percent: Math.round(gap * 100) });
    }
  }

  const swing = priceSwing(stats);
  if (swing !== undefined && swing > thresholds.maxSwing) {
    status = 'volatile';
    reasons.push({ kind: 'swing', ratio: swing });
  }

  if (stats.median7d && stats.median30d) {
    const trend = stats.median7d / stats.median30d - 1;
    if (Math.abs(trend) > thresholds.maxTrend) {
      status = 'volatile';
      reasons.push({ kind: 'trend', percent: Math.round(trend * 100) });
    }
  }

  const problem =
    availabilityProblem(stats, thresholds, scans.latestScan) ??
    presenceProblem(stats, thresholds, scans.fullScans);
  if (problem) {
    status = 'thin';
    reasons.push(problem);
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
