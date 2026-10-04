import type { GameData, NameLocale, Recipe } from '../gamedata/types.ts';
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
  /** Copper per unit, averaged over `units`; undefined when no source can supply the item. */
  unit?: number;
  source: CostSource;
  /** Units the quote supplies: the whole batch, not one craft. */
  units: number;
  classification?: Classification;
  /** Auction: the cheapest listing prices climb from, and the units listed. */
  cheapest?: number;
  listed?: number;
  /** Held: units taken from the holdings; `rest` supplies the others when the holdings fall short. */
  held?: number;
  rest?: CostQuote;
  /** Some auction buy in the quote, here or in its reagents, needs more units than are listed. */
  short?: boolean;
  recipe?: Recipe;
  /** Craft: whole crafts made, and the units made beyond `units`, credited as `craftCost` says. */
  crafts?: number;
  surplus?: number;
  parts?: Part[];
};

export type Shortfall = { itemId: number; need: number; listed: number };

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
   * Units the player holds, by item. They cost what selling them would net: the opportunity
   * cost, so a craft's profit is what it earns above selling them as they are.
   */
  held?: ReadonlyMap<number, number>;
  /** Holdings cost nothing, so every route that can reach one does; for finding which recipes can. */
  freeHeld?: boolean;
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

  /** The item's name; a translation when one is cached for `lang`, else the English one. */
  name(itemId: number, lang?: NameLocale | 'en'): string {
    const local =
      lang === undefined || lang === 'en' ? undefined : this.ctx.game.localNames?.[lang];
    const translated = local?.items[itemId];
    if (translated) return translated;
    const fromGame = this.ctx.game.items[itemId]?.name;
    if (fromGame) return fromGame;
    const fromInventory = this.ctx.names?.get(itemId);
    if (fromInventory) return fromInventory;
    const producer = this.ctx.game.recipes.find((r) => r.output.itemId === itemId);
    return producer?.name ?? `item:${itemId}`;
  }

  recipeName(recipe: Recipe, lang?: NameLocale | 'en'): string {
    if (lang === undefined || lang === 'en') return recipe.name;
    return this.ctx.game.localNames?.[lang]?.recipes[recipe.spellId] ?? recipe.name;
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

  /** Cheapest way to get `units` of an item, the holdings first. */
  cost(itemId: number, stack: number[] = [], units = 1): CostQuote {
    const key = `${itemId}:${units}`;
    const cached = this.costs.get(key);
    if (cached) return cached;
    if (stack.includes(itemId)) return { source: 'unknown', units };

    const held = Math.min(this.ctx.held?.get(itemId) ?? 0, units);
    const best =
      held > 0
        ? this.heldQuote(itemId, units, held, stack)
        : (cheapest(this.options(itemId, stack, units)) ?? { source: 'unknown', units });
    if (stack.length === 0) this.costs.set(key, best);
    return best;
  }

  /**
   * Every way to get `units` of an item, with the holdings' share among them: routes the market
   * can supply first, then cheapest first.
   */
  routes(itemId: number, units = 1): CostQuote[] {
    const held = Math.min(this.ctx.held?.get(itemId) ?? 0, units);
    const routes = this.options(itemId, [], units);
    if (held > 0) routes.push(this.heldQuote(itemId, units, held, []));
    return routes.sort(compareQuotes);
  }

  /** `held` units at what selling them nets, the rest from the cheapest other route. */
  private heldQuote(itemId: number, units: number, held: number, stack: number[]): CostQuote {
    const value = this.ctx.freeHeld ? 0 : (this.sale(itemId).unit ?? 0);
    if (held >= units) return { unit: value, source: 'held', units, held };
    const rest = cheapest(this.options(itemId, stack, units - held)) ?? {
      source: 'unknown',
      units: units - held,
    };
    const quote: CostQuote = { source: 'held', units, held, rest };
    if (rest.unit !== undefined) quote.unit = (held * value + rest.units * rest.unit) / units;
    if (rest.short) quote.short = true;
    return quote;
  }

  private options(itemId: number, stack: number[], units: number): CostQuote[] {
    const options: CostQuote[] = [];
    const vendor = this.ctx.vendorBuy.get(itemId);
    if (vendor !== undefined) options.push({ unit: vendor, source: 'vendor', units });

    const stats = this.ctx.market.prices.get(itemId);
    const auction = buyPrice(stats, units, this.ctx.thresholds.maxSpread);
    if (auction !== undefined) {
      const quote: CostQuote = {
        unit: auction.unit,
        source: 'auction',
        units,
        cheapest: auction.cheapest,
        listed: auction.listed,
        classification: this.classification(itemId),
      };
      if (units > auction.listed) quote.short = true;
      options.push(quote);
    }

    if (stack.length < MAX_CRAFT_DEPTH) {
      for (const recipe of this.producers.get(itemId) ?? []) {
        const crafts = Math.ceil(units / recipe.output.count);
        const crafted = this.craftCost(recipe, [...stack, itemId], crafts, units);
        if (crafted.unit !== undefined) options.push(crafted);
      }
    }
    return options;
  }

  /**
   * Cost per unit of `wanted` units of the recipe's output from `crafts` whole crafts, with the
   * reagents bought for all of them. Units made beyond `wanted` are credited at what they sell for,
   * but no more than they cost to make: a spare can offset its own cost, never pay for the rest.
   */
  craftCost(
    recipe: Recipe,
    stack: number[] = [],
    crafts = 1,
    wanted = crafts * recipe.output.count,
  ): CostQuote {
    const parts: Part[] = recipe.reagents.map((r) => ({
      itemId: r.itemId,
      count: r.count,
      quote: this.cost(r.itemId, stack, r.count * crafts),
    }));
    const base: CostQuote = { source: 'unknown', units: wanted, crafts, recipe, parts };
    if (parts.some((p) => p.quote.short)) base.short = true;
    if (parts.some((p) => p.quote.unit === undefined)) return base;
    const perCraft = parts.reduce((sum, p) => sum + (p.quote.unit ?? 0) * p.count, 0);
    const surplus = crafts * recipe.output.count - wanted;
    const made = perCraft / recipe.output.count;
    const credit =
      surplus > 0 ? surplus * Math.min(this.sale(recipe.output.itemId).unit ?? 0, made) : 0;
    const quote: CostQuote = {
      ...base,
      source: 'craft',
      unit: (perCraft * crafts - credit) / wanted,
    };
    if (surplus > 0) quote.surplus = surplus;
    return quote;
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

/**
 * A route the market can fully supply beats one it can't, whatever the price: units past what is
 * listed are priced by a guess, and on live data they can't be bought today at all.
 */
function compareQuotes(a: CostQuote, b: CostQuote): number {
  if ((a.unit === undefined) !== (b.unit === undefined)) return a.unit === undefined ? 1 : -1;
  if (Boolean(a.short) !== Boolean(b.short)) return a.short ? 1 : -1;
  return (a.unit ?? 0) - (b.unit ?? 0);
}

function cheapest(options: CostQuote[]): CostQuote | undefined {
  return options.reduce<CostQuote | undefined>(
    (a, b) => (a === undefined || compareQuotes(b, a) < 0 ? b : a),
    undefined,
  );
}

/** Every reagent bought on the auction house, including inside crafted intermediates. */
export function auctionParts(parts: Part[]): Part[] {
  return parts.flatMap((part) => bought(part.itemId, part.count, part.quote));
}

/** Auction buys in a quote that need more units than are listed. */
export function shortfalls(itemId: number, quote: CostQuote): Shortfall[] {
  return bought(itemId, 1, quote)
    .filter((part) => part.quote.units > (part.quote.listed ?? Infinity))
    .map((part) => ({
      itemId: part.itemId,
      need: Math.ceil(part.quote.units),
      listed: part.quote.listed ?? 0,
    }));
}

function bought(itemId: number, count: number, quote: CostQuote): Part[] {
  if (quote.source === 'auction') return [{ itemId, count, quote }];
  if (quote.source === 'craft') return auctionParts(quote.parts ?? []);
  if (quote.source === 'held' && quote.rest) return bought(itemId, count, quote.rest);
  return [];
}
