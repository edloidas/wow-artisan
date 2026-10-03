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
    ifSold: e.ifSold === undefined ? undefined : Math.round(e.ifSold),
    marginRatio: e.marginRatio === undefined ? undefined : Math.round(e.marginRatio * 100) / 100,
    breakEven: Math.ceil(e.breakEven),
    depositEstimate: Math.round(e.depositEstimate),
    productMarket: supplyJson(pricer, e.recipe.output.itemId),
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
      'Prices are copper per unit (10000 = 1g).',
      'ifSold is copper per craft if every unit sells at sellUnit, after the 5% auction cut. No source records sales, so it is not a forecast; categories describe asking prices and supply only.',
      'Deposits are not included; depositEstimate is 15% of the vendor price per unit for 24h and is unverified.',
      'breakEven is the lowest asking price per unit that covers the cost after the cut.',
      'Auction prices for ahledger markets: data by AHledger (https://ahledger.com).',
    ],
  };
}

/** Units on the market, and for local scans which day that count is from. */
export function supplyJson(pricer: Pricer, itemId: number) {
  const stats = pricer.ctx.market.prices.get(itemId);
  return {
    units: stats?.quantity ?? 0,
    unitsAre: stats?.lastSeen ? 'most seen on lastSeen' : 'listed now',
    lastSeen: stats?.lastSeen,
    observedDays: stats?.history?.length,
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
    marketUnits: report.marketQuantity,
    marketUnitsAre: report.lastSeen ? 'most seen on lastSeen' : 'listed now',
    lastSeen: report.lastSeen,
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
      cappedAtMarketUnits: use.capped,
      total: Math.round(use.total),
      totalWithRest: use.totalWithRest === undefined ? undefined : Math.round(use.totalWithRest),
      otherReagentsCost: Math.round(use.otherReagentsCost),
      route: use.route,
      productMarket: use.status,
    })),
  };
}
