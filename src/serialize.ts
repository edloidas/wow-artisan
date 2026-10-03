import type { Classification } from './engine/classify.ts';
import type { MaterialReport } from './engine/materials.ts';
import type { CostQuote, Part, Pricer } from './engine/pricer.ts';
import type { Category, Evaluation, Recommendations } from './engine/recommend.ts';
import type { Market } from './prices/types.ts';

export type MaterialLine = {
  itemId: number;
  name: string;
  count: number;
  unitCost?: number;
  source: CostQuote['source'];
  craftedWith?: string;
};

export function marketJson(market: Market) {
  return {
    id: market.id,
    label: market.label,
    source: market.source,
    observedAt: market.observedAt,
    items: market.prices.size,
  };
}

export function partsJson(pricer: Pricer, parts: Part[]): MaterialLine[] {
  return parts.map((part) => {
    const line: MaterialLine = {
      itemId: part.itemId,
      name: pricer.name(part.itemId),
      count: part.count,
      source: part.quote.source,
    };
    if (part.quote.unit !== undefined) line.unitCost = Math.round(part.quote.unit);
    if (part.quote.recipe) line.craftedWith = part.quote.recipe.name;
    return line;
  });
}

export function evaluationJson(pricer: Pricer, e: Evaluation) {
  return {
    recipe: e.recipe.name,
    spellId: e.recipe.spellId,
    product: {
      itemId: e.recipe.output.itemId,
      name: pricer.name(e.recipe.output.itemId),
      count: e.recipe.output.count,
    },
    learnSkill: e.recipe.learnSkill,
    learnSkillExact: e.recipe.learnSkillExact,
    yellow: e.recipe.yellow,
    grey: e.recipe.grey,
    category: e.category,
    cost: Math.round(e.cost),
    sellUnit: e.sale.unit === undefined ? undefined : Math.round(e.sale.unit),
    sellVia: e.sale.via,
    profit: e.profit === undefined ? undefined : Math.round(e.profit),
    margin: e.margin === undefined ? undefined : Math.round(e.margin * 100) / 100,
    listed: pricer.ctx.market.prices.get(e.recipe.output.itemId)?.quantity ?? 0,
    reasons: e.reasons,
    materials: partsJson(pricer, e.parts),
  };
}

export function recommendationsJson(pricer: Pricer, r: Recommendations, limit: number) {
  const groups = Object.fromEntries(
    (Object.entries(r.groups) as [Category, Evaluation[]][]).map(([category, list]) => [
      category,
      { total: list.length, top: list.slice(0, limit).map((e) => evaluationJson(pricer, e)) },
    ]),
  );
  return {
    market: marketJson(pricer.ctx.market),
    considered: r.considered,
    unpriced: r.unpriced,
    boundOnPickup: r.bound,
    groups,
    notes: [
      'Prices are copper per unit (10000 = 1g). Profit is per craft after the 5% auction cut and an estimated deposit.',
      'Auction prices for ahledger markets: data by AHledger (https://ahledger.com).',
    ],
  };
}

export function classificationJson(c: Classification) {
  return { status: c.status, reasons: c.reasons };
}

export function materialReportJson(report: MaterialReport) {
  return {
    itemId: report.itemId,
    name: report.name,
    quantity: report.quantity,
    marketQuantity: report.marketQuantity,
    sell: {
      unit: report.sale.unit === undefined ? undefined : Math.round(report.sale.unit),
      via: report.sale.via,
      total: report.sellTotal === undefined ? undefined : Math.round(report.sellTotal),
      market: classificationJson(report.sale.classification),
    },
    uses: report.uses.map((use) => ({
      recipe: use.recipe.name,
      perUnit: Math.round(use.perUnit),
      need: use.need,
      crafts: use.crafts,
      cappedByMarket: use.capped,
      total: Math.round(use.total),
      totalWithRest: use.totalWithRest === undefined ? undefined : Math.round(use.totalWithRest),
      otherReagentsCost: Math.round(use.otherReagentsCost),
      route: use.route,
      productMarket: use.status,
    })),
  };
}
