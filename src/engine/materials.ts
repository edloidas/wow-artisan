import type { Recipe } from '../gamedata/types.ts';
import { type CostQuote, type Part, Pricer, type SaleQuote } from './pricer.ts';
import {
  type Category,
  type Evaluation,
  evaluateRecipe,
  type Recommendations,
  recommend,
} from './recommend.ts';

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
  for (const part of parts) addHeld(part.itemId, part.count * multiplier, part.quote, into);
  return into;
}

function addHeld(itemId: number, units: number, quote: CostQuote, into: Map<number, number>) {
  if (quote.source === 'held') {
    const share = quote.rest ? (quote.held ?? 0) / quote.units : 1;
    into.set(itemId, (into.get(itemId) ?? 0) + units * share);
    if (quote.rest) addHeld(itemId, units * (1 - share), quote.rest, into);
  } else if (quote.source === 'auction' && quote.rest) {
    addHeld(itemId, (units * quote.rest.units) / quote.units, quote.rest, into);
  } else if (quote.source === 'craft' && quote.recipe) {
    // Whole crafts: units made beyond the need use holdings too.
    const crafts = quote.crafts ?? quote.units / quote.recipe.output.count;
    heldPerCraft(quote.parts ?? [], (units * crafts) / quote.units, into);
  }
}

/** One holding per item, quantities summed. */
export function mergeHoldings(holdings: Holding[]): Holding[] {
  const quantities = new Map<number, number>();
  for (const h of holdings) quantities.set(h.itemId, (quantities.get(h.itemId) ?? 0) + h.quantity);
  return [...quantities].map(([itemId, quantity]) => ({ itemId, quantity }));
}

/** Whole crafts the holdings cover; an exact fit with fractional needs must not round down. */
function coverage(consumes: Map<number, number>, quantities: Map<number, number>): number {
  return Math.min(
    ...[...consumes].map(([itemId, need]) =>
      Math.floor((quantities.get(itemId) ?? 0) / need + 1e-9),
    ),
  );
}

/** Batches tried before settling on the best one covered. */
const MAX_ROUNDS = 8;

/**
 * One craft of each recipe with the holdings free and unlimited: every recipe whose route can
 * reach a holding does, which seeds `heldUses`. A route that buys at one craft can switch to a
 * holding at scale, so seeding from real prices would miss it.
 */
export function heldCandidates(pricer: Pricer, recipes: Recipe[]): Recommendations {
  const free = new Map([...(pricer.ctx.held ?? [])].map(([itemId]) => [itemId, Infinity]));
  return recommend(new Pricer({ ...pricer.ctx, held: free, freeHeld: true }), recipes, -Infinity);
}

/**
 * Keeps the evaluations that use a holding, re-evaluated by `pricer` for the crafts the holdings
 * cover, with the other reagents bought for all of them. `result` seeds the candidates and their
 * first batch, normally from `heldCandidates`.
 */
export function heldUses(
  pricer: Pricer,
  result: Recommendations,
  holdings: Holding[],
  minProfit: number,
): MaterialsReport['groups'] {
  const quantities = new Map(mergeHoldings(holdings).map((h) => [h.itemId, h.quantity]));
  const groups: MaterialsReport['groups'] = { steady: [], vendor: [], volatile: [], thin: [] };
  for (const category of Object.keys(groups) as (keyof typeof groups)[]) {
    for (const single of result.groups[category]) {
      const first = heldPerCraft(single.parts);
      if (first.size === 0) continue;
      const use = settle(pricer, single.recipe, coverage(first, quantities), quantities);
      if (!use || use.category === 'no-market') continue;
      if ((use.ifSold ?? -Infinity) < minProfit) continue;
      groups[use.category].push(use);
    }
  }
  for (const list of Object.values(groups)) list.sort((a, b) => b.gain - a.gain);
  return groups;
}

/**
 * The recipe evaluated for the batch the holdings cover. The seed batch is a guess: two branches
 * drawing on one holding can need more than is held, and whole crafts of a multi-unit
 * intermediate need less per craft at scale. The batch moves to what the evaluation covers until
 * the two agree, keeping the best covered batch seen.
 */
function settle(
  pricer: Pricer,
  recipe: Recipe,
  batch: number,
  quantities: Map<number, number>,
): HeldUse | undefined {
  let best: HeldUse | undefined;
  const tried = new Set<number>();
  while (batch >= 1 && !tried.has(batch) && tried.size < MAX_ROUNDS) {
    tried.add(batch);
    const evaluation = evaluateRecipe(pricer, recipe, batch);
    if (!evaluation) break;
    const consumes = heldPerCraft(evaluation.parts);
    if (consumes.size === 0) break;
    const covered = coverage(consumes, quantities);
    const gain = (evaluation.ifSold ?? 0) * batch;
    if (covered >= batch && (!best || gain > best.gain)) {
      best = { ...evaluation, consumes, crafts: batch, gain };
    }
    batch = covered;
  }
  return best;
}
