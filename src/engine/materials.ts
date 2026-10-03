import type { Part, Pricer, SaleQuote } from './pricer.ts';
import type { Category, Evaluation, Recommendations } from './recommend.ts';

export type Holding = { itemId: number; quantity: number };

export type HoldingSale = Holding & {
  name: string;
  sale: SaleQuote;
  /** Copper for selling the whole stack at today's price. */
  sellTotal?: number;
  /** Units on the market (most seen on `lastSeen` for local scans); selling far more moves the price. */
  marketQuantity: number;
  lastSeen?: string;
};

/**
 * A recipe evaluated with the holdings priced at what selling them nets, so `ifSold` is what
 * one craft earns above selling the holdings it uses.
 */
export type HeldUse = Evaluation & {
  /** Units of each holding one craft uses, through intermediates crafted from them. */
  consumes: Map<number, number>;
  /** Whole crafts the holdings cover; nothing is bought to make more. */
  crafts: number;
  /** `ifSold` over all crafts: copper above selling the holdings those crafts use. */
  gain: number;
};

export type MaterialsReport = {
  holdings: HoldingSale[];
  /** Uses of the holdings by category. They compete for the same units, so totals don't add up. */
  groups: Record<Exclude<Category, 'no-market'>, HeldUse[]>;
};

export function holdingSale(pricer: Pricer, holding: Holding): HoldingSale {
  const sale = pricer.sale(holding.itemId);
  const stats = pricer.ctx.market.prices.get(holding.itemId);
  const report: HoldingSale = {
    ...holding,
    name: pricer.name(holding.itemId),
    sale,
    marketQuantity: stats?.quantity ?? 0,
  };
  if (sale.unit !== undefined) report.sellTotal = sale.unit * holding.quantity;
  if (stats?.lastSeen) report.lastSeen = stats.lastSeen;
  return report;
}

/** Units of each held item one craft uses, following crafted intermediates down to them. */
export function heldPerCraft(
  parts: Part[],
  multiplier = 1,
  into = new Map<number, number>(),
): Map<number, number> {
  for (const part of parts) {
    const units = part.count * multiplier;
    if (part.quote.source === 'held') {
      into.set(part.itemId, (into.get(part.itemId) ?? 0) + units);
    } else if (part.quote.source === 'craft' && part.quote.recipe) {
      heldPerCraft(part.quote.parts ?? [], units / part.quote.recipe.output.count, into);
    }
  }
  return into;
}

/** Keeps the evaluations that use a holding, with how many crafts the holdings cover. */
export function heldUses(result: Recommendations, holdings: Holding[]): MaterialsReport['groups'] {
  const quantities = new Map(holdings.map((h) => [h.itemId, h.quantity]));
  const groups: MaterialsReport['groups'] = { steady: [], vendor: [], volatile: [], thin: [] };
  for (const category of Object.keys(groups) as (keyof typeof groups)[]) {
    for (const evaluation of result.groups[category]) {
      const consumes = heldPerCraft(evaluation.parts);
      if (consumes.size === 0) continue;
      // Intermediates that yield several units can make the need fractional; the epsilon
      // keeps an exact fit from rounding down.
      const crafts = Math.min(
        ...[...consumes].map(([itemId, need]) =>
          Math.floor((quantities.get(itemId) ?? 0) / need + 1e-9),
        ),
      );
      if (crafts < 1) continue;
      groups[category].push({
        ...evaluation,
        consumes,
        crafts,
        gain: (evaluation.ifSold ?? 0) * crafts,
      });
    }
    groups[category].sort((a, b) => b.gain - a.gain);
  }
  return groups;
}
