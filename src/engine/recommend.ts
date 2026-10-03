import type { Profession, Recipe } from '../gamedata/types.ts';
import { type ItemStatus, worstStatus } from './classify.ts';
import { auctionParts, type Part, type Pricer, type SaleQuote } from './pricer.ts';

export type Category = 'reliable' | 'risky' | 'thin' | 'no-market';

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
  /** Copper per craft; undefined when the product has no market and no vendor floor. */
  profit?: number;
  margin?: number;
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
    const listed = pricer.ctx.market.prices.get(part.itemId)?.quantity ?? 0;
    if (listed < pricer.ctx.thresholds.thinQuantity) {
      materialStatuses.push('thin');
      reasons.push(`${pricer.name(part.itemId)}: only ${listed} listed`);
    }
  }

  if (sale.unit === undefined) {
    return {
      recipe,
      cost,
      parts,
      sale,
      category: 'no-market',
      reasons: ['product: nothing listed, no vendor price'],
    };
  }
  const profit = sale.unit * recipe.output.count - cost;
  const evaluation: Evaluation = {
    recipe,
    cost,
    parts,
    sale,
    profit,
    category: 'reliable',
    reasons,
  };
  if (cost > 0) evaluation.margin = profit / cost;

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
  if (status === 'stable') return 'reliable';
  if (status === 'volatile') return 'risky';
  // A reagent with nothing listed can't be part of an evaluation, so this is thin stock.
  return 'thin';
}

export function recommend(pricer: Pricer, recipes: Recipe[], minProfit: number): Recommendations {
  const groups: Record<Category, Evaluation[]> = {
    reliable: [],
    risky: [],
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
    } else if ((evaluation.profit ?? -Infinity) >= minProfit) {
      groups[evaluation.category].push(evaluation);
    }
  }
  for (const list of Object.values(groups)) {
    list.sort((a, b) => (b.profit ?? -b.cost) - (a.profit ?? -a.cost));
  }
  groups['no-market'].sort((a, b) => a.cost - b.cost);
  return { groups, unpriced, bound, considered: recipes.length };
}
