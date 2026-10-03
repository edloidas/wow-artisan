import { DEFAULT_THRESHOLDS, type Thresholds } from './engine/classify.ts';
import { type Holding, heldUses, holdingSale, type MaterialsReport } from './engine/materials.ts';
import {
  DEFAULT_LISTING_HOURS,
  isListingHours,
  type ListingHours,
  Pricer,
} from './engine/pricer.ts';
import {
  type RecipeFilter,
  type Recommendations,
  recommend,
  selectRecipes,
} from './engine/recommend.ts';
import { loadGameData } from './gamedata/load.ts';
import { type GameData, PROFESSIONS, type Profession, type Recipe } from './gamedata/types.ts';
import { tradeSupplyPrices } from './gamedata/vendors.ts';
import { type Inventory, readSyndicator } from './inventory/syndicator.ts';
import { fetchAhledgerMarket } from './prices/ahledger.ts';
import { type AuctionatorData, auctionatorMarket, readAuctionator } from './prices/auctionator.ts';
import type { Market } from './prices/types.ts';
import {
  FALLBACK_BUILD,
  findAccountSavedVariables,
  findInstallation,
  type Installation,
} from './wow.ts';

export type AdvisorOptions = {
  /** `auctionator`, `auctionator:<realm>` or `ahledger:<market id>`. */
  market?: string;
  build?: string;
  refreshGameData?: boolean;
  thresholds?: Partial<Thresholds>;
};

export type Scope = RecipeFilter & {
  /** Other professions whose recipes may make intermediates, at any skill; `trainerOnly` applies. */
  craftWith?: Profession[];
  /** Listing hours for deposits; defaults to Auctionator's setting, else 24. */
  listingHours?: ListingHours;
};

/** What an advisor works from once the install has been read. */
export type AdvisorData = {
  game: GameData;
  market: Market;
  inventory?: Inventory;
  /** Merchant prices seen in game, on top of the trade-supply ones from game data. */
  vendorBuy?: Map<number, number>;
  thresholds?: Partial<Thresholds>;
  /** Auctionator's listing duration setting; ignored unless Forever offers it. */
  auctionDuration?: number;
  installation?: Installation;
};

export class Advisor {
  private constructor(
    readonly game: GameData,
    readonly market: Market,
    readonly vendorBuy: Map<number, number>,
    readonly inventory: Inventory | undefined,
    readonly thresholds: Thresholds,
    readonly installation: Installation | undefined,
    /** Auctionator's default listing duration when it is one Forever offers, else 24. */
    readonly listingHours: ListingHours,
  ) {}

  static async create(options: AdvisorOptions = {}): Promise<Advisor> {
    const installation = findInstallation();
    const build = options.build ?? installation?.build ?? FALLBACK_BUILD;
    const game = await loadGameData(build, options.refreshGameData);

    const auctionatorFile = installation && findAccountSavedVariables(installation, 'Auctionator');
    const auctionator: AuctionatorData | undefined = auctionatorFile
      ? readAuctionator(auctionatorFile)
      : undefined;
    const syndicatorFile = installation && findAccountSavedVariables(installation, 'Syndicator');
    const inventory = syndicatorFile ? readSyndicator(syndicatorFile) : undefined;

    const spec = options.market ?? process.env.WOW_ARTISAN_MARKET ?? 'auctionator';
    const market = await openMarket(spec, auctionator);
    const data: AdvisorData = { game, market };
    if (inventory) data.inventory = inventory;
    if (auctionator) {
      data.vendorBuy = auctionator.vendorBuy;
      if (auctionator.auctionDuration !== undefined)
        data.auctionDuration = auctionator.auctionDuration;
    }
    if (options.thresholds) data.thresholds = options.thresholds;
    if (installation) data.installation = installation;
    return Advisor.fromData(data);
  }

  static fromData(data: AdvisorData): Advisor {
    return new Advisor(
      data.game,
      data.market,
      new Map([...tradeSupplyPrices(data.game), ...(data.vendorBuy ?? [])]),
      data.inventory,
      { ...DEFAULT_THRESHOLDS, ...data.thresholds },
      data.installation,
      isListingHours(data.auctionDuration) ? data.auctionDuration : DEFAULT_LISTING_HOURS,
    );
  }

  /** Recipes usable for intermediates: the target profession within skill, plus helpers. */
  private craftingRecipes(scope: Scope): Recipe[] {
    const own = selectRecipes(this.game.recipes, {
      profession: scope.profession,
      ...knownOf(scope),
    });
    const helpers = this.game.recipes.filter(
      (r) =>
        scope.craftWith?.includes(r.profession) &&
        !(scope.trainerOnly && r.planItemId !== undefined),
    );
    return [...own, ...helpers];
  }

