import type { GameData, NameLocale, Recipe } from '../gamedata/types.ts';
import type { Market } from '../prices/types.ts';
import {
  buyPrice,
  type Classification,
  classify,
  ladder,
  sellPrice,
  type Thresholds,
  unitsUnder,
} from './classify.ts';

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
  /** Auction: units other branches of the same craft bought first, so this buy climbs from there. */
  after?: number;
  /** Auction: units bought on the auction house when `rest` supplies the others. */
  bought?: number;
  /** Held: units taken from the holdings. */
  held?: number;
  /** Held or auction: how the units the holdings or the listings don't cover are got. */
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

/**
 * What earlier branches of one craft already took: held units used and auction units bought.
 * A recipe can need one item directly and through an intermediate, and both draw on the same
 * holding and the same listings.
 */
type Ledger = {
  readonly held: ReadonlyMap<number, number>;
  readonly bought: ReadonlyMap<number, number>;
};

type Priced = [CostQuote, Ledger];

const EMPTY: Ledger = { held: new Map(), bought: new Map() };

function record(ledger: Ledger, kind: keyof Ledger, itemId: number, units: number): Ledger {
  const taken = new Map(ledger[kind]);
  taken.set(itemId, (taken.get(itemId) ?? 0) + units);
  return { ...ledger, [kind]: taken };
}

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
  private readonly costs = new Map<string, Priced>();

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
    return this.price(itemId, stack, units, EMPTY)[0];
  }

  /**
   * Every way to get `units` of an item, with the holdings' share among them: routes the market
   * can supply first, then cheapest first.
   */
  routes(itemId: number, units = 1): CostQuote[] {
    const held = this.heldLeft(itemId, EMPTY, units);
    const routes = this.options(itemId, [], units, EMPTY);
    if (held > 0) routes.push(this.heldQuote(itemId, units, held, [], EMPTY));
    return routes.map(([quote]) => quote).sort(compareQuotes);
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
    return this.craft(recipe, stack, crafts, wanted, EMPTY)[0];
  }

  private price(itemId: number, stack: number[], units: number, ledger: Ledger): Priced {
    const fresh = ledger === EMPTY && stack.length === 0;
    const key = `${itemId}:${units}`;
    const cached = fresh ? this.costs.get(key) : undefined;
    if (cached) return cached;
    if (stack.includes(itemId)) return [{ source: 'unknown', units }, ledger];

    const held = this.heldLeft(itemId, ledger, units);
    const best =
      held > 0
        ? this.heldQuote(itemId, units, held, stack, ledger)
        : (cheapest(this.options(itemId, stack, units, ledger)) ?? [
            { source: 'unknown', units },
            ledger,
          ]);
    if (fresh) this.costs.set(key, best);
    return best;
  }

  private heldLeft(itemId: number, ledger: Ledger, units: number): number {
    const left = (this.ctx.held?.get(itemId) ?? 0) - (ledger.held.get(itemId) ?? 0);
    return Math.max(0, Math.min(left, units));
  }

  /** `held` units at what selling them nets, the rest from the cheapest other route. */
  private heldQuote(
    itemId: number,
    units: number,
    held: number,
    stack: number[],
    ledger: Ledger,
  ): Priced {
    const value = this.ctx.freeHeld ? 0 : (this.sale(itemId).unit ?? 0);
    const after = record(ledger, 'held', itemId, held);
    if (held >= units) return [{ unit: value, source: 'held', units, held }, after];
    const [rest, last] = cheapest(this.options(itemId, stack, units - held, after)) ?? [
      { source: 'unknown', units: units - held },
      after,
    ];
    const quote: CostQuote = { source: 'held', units, held, rest };
    if (rest.unit !== undefined) quote.unit = (held * value + rest.units * rest.unit) / units;
    if (rest.short) quote.short = true;
    return [quote, last];
  }

  /** Buying at auction, a merchant, crafting, and the cheap listings topped up from another. */
  private options(itemId: number, stack: number[], units: number, ledger: Ledger): Priced[] {
    const others = this.alternatives(itemId, stack, units, ledger);
    const auction = this.auction(itemId, units, ledger);
    if (!auction) return others;
    const split = this.split(itemId, stack, units, ledger, cheapest(others)?.[0]);
    return [...others, auction, ...(split ? [split] : [])];
  }

  private alternatives(itemId: number, stack: number[], units: number, ledger: Ledger): Priced[] {
    const options: Priced[] = [];
    const vendor = this.ctx.vendorBuy.get(itemId);
    if (vendor !== undefined) options.push([{ unit: vendor, source: 'vendor', units }, ledger]);
    if (stack.length < MAX_CRAFT_DEPTH) {
      for (const recipe of this.producers.get(itemId) ?? []) {
        const crafts = Math.ceil(units / recipe.output.count);
        const crafted = this.craft(recipe, [...stack, itemId], crafts, units, ledger);
        if (crafted[0].unit !== undefined) options.push(crafted);
      }
    }
    return options;
  }

  private auction(itemId: number, units: number, ledger: Ledger): Priced | undefined {
    const after = ledger.bought.get(itemId) ?? 0;
    const buy = buyPrice(
      this.ctx.market.prices.get(itemId),
      units,
      this.ctx.thresholds.maxSpread,
      after,
    );
    if (!buy) return undefined;
    const quote: CostQuote = {
      unit: buy.unit,
      source: 'auction',
      units,
      cheapest: buy.cheapest,
      listed: buy.listed,
      classification: this.classification(itemId),
    };
    if (after > 0) quote.after = after;
    if (after + units > buy.listed) quote.short = true;
    return [quote, record(ledger, 'bought', itemId, units)];
  }

  /**
   * The listings that cost less than the best other route, and that route for the rest. On the
   * modelled ladder the next unit costs more than the last, so buying until it reaches the other
   * route's price is the cheapest mix.
   */
  private split(
    itemId: number,
    stack: number[],
    units: number,
    ledger: Ledger,
    other: CostQuote | undefined,
  ): Priced | undefined {
    const steps = ladder(this.ctx.market.prices.get(itemId), this.ctx.thresholds.maxSpread);
    if (!steps || other?.unit === undefined || other.short) return undefined;
    const after = ledger.bought.get(itemId) ?? 0;
    const bought = Math.floor(Math.min(units, unitsUnder(steps, other.unit) - after));
    if (bought <= 0 || bought >= units) return undefined;
    const [auction, afterBuy] = this.auction(itemId, bought, ledger) ?? [];
    if (!auction || !afterBuy || auction.unit === undefined) return undefined;
    const [rest, last] = cheapest(this.alternatives(itemId, stack, units - bought, afterBuy)) ?? [];
    if (!rest || !last || rest.unit === undefined) return undefined;
    const quote: CostQuote = {
      ...auction,
      units,
      bought,
      rest,
      unit: (bought * auction.unit + rest.units * rest.unit) / units,
    };
    if (rest.short) quote.short = true;
    return [quote, last];
  }

  private craft(
    recipe: Recipe,
    stack: number[],
    crafts: number,
    wanted: number,
    ledger: Ledger,
  ): Priced {
    let current = ledger;
    const parts: Part[] = recipe.reagents.map((r) => {
      const [quote, next] = this.price(r.itemId, stack, r.count * crafts, current);
      current = next;
      return { itemId: r.itemId, count: r.count, quote };
    });
    const base: CostQuote = { source: 'unknown', units: wanted, crafts, recipe, parts };
    if (parts.some((p) => p.quote.short)) base.short = true;
    if (parts.some((p) => p.quote.unit === undefined)) return [base, current];
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
    return [quote, current];
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

function cheapest(options: Priced[]): Priced | undefined {
  return options.reduce<Priced | undefined>(
    (a, b) => (a === undefined || compareQuotes(b[0], a[0]) < 0 ? b : a),
    undefined,
  );
}

/** Units an auction buy brings the item's total to, across every branch of the craft. */
export function auctionNeed(quote: CostQuote): number {
  return (quote.after ?? 0) + (quote.bought ?? quote.units);
}

/** Every reagent bought on the auction house, including inside crafted intermediates. */
export function auctionParts(parts: Part[]): Part[] {
  return parts.flatMap((part) => bought(part.itemId, part.count, part.quote));
}

/** Auction buys in a quote that need more units than are listed. */
export function shortfalls(itemId: number, quote: CostQuote): Shortfall[] {
  return bought(itemId, 1, quote)
    .filter((part) => auctionNeed(part.quote) > (part.quote.listed ?? Infinity))
    .map((part) => ({
      itemId: part.itemId,
      need: Math.ceil(auctionNeed(part.quote)),
      listed: part.quote.listed ?? 0,
    }));
}

function bought(itemId: number, count: number, quote: CostQuote): Part[] {
  if (quote.source === 'auction' && quote.rest) {
    const { rest, ...listings } = quote;
    return [{ itemId, count, quote: listings }, ...bought(itemId, count, rest)];
  }
  if (quote.source === 'auction') return [{ itemId, count, quote }];
  if (quote.source === 'craft') return auctionParts(quote.parts ?? []);
  if (quote.source === 'held' && quote.rest) return bought(itemId, count, quote.rest);
  return [];
}
