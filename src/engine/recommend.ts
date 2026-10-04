import type { Profession, Recipe } from '../gamedata/types.ts';
import {
  availabilityProblem,
  type ItemStatus,
  type MarketIssue,
  supplyProblem,
  worstStatus,
} from './classify.ts';
import { AUCTION_CUT, auctionParts, type Part, type Pricer, type SaleQuote } from './pricer.ts';

/**
 * Where a recipe's product goes and how healthy the markets it depends on are. `vendor` sells
 * to a merchant; the rest describe auction asking prices and supply, and none says the product
 * sells: no source records sales, so "steady" means steady asking prices and enough units.
 */
export type Category = 'steady' | 'vendor' | 'volatile' | 'thin' | 'no-market';

export type SaleIssue =
  | { kind: 'unsellable' }
  | { kind: 'vendor-beats-auction'; auctionNet: number; vendor: number };

/** A weak market behind a category: the product's, or a bought reagent's by item id. */
export type Reason = { item: 'product' | number; issue: MarketIssue | SaleIssue };

export type ListingWarning =
  | { kind: 'deposit-exceeds-sale'; deposit: number }
  | { kind: 'premium-under-deposit'; vendor: number; deposit: number };

export type RecipeFilter = {
  profession: Profession;
  /** Hide recipes that need more skill than this to learn. */
  maxSkill?: number;
  /** Hide recipes learnable below this skill. */
  minSkill?: number;
  /** Hide recipes taught by a plan item, keeping those a trainer teaches. */
  trainerOnly?: boolean;
};

export type Evaluation = {
  recipe: Recipe;
  /** Crafts the reagents are bought for; larger batches climb the auction price ladder. */
  batch: number;
  /** Copper for one craft, with every reagent bought or crafted at its cheapest for the batch. */
  cost: number;
  parts: Part[];
  sale: SaleQuote;
  /**
   * Copper per craft if every unit sells at the quoted price; undefined when the product
   * has no market and no vendor floor. Deposits are not included.
   */
  ifSold?: number;
  /** Copper per craft if every unit goes to a merchant. */
  ifVendored: number;
  /**
   * Auction rows only: copper per craft if the listing expires once, losing its deposit, and
   * the units then go to a merchant.
   */
  ifUnsold?: number;
  /** `ifSold` as a share of cost. */
  marginRatio?: number;
  /** Lowest auction asking price per unit that covers the cost after the cut. */
  breakEven: number;
  /** Deposit per unit for the listing hours; only for auction sales with a vendor price. */
  depositEstimate?: number;
  category: Category;
  /** Why the markets behind the category are weak. */
  reasons: Reason[];
  /** Deposit risks of listing, shown whatever the category. */
  warnings: ListingWarning[];
};

export type Recommendations = {
  groups: Record<Category, Evaluation[]>;
  /** Recipes skipped because a reagent has no price anywhere. */
  unpriced: number;
  /** Recipes skipped because the product binds on pickup and no vendor buys it. */
  bound: number;
  considered: number;
  /** Crafts the reagents were bought for. */
  batch: number;
};

export function selectRecipes(recipes: Recipe[], filter: RecipeFilter): Recipe[] {
  return recipes.filter(
    (r) =>
      r.profession === filter.profession &&
      (filter.maxSkill === undefined || r.learnSkill <= filter.maxSkill) &&
      (filter.minSkill === undefined || r.learnSkill >= filter.minSkill) &&
      !(filter.trainerOnly && r.planItemId !== undefined),
  );
}