  pricer(scope: Scope, held?: ReadonlySet<number>): Pricer {
    const ctx = {
      game: this.game,
      market: this.market,
      vendorBuy: this.vendorBuy,
      thresholds: this.thresholds,
      recipes: this.craftingRecipes(scope),
      listingHours: scope.listingHours ?? this.listingHours,
      ...(held ? { held } : {}),
    };
    return new Pricer(this.inventory ? { ...ctx, names: this.inventory.names } : ctx);
  }

  recommend(scope: Scope, minProfit = 0): { pricer: Pricer; result: Recommendations } {
    const pricer = this.pricer(scope);
    const recipes = selectRecipes(this.game.recipes, scope);
    return { pricer, result: recommend(pricer, recipes, minProfit) };
  }

  /**
   * Recipes that use the holdings, evaluated like `recommend` but with the holdings costing
   * what selling them nets, so profit is what crafting earns above selling them.
   */
  materials(
    scope: Scope,
    holdings: Holding[],
    minProfit = 1,
  ): { pricer: Pricer; report: MaterialsReport } {
    const pricer = this.pricer(scope, new Set(holdings.map((h) => h.itemId)));
    const result = recommend(pricer, selectRecipes(this.game.recipes, scope), minProfit);
    // Held items are priced from a pricer that doesn't treat them as held.
    const market = this.pricer(scope);
    return {
      pricer,
      report: {
        holdings: holdings.map((holding) => holdingSale(market, holding)),
        groups: heldUses(result, holdings),
      },
    };
  }

  /** Inventory items some in-scope recipe consumes. */
  ownedMaterials(scope: Scope): Holding[] {
    if (!this.inventory) return [];
    const reagents = new Set(
      this.craftingRecipes(scope).flatMap((r) => r.reagents.map((x) => x.itemId)),
    );
    return [...this.inventory.totals]
      .filter(([itemId]) => reagents.has(itemId))
      .map(([itemId, quantity]) => ({ itemId, quantity }))
      .sort((a, b) => b.quantity - a.quantity);
  }

  /**
   * Item ids by exact id or case-insensitive match on the English or a translated name, exact
   * names first. Results carry the English name.
   */
  findItems(query: string, limit = 10): { itemId: number; name: string }[] {
    if (/^\d+$/.test(query.trim())) {
      const itemId = Number(query);
      return [{ itemId, name: this.pricer({ profession: 'blacksmithing' }).name(itemId) }];
    }
    const needle = normalize(query);
    const names = new Map<number, string>();
    for (const [id, item] of Object.entries(this.game.items)) names.set(Number(id), item.name);
    for (const [id, name] of this.inventory?.names ?? []) if (!names.get(id)) names.set(id, name);
    const candidates: [number, string][] = [...names];
    for (const local of Object.values(this.game.localNames ?? {})) {
      for (const [id, name] of Object.entries(local.items)) candidates.push([Number(id), name]);
    }
    const found = new Map<number, string>();
    for (const [itemId] of candidates
      .map(([id, name]): [number, string] => [id, normalize(name)])
      .filter(([, name]) => name.includes(needle))
      .sort(([, a], [, b]) => Number(b === needle) - Number(a === needle) || a.length - b.length)) {
      if (found.size >= limit) break;
      if (!found.has(itemId)) found.set(itemId, names.get(itemId) ?? `item:${itemId}`);
    }
    return [...found].map(([itemId, name]) => ({ itemId, name }));
  }

  resolveItem(query: string): number {
    const [match] = this.findItems(query, 1);
    if (!match) throw new Error(`No item matches '${query}'`);
    return match.itemId;
  }
}

/** What limits the player's own recipes: skill, and whether plans are available. */
function knownOf(scope: Scope): Omit<RecipeFilter, 'profession'> {
  const filter: Omit<RecipeFilter, 'profession'> = {};
  if (scope.maxSkill !== undefined) filter.maxSkill = scope.maxSkill;
  if (scope.minSkill !== undefined) filter.minSkill = scope.minSkill;
  if (scope.trainerOnly) filter.trainerOnly = true;
  return filter;
}

async function openMarket(spec: string, auctionator: AuctionatorData | undefined): Promise<Market> {
  const [source, ...rest] = spec.split(':');
  const id = rest.join(':');
  if (source === 'ahledger') {
    if (!id)
      throw new Error('ahledger market needs an id, e.g. ahledger:forever.normal.alliance.us');
    return fetchAhledgerMarket(id);
  }
  if (source === 'auctionator') {
    if (!auctionator)
      throw new Error('No Auctionator SavedVariables found; scan the AH and /reload');
    return auctionatorMarket(auctionator, id || undefined);
  }
  throw new Error(`Unknown market '${spec}'; use auctionator[:realm] or ahledger:<id>`);
}

/** Case-insensitive, and Russian ё matches е: players type either. */
function normalize(name: string): string {
  return name.trim().toLowerCase().replaceAll('ё', 'е');
}

export function isProfession(value: string): value is Profession {
  return value in PROFESSIONS;
}
