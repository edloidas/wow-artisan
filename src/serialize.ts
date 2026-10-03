import { type Classification, PRESENCE_WINDOW } from './engine/classify.ts';
import type { HeldUse, MaterialsReport } from './engine/materials.ts';
import {
  type CostQuote,
  DEPOSIT_RATES,
  type ListingHours,
  type Part,
  type Pricer,
  type SaleQuote,
} from './engine/pricer.ts';
import type { Category, Evaluation, Recommendations } from './engine/recommend.ts';
import { marketFreshness } from './prices/freshness.ts';
import type { Market } from './prices/types.ts';

export type MaterialLine = {
  itemId: number;
  name: string;
  count: number;
  unitCost?: number;
  source: CostQuote['source'];
  craftedWith?: string;
};

export function marketJson(market: Market, now = new Date()) {
  return {
    id: market.id,
    label: market.label,
    source: market.source,
    observedAt: market.observedAt,
    ...marketFreshness(market, now),
    fullScans: market.fullScans?.length,
    items: market.prices.size,
  };
}

/** Warnings an agent must pass on before using any figure in the payload. */
export function marketWarnings(market: Market, now = new Date()): string[] {
  const { stale, scanAgeDays } = marketFreshness(market, now);
  return stale
    ? [`Prices are ${scanAgeDays} days old; ask the player to scan the auction house and /reload.`]
    : [];
}

function copper(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.round(value);
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
    learnedFrom: e.recipe.planItemId === undefined ? 'trainer' : 'plan',
    planItemId: e.recipe.planItemId,
    yellow: e.recipe.yellow,
    grey: e.recipe.grey,
    category: e.category,
    cost: Math.round(e.cost),
    sellVia: e.sale.via,
    listUnit: copper(e.sale.auctionGross),
    netUnit: copper(e.sale.unit),
    vendorUnit: e.sale.vendor,
    ifSold: copper(e.ifSold),
    ifVendored: Math.round(e.ifVendored),
    ifUnsold: copper(e.ifUnsold),
    marginRatio: e.marginRatio === undefined ? undefined : Math.round(e.marginRatio * 100) / 100,
    breakEven: e.category === 'vendor' ? undefined : Math.ceil(e.breakEven),
    depositEstimate: copper(e.depositEstimate),
    warnings: e.warnings,
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
  const hours = pricer.listingHours;
  return {
    market: marketJson(pricer.ctx.market),
    warnings: marketWarnings(pricer.ctx.market),
    listingHours: hours,
    considered: r.considered,
    unpriced: r.unpriced,
    boundOnPickup: r.bound,
    groups,
    notes: evaluationNotes(hours),
  };
}

function evaluationNotes(hours: ListingHours): string[] {
  return [
    'Prices are copper per unit (10000 = 1g); cost, ifSold and ifVendored are per craft.',
    'listUnit is the auction asking price per unit, before the 5% cut: the number to list at. netUnit is what one unit brings on the sellVia route, after the cut.',
    'vendorUnit is what a merchant pays per unit (0: no vendor price in the game data). ifVendored is the profit per craft if every unit goes to a merchant. ifUnsold (auction rows) is ifVendored minus one lost deposit: the listing expires once, then the units go to a merchant.',
    'ifSold assumes every unit sells; no source records sales, so it is not a forecast. Categories describe asking prices and supply; vendor means the product goes to a merchant, with no auction risk.',
    'breakEven is the lowest auction asking price per unit that covers the cost after the cut.',
    `depositEstimate is ${Math.round(DEPOSIT_RATES[hours] * 100)}% of the vendor price per unit for a ${hours}h listing (Classic Era rates, not yet confirmed on Forever); refunded on sale, so ifSold excludes it, and lost when the auction expires. warnings name rows where one expired listing costs more than a sale earns, or the auction adds less than a deposit over the vendor price.`,
    'Auction prices for ahledger markets: data by AHledger (https://ahledger.com).',
  ];
}

/** Units on the market, and for local scans which day that count is from. */
export function supplyJson(pricer: Pricer, itemId: number) {
  const stats = pricer.ctx.market.prices.get(itemId);
  const window = pricer.ctx.market.fullScans?.slice(-PRESENCE_WINDOW);
  const days = new Set(stats?.history?.map((day) => day.date));
  return {
    units: stats?.quantity ?? 0,
    unitsAre: stats?.lastSeen ? 'most seen on lastSeen' : 'listed now',
    lastSeen: stats?.lastSeen,
    seenOnFullScans: window?.filter((date) => days.has(date)).length,
    fullScansInWindow: window?.length,
  };
}

export function classificationJson(c: Classification) {
  return { status: c.status, reasons: c.reasons };
}

export function materialsJson(pricer: Pricer, report: MaterialsReport, limit: number) {
  const groups = Object.fromEntries(
    (Object.entries(report.groups) as [Category, HeldUse[]][]).map(([category, list]) => [
      category,
      {
        total: list.length,
        top: list.slice(0, limit).map((use) => ({
          ...evaluationJson(pricer, use),
          crafts: use.crafts,
          gain: Math.round(use.gain),
          consumes: [...use.consumes].map(([itemId, perCraft]) => ({
            itemId,
            name: pricer.name(itemId),
            perCraft,
            total: perCraft * use.crafts,
          })),
        })),
      },
    ]),
  );
  return {
    market: marketJson(pricer.ctx.market),
    warnings: marketWarnings(pricer.ctx.market),
    listingHours: pricer.listingHours,
    holdings: report.holdings.map((h) => ({
      itemId: h.itemId,
      name: h.name,
      quantity: h.quantity,
      marketUnits: h.marketQuantity,
      marketUnitsAre: h.lastSeen ? 'most seen on lastSeen' : 'listed now',
      lastSeen: h.lastSeen,
      sell: { ...saleJson(h.sale), total: copper(h.sellTotal) },
    })),
    groups,
    notes: [
      'Each use is a recipe evaluated with the holdings costing what selling them nets, so ifSold is what one craft earns above selling the holdings it uses, and gain is ifSold over all crafts.',
      'crafts uses only the holdings, through intermediates crafted from them; other reagents are bought. Uses compete for the same holdings, so their gains do not add up.',
      ...evaluationNotes(pricer.listingHours),
    ],
  };
}

/** One unit's sale: the price to list at, what it nets, and what a merchant pays. */
export function saleJson(sale: SaleQuote) {
  return {
    via: sale.via,
    listUnit: copper(sale.auctionGross),
    netUnit: copper(sale.unit),
    vendorUnit: sale.vendor,
  };
}
