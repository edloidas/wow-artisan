import type { GameData, Recipe } from '../gamedata/types.ts';
import type { Market } from '../prices/types.ts';
import { buyPrice, type Classification, classify, sellPrice, type Thresholds } from './classify.ts';

export const AUCTION_CUT = 0.05;
/**
 * Deposit as a share of the vendor sell price, by listing hours. Forever lists for 2, 8 or 24
 * hours (Auctionator's Forever constants); the rates are Classic Era's, not yet confirmed on
 * Forever. Refunded on sale, lost when the auction expires.
 */
export const DEPOSIT_RATES = { 2: 0.05, 8: 0.2, 24: 0.6 } as const;
export type ListingHours = keyof typeof DEPOSIT_RATES;
export const DEFAULT_LISTING_HOURS: ListingHours = 24;

export function isListingHours(value: unknown): value is ListingHours {
  return typeof value === 'number' && value in DEPOSIT_RATES;
}
const MAX_CRAFT_DEPTH = 3;

export type CostSource = 'auction' | 'vendor' | 'craft' | 'held' | 'unknown';

export type Part = { itemId: number; count: number; quote: CostQuote };

export type CostQuote = {
  /** Copper per unit; undefined when no source can supply the item. */
  unit?: number;
  source: CostSource;
  classification?: Classification;
  recipe?: Recipe;
  parts?: Part[];
};

export type SaleQuote = {
  /** Copper received per unit on the better route, after the auction cut. */
  unit?: number;
  via: 'auction' | 'vendor' | 'none';
  /** Asking price per unit to list at, before the cut. */
  auctionGross?: number;
  auctionNet?: number;
  /** What a merchant pays per unit; 0 when the game data has no vendor price. */
  vendor: number;
  classification: Classification;
};

export type PricerContext = {
  game: GameData;
  market: Market;
  vendorBuy: Map<number, number>;
  thresholds: Thresholds;
  /** Recipes the player may use to make intermediates. */
  recipes: Recipe[];
  listingHours?: ListingHours;
  names?: Map<number, string>;
  /**
   * Items the player holds. They cost what selling them would net: the opportunity cost,
   * so a craft's profit is what it earns above selling them as they are.
   */
  held?: ReadonlySet<number>;
};

export class Pricer {
  private readonly producers = new Map<number, Recipe[]>();
  private readonly costs = new Map<string, CostQuote>();

  constructor(readonly ctx: PricerContext) {
    for (const recipe of ctx.recipes) {
      const list = this.producers.get(recipe.output.itemId) ?? [];
      list.push(recipe);
      this.producers.set(recipe.output.itemId, list);
    }
  }

  name(itemId: number): string {
    const fromGame = this.ctx.game.items[itemId]?.name;
    if (fromGame) return fromGame;
    const fromInventory = this.ctx.names?.get(itemId);
    if (fromInventory) return fromInventory;
    const producer = this.ctx.game.recipes.find((r) => r.output.itemId === itemId);
    return producer?.name ?? `item:${itemId}`;
  }

  vendorSell(itemId: number): number {
    return this.ctx.game.items[itemId]?.sellPrice ?? 0;
  }

  classification(itemId: number): Classification {
    return classify(this.ctx.market.prices.get(itemId), this.ctx.thresholds, this.ctx.market);
  }

  get listingHours(): ListingHours {
    return this.ctx.listingHours ?? DEFAULT_LISTING_HOURS;
  }

  /** Undefined without a vendor price: the rule needs one, and 0 would read as a free listing. */
  depositEstimate(itemId: number): number | undefined {
    const vendor = this.vendorSell(itemId);
    return vendor > 0 ? vendor * DEPOSIT_RATES[this.listingHours] : undefined;
  }

  /** Cheapest way to get `units` of an item for one craft, per unit. */
  cost(itemId: number, stack: number[] = [], units = 1): CostQuote {
    if (this.ctx.held?.has(itemId)) return { unit: this.sale(itemId).unit ?? 0, source: 'held' };
    const key = `${itemId}:${units}`;
    const cached = this.costs.get(key);
    if (cached) return cached;
    if (stack.includes(itemId)) return { source: 'unknown' };

    const options: CostQuote[] = [];
    const vendor = this.ctx.vendorBuy.get(itemId);
    if (vendor !== undefined) options.push({ unit: vendor, source: 'vendor' });

    const stats = this.ctx.market.prices.get(itemId);
    const auction = buyPrice(stats, units, this.ctx.thresholds.maxSpread);
    if (auction !== undefined) {
      options.push({
        unit: auction,
        source: 'auction',
        classification: this.classification(itemId),
      });
    }

    if (stack.length < MAX_CRAFT_DEPTH) {
      for (const recipe of this.producers.get(itemId) ?? []) {
        const crafted = this.craftCost(recipe, [...stack, itemId]);
        if (crafted.unit !== undefined) options.push(crafted);
      }
    }

    const best = options.reduce<CostQuote | undefined>(
      (a, b) => (a?.unit === undefined || (b.unit ?? Infinity) < a.unit ? b : a),
      undefined,
    ) ?? { source: 'unknown' };
    if (stack.length === 0) this.costs.set(key, best);
    return best;
  }

  /** Cost of one unit of the recipe's output. */
  craftCost(recipe: Recipe, stack: number[] = []): CostQuote {
    const parts: Part[] = recipe.reagents.map((r) => ({
      itemId: r.itemId,
      count: r.count,
      quote: this.cost(r.itemId, stack, r.count),
    }));
    if (parts.some((p) => p.quote.unit === undefined)) return { source: 'unknown', recipe, parts };
    const total = parts.reduce((sum, p) => sum + (p.quote.unit ?? 0) * p.count, 0);
    return { unit: total / recipe.output.count, source: 'craft', recipe, parts };
  }

  sale(itemId: number): SaleQuote {
    const stats = this.ctx.market.prices.get(itemId);
    const classification = this.classification(itemId);
    const vendor = this.vendorSell(itemId);
    const tradeable = !this.ctx.game.items[itemId]?.boundOnPickup;
    const gross = classification.status === 'none' || !tradeable ? undefined : sellPrice(stats);
    if (gross === undefined) {
      const quote: SaleQuote = { via: vendor > 0 ? 'vendor' : 'none', vendor, classification };
      if (vendor > 0) quote.unit = vendor;
      return quote;
    }
    const auctionNet = gross * (1 - AUCTION_CUT);
    const prices = { auctionGross: gross, auctionNet, vendor, classification };
    // On a tie the merchant wins: same money, no listing risk.
    return auctionNet > vendor || vendor === 0
      ? { ...prices, unit: auctionNet, via: 'auction' }
      : { ...prices, unit: vendor, via: 'vendor' };
  }
}

/** Every reagent bought on the auction house, including inside crafted intermediates. */
export function auctionParts(parts: Part[]): Part[] {
  return parts.flatMap((part) => {
    if (part.quote.source === 'auction') return [part];
    if (part.quote.source === 'craft') return auctionParts(part.quote.parts ?? []);
    return [];
  });
}
