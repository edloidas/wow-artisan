import type { Profession, Recipe } from '../gamedata/types.ts';
import { availabilityProblem, type ItemStatus, worstStatus } from './classify.ts';
import { AUCTION_CUT, auctionParts, type Part, type Pricer, type SaleQuote } from './pricer.ts';

/**
 * Health of the markets a recipe depends on. None of these says the product sells:
 * no source records sales, so "steady" means steady asking prices and enough units.
 */
export type Category = 'steady' | 'volatile' | 'thin' | 'no-market';

export type RecipeFilter = {
  profession: Profession;
  /** Hide recipes that need more skill than this to learn. */
  maxSkill?: number;
  /** Hide recipes learnable below this skill. */
  minSkill?: number;
};

export type Evaluation = {
  recipe: Recipe;
  /** Copper for one craft, with every reagent bought or crafted at its cheapest. */
  cost: number;
  parts: Part[];
  sale: SaleQuote;
  /**
   * Copper per craft if every unit sells at the quoted price; undefined when the product
   * has no market and no vendor floor. Deposits are not included.
   */
  ifSold?: number;
  /** `ifSold` as a share of cost. */
  marginRatio?: number;
  /** Lowest asking price per unit that covers the cost after the auction cut. */
  breakEven: number;
  /** Deposit per unit for a 24h listing, estimated from the vendor price; unverified. */
  depositEstimate: number;
  category: Category;
  reasons: string[];
};

export type Recommendations = {
  groups: Record<Category, Evaluation[]>;
  /** Recipes skipped because a reagent has no price anywhere. */
  unpriced: number;
  /** Recipes skipped because the product binds on pickup and no vendor buys it. */
  bound: number;
  considered: number;
};

export function selectRecipes(recipes: Recipe[], filter: RecipeFilter): Recipe[] {
  return recipes.filter(
    (r) =>
      r.profession === filter.profession &&
      (filter.maxSkill === undefined || r.learnSkill <= filter.maxSkill) &&
      (filter.minSkill === undefined || r.learnSkill >= filter.minSkill),
  );
}

export function evaluateRecipe(pricer: Pricer, recipe: Recipe): Evaluation | undefined {
  const crafted = pricer.craftCost(recipe);
  if (crafted.unit === undefined) return undefined;
  const cost = crafted.unit * recipe.output.count;
  const parts = crafted.parts ?? [];
  const sale = pricer.sale(recipe.output.itemId);
  // Reagents are bought at today's price, so their history doesn't matter; only whether
  // the market holds enough of them does.
  const materialStatuses: ItemStatus[] = [];
  const reasons: string[] = [];
  for (const part of auctionParts(parts)) {
    const stats = pricer.ctx.market.prices.get(part.itemId);
    const problem = stats
      ? availabilityProblem(stats, pricer.ctx.thresholds, pricer.ctx.market.latestScan)
      : 'nothing listed';
    if (problem) {
      materialStatuses.push('thin');
      reasons.push(`${pricer.name(part.itemId)}: ${problem}`);
    }
  }

  const base = {
    recipe,
    cost,
    parts,
    sale,
    breakEven: cost / recipe.output.count / (1 - AUCTION_CUT),
    depositEstimate: pricer.depositEstimate(recipe.output.itemId),
  };
  if (sale.unit === undefined) {
    return {
      ...base,
      category: 'no-market',
      reasons: ['product: nothing listed, no vendor price'],
    };
  }
  const ifSold = sale.unit * recipe.output.count - cost;
  const evaluation: Evaluation = { ...base, ifSold, category: 'steady', reasons };
  if (cost > 0) evaluation.marginRatio = ifSold / cost;

  // A vendor sale has no market risk, so only the product's own auction market counts.
  const productStatuses: ItemStatus[] = sale.via === 'auction' ? [sale.classification.status] : [];
  if (sale.via === 'auction' && sale.classification.status !== 'stable') {
    reasons.unshift(...sale.classification.reasons.map((r) => `product: ${r}`));
  }
  if (sale.via === 'vendor' && sale.classification.status === 'none') {
    reasons.unshift('product: sold to vendor, nothing listed on the auction house');
  }
  evaluation.category = categoryOf(worstStatus([...productStatuses, ...materialStatuses]));
  return evaluation;
}

function categoryOf(status: ItemStatus): Category {
  if (status === 'stable') return 'steady';
  if (status === 'volatile') return 'volatile';
  // A reagent with nothing listed can't be part of an evaluation, so this is thin stock.
  return 'thin';
}

export function recommend(pricer: Pricer, recipes: Recipe[], minProfit: number): Recommendations {
  const groups: Record<Category, Evaluation[]> = {
    steady: [],
    volatile: [],
    thin: [],
    'no-market': [],
  };
  let unpriced = 0;
  let bound = 0;
  for (const recipe of recipes) {
    const evaluation = evaluateRecipe(pricer, recipe);
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
  return { groups, unpriced, bound, considered: recipes.length };
}
