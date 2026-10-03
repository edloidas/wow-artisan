import type { Recipe } from '../gamedata/types.ts';
import type { ItemStatus } from './classify.ts';
import type { Pricer, SaleQuote } from './pricer.ts';

/** How many crafting steps to follow: ore -> bar -> item is two. */
const MAX_CHAIN = 2;

export type Holding = { itemId: number; quantity: number };

export type Use = {
  recipe: Recipe;
  /** Copper each unit of the material earns through this recipe. */
  perUnit: number;
  /** Units this recipe consumes per craft. */
  need: number;
  crafts: number;
  /** True when crafts were cut to what the product's market currently lists. */
  capped: boolean;
  /** Units of the material the product's market can take through this recipe. */
  absorbableUnits: number;
  /** Copper for all crafts, after paying for the other reagents. */
  total: number;
  /** `total` plus selling the units the crafts don't consume. */
  totalWithRest?: number;
  /** How the product leaves: sold, or crafted further. */
  route: string;
  status: ItemStatus;
  otherReagentsCost: number;
};

export type MaterialReport = {
  itemId: number;
  name: string;
  quantity: number;
  sale: SaleQuote;
  /** Copper for selling the whole stack at today's price. */
  sellTotal?: number;
  /** Units on the market (most seen on `lastSeen` for local scans); selling far more moves the price. */
  marketQuantity: number;
  lastSeen?: string;
  uses: Use[];
};

/** `cap` is how many units the market will plausibly take: its listed stock, or unlimited for vendors. */
type Value = { unit: number; route: string; status: ItemStatus; cap: number };

export class MaterialAdvisor {
  private readonly consumers = new Map<number, Recipe[]>();
  private readonly values = new Map<string, Value | undefined>();

  constructor(
    private readonly pricer: Pricer,
    recipes: Recipe[],
  ) {
    for (const recipe of recipes) {
      for (const reagent of recipe.reagents) {
        const list = this.consumers.get(reagent.itemId) ?? [];
        list.push(recipe);
        this.consumers.set(reagent.itemId, list);
      }
    }
  }

  report(holding: Holding, limit = 5): MaterialReport {
    const { itemId, quantity } = holding;
    const sale = this.pricer.sale(itemId);
    const stats = this.pricer.ctx.market.prices.get(itemId);
    const uses = (this.consumers.get(itemId) ?? [])
      .map((recipe) => this.use(recipe, itemId, quantity, 0))
      .filter((use): use is Use => use !== undefined)
      .sort((a, b) => b.perUnit - a.perUnit)
      .slice(0, limit);
    const report: MaterialReport = {
      itemId,
      name: this.pricer.name(itemId),
      quantity,
      sale,
      marketQuantity: stats?.quantity ?? 0,
      uses,
    };
    if (stats?.lastSeen) report.lastSeen = stats.lastSeen;
    if (sale.unit !== undefined) {
      const unit = sale.unit;
      report.sellTotal = unit * quantity;
      for (const use of uses)
        use.totalWithRest = use.total + (quantity - use.crafts * use.need) * unit;
    }
    return report;
  }

  private use(recipe: Recipe, itemId: number, quantity: number, depth: number): Use | undefined {
    const need = recipe.reagents.find((r) => r.itemId === itemId)?.count ?? 0;
    if (need === 0) return undefined;
    let otherReagentsCost = 0;
    for (const reagent of recipe.reagents) {
      if (reagent.itemId === itemId) continue;
      const unit = this.pricer.cost(reagent.itemId).unit;
      if (unit === undefined) return undefined;
      otherReagentsCost += unit * reagent.count;
    }
    const product = this.value(recipe.output.itemId, depth + 1);
    if (!product) return undefined;
    const perCraft = product.unit * recipe.output.count - otherReagentsCost;
    const possible = Math.floor(quantity / need);
    const absorbable = Math.max(1, Math.floor(product.cap / recipe.output.count));
    const crafts = Math.min(possible, absorbable);
    return {
      recipe,
      perUnit: perCraft / need,
      need,
      crafts,
      capped: crafts < possible,
      absorbableUnits: absorbable * need,
      total: perCraft * crafts,
      route: product.route,
      status: product.status,
      otherReagentsCost,
    };
  }

  /** Best copper per unit of an item: sell it, or turn it into something worth more. */
  private value(itemId: number, depth: number): Value | undefined {
    const key = `${itemId}:${depth}`;
    if (this.values.has(key)) return this.values.get(key);
    const sale = this.pricer.sale(itemId);
    let best: Value | undefined =
      sale.unit === undefined
        ? undefined
        : {
            unit: sale.unit,
            route: `sell ${this.pricer.name(itemId)} (${sale.via})`,
            status: sale.via === 'auction' ? sale.classification.status : 'stable',
            cap:
              sale.via === 'auction'
                ? (this.pricer.ctx.market.prices.get(itemId)?.quantity ?? 0)
                : Number.POSITIVE_INFINITY,
          };
    if (depth < MAX_CHAIN) {
      for (const recipe of this.consumers.get(itemId) ?? []) {
        const use = this.use(recipe, itemId, 1, depth);
        if (use && (!best || use.perUnit > best.unit)) {
          best = {
            unit: use.perUnit,
            route: `${recipe.name} -> ${use.route}`,
            status: use.status,
            cap: use.absorbableUnits,
          };
        }
      }
    }
    this.values.set(key, best);
    return best;
  }
}