export function evaluateRecipe(pricer: Pricer, recipe: Recipe, batch = 1): Evaluation | undefined {
  const crafted = pricer.craftCost(recipe, [], batch);
  if (crafted.unit === undefined) return undefined;
  const cost = crafted.unit * recipe.output.count;
  const parts = crafted.parts ?? [];
  const sale = pricer.sale(recipe.output.itemId);
  // Reagents are bought at today's price, so their history doesn't matter; only whether
  // the market holds enough of them does.
  const materialStatuses: ItemStatus[] = [];
  const reasons: Reason[] = [];
  for (const part of auctionParts(parts)) {
    const stats = pricer.ctx.market.prices.get(part.itemId);
    const problems: (MarketIssue | undefined)[] = stats
      ? [
          availabilityProblem(stats, pricer.ctx.thresholds, pricer.ctx.market.latestScan),
          supplyProblem(part.quote.units, stats.quantity),
        ]
      : [{ kind: 'nothing-listed' }];
    for (const issue of problems) {
      if (!issue) continue;
      materialStatuses.push('thin');
      reasons.push({ item: part.itemId, issue });
    }
  }

  const count = recipe.output.count;
  const base = {
    recipe,
    batch,
    cost,
    parts,
    sale,
    ifVendored: sale.vendor * count - cost,
    breakEven: cost / count / (1 - AUCTION_CUT),
    reasons,
    warnings: [] as ListingWarning[],
  };
  if (sale.unit === undefined) {
    reasons.unshift({ item: 'product', issue: { kind: 'unsellable' } });
    return { ...base, category: 'no-market' };
  }
  const ifSold = sale.unit * count - cost;
  const evaluation: Evaluation = { ...base, ifSold, category: 'vendor' };
  if (cost > 0) evaluation.marginRatio = ifSold / cost;

  if (sale.via === 'vendor') {
    if (sale.auctionNet !== undefined) {
      reasons.unshift({
        item: 'product',
        issue: { kind: 'vendor-beats-auction', auctionNet: sale.auctionNet, vendor: sale.vendor },
      });
    }
    return evaluation;
  }

  const deposit = pricer.depositEstimate(recipe.output.itemId);
  if (deposit !== undefined) evaluation.depositEstimate = deposit;
  evaluation.ifUnsold = evaluation.ifVendored - (deposit ?? 0) * count;
  evaluation.warnings = listingWarnings(evaluation, deposit);
  if (sale.classification.status !== 'stable') {
    reasons.unshift(
      ...sale.classification.reasons.map((issue): Reason => ({ item: 'product', issue })),
    );
  }
  evaluation.category = categoryOf(worstStatus([sale.classification.status, ...materialStatuses]));
  return evaluation;
}

/**
 * Deposit risks that only some auction rows carry. The loss from an unsold craft is in
 * `ifUnsold`; crafted gear vendors far under cost, so a warning would mark every row.
 */
function listingWarnings(e: Evaluation, deposit: number | undefined): ListingWarning[] {
  const ifSold = e.ifSold ?? 0;
  if (deposit === undefined || ifSold <= 0) return [];
  const listing = deposit * e.recipe.output.count;
  if (listing >= ifSold) {
    return [{ kind: 'deposit-exceeds-sale', deposit: listing }];
  }
  if (e.ifVendored > 0 && (e.sale.auctionNet ?? 0) - e.sale.vendor < deposit) {
    return [{ kind: 'premium-under-deposit', vendor: e.sale.vendor, deposit }];
  }
  return [];
}

function categoryOf(status: ItemStatus): Category {
  if (status === 'stable') return 'steady';
  if (status === 'volatile') return 'volatile';
  // A reagent with nothing listed can't be part of an evaluation, so this is thin stock.
  return 'thin';
}

export function recommend(
  pricer: Pricer,
  recipes: Recipe[],
  minProfit: number,
  batch = 1,
): Recommendations {
  const groups: Record<Category, Evaluation[]> = {
    steady: [],
    vendor: [],
    volatile: [],
    thin: [],
    'no-market': [],
  };
  let unpriced = 0;
  let bound = 0;
  for (const recipe of recipes) {
    const evaluation = evaluateRecipe(pricer, recipe, batch);
    if (!evaluation) {
      unpriced++;
    } else if (
      evaluation.sale.unit === undefined &&
      pricer.ctx.game.items[recipe.output.itemId]?.boundOnPickup
    ) {
      bound++;
    } else if (evaluation.category === 'no-market') {
      groups['no-market'].push(evaluation);
    } else if ((evaluation.ifSold ?? -Infinity) >= minProfit) {
      groups[evaluation.category].push(evaluation);
    }
  }
  for (const list of Object.values(groups)) {
    list.sort((a, b) => (b.ifSold ?? -b.cost) - (a.ifSold ?? -a.cost));
  }
  groups['no-market'].sort((a, b) => a.cost - b.cost);
  return { groups, unpriced, bound, considered: recipes.length, batch };
}
