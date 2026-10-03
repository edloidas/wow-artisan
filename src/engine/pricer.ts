import type { GameData, Recipe } from '../gamedata/types.ts';
import type { Market } from '../prices/types.ts';
import { buyPrice, type Classification, classify, sellPrice, type Thresholds } from './classify.ts';

export const AUCTION_CUT = 0.05;
/**
 * 24h deposit as a share of vendor sell price; an estimate, not verified for Forever.
 * Reported next to a sale, never subtracted from it, until an invoice confirms the rule.
 */
export const DEPOSIT_SHARE = 0.15;
const MAX_CRAFT_DEPTH = 3;

export type CostSource = 'auction' | 'vendor' | 'craft' | 'unknown';

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
  /** Best copper per unit after fees, or undefined when it can't be sold anywhere known. */
  unit?: number;
  via: 'auction' | 'vendor' | 'none';
  auctionNet?: number;
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
  names?: Map<number, string>;
};

export class Pricer {
  private readonly producers = new Map<number, Recipe[]>();
  private readonly costs = new Map<number, CostQuote>();

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
    return classify(
      this.ctx.market.prices.get(itemId),
      this.ctx.thresholds,
      this.ctx.market.latestScan,
    );
  }

  depositEstimate(itemId: number): number {
    return this.vendorSell(itemId) * DEPOSIT_SHARE;
  }

  cost(itemId: number, stack: number[] = []): CostQuote {
    const cached = this.costs.get(itemId);
    if (cached) return cached;
    if (stack.includes(itemId)) return { source: 'unknown' };

    const options: CostQuote[] = [];
    const vendor = this.ctx.vendorBuy.get(itemId);
    if (vendor !== undefined) options.push({ unit: vendor, source: 'vendor' });

    const stats = this.ctx.market.prices.get(itemId);
    const auction = buyPrice(stats);
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
    if (stack.length === 0) this.costs.set(itemId, best);
    return best;
  }

  /** Cost of one unit of the recipe's output. */
  craftCost(recipe: Recipe, stack: number[] = []): CostQuote {
    const parts: Part[] = recipe.reagents.map((r) => ({
      itemId: r.itemId,
      count: r.count,
      quote: this.cost(r.itemId, stack),
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
    const auctionNet = gross === undefined ? undefined : gross * (1 - AUCTION_CUT);
    if (auctionNet !== undefined && auctionNet >= vendor) {
      return { unit: auctionNet, via: 'auction', auctionNet, vendor, classification };
    }
    const quote: SaleQuote = {
      via: vendor > 0 ? 'vendor' : 'none',
      vendor,
      classification,
    };
    if (vendor > 0) quote.unit = vendor;
    if (auctionNet !== undefined) quote.auctionNet = auctionNet;
    return quote;
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
