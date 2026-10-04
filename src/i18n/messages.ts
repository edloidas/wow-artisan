import type { ItemStatus, MarketIssue } from '../engine/classify.ts';
import type { CostSource, SaleQuote } from '../engine/pricer.ts';
import type { Category, ListingWarning, SaleIssue } from '../engine/recommend.ts';
import type { Profession } from '../gamedata/types.ts';

export type HoldingLine = {
  name: string;
  quantity: number;
  via: string;
  listAt?: string;
  net: string;
  total: string;
  vendor?: string;
  flag?: string;
};

/** Every human-readable string the CLI prints. Item and recipe names stay as the game data has them. */
export type Messages = {
  /** BCP 47 tag for dates and numbers. */
  locale: string;
  money: (copper: number | undefined, exact?: boolean) => string;
  usage: string;
  professions: Record<Profession, string>;
  categories: Record<Category, string>;
  sources: Record<CostSource, string>;
  routes: Record<SaleQuote['via'], string>;
  statuses: Record<ItemStatus, string>;
  columns: {
    recipe: string;
    learn: string;
    cost: string;
    breakEven: string;
    listAt: string;
    vendor: string;
    ifSold: string;
    margin: string;
    ifUnsold: string;
    units: string;
    profit: string;
    gain: string;
    crafts: string;
    totalGain: string;
    route: string;
    unitCost: string;
    total: string;
  };
  plan: string;
  anySkill: string;
  skillAtMost: (skill: number) => string;
  trainerOnly: string;
  scanAge: (date: string, days: number) => string;
  pricesFrom: (date: string) => string;
  noFullScan: string;
  auctionatorMarket: (realm: string) => string;
  header: (profession: string, skill: string, market: string, age: string) => string;
  helper: (profession: string, skill: string) => string;
  craftingWith: (helpers: string) => string;
  stale: (days: number) => string;
  summary: (considered: number, unpriced: number, bound: number, minProfit: number) => string;
  more: (count: number) => string;
  risk: string;
  crafted: (recipe: string) => string;
  /** An auction buy whose average climbed above the cheapest listing. */
  auctionFrom: (cheapest: string, listed: number) => string;
  /** Held units, with how the rest is got. */
  heldPart: (held: number, rest: string) => string;
  /** Units bought from the cheap listings, with how the rest is got. */
  boughtPart: (units: number, auction: string, rest: string) => string;
  /** Units a route makes beyond the need, credited at what they sell for, up to their cost. */
  spare: (units: string) => string;
  batch: (crafts: number) => string;
  obtainTitle: (item: string, quantity: number) => string;
  cheapestRoute: string;
  noRoute: string;
  obtainNotes: string[];
  uses: (list: string) => string;
  noGainfulRecipe: (minProfit: number) => string;
  sellAsIs: string;
  holding: (line: HoldingLine) => string;
  moreThanMarket: string;
  allOfIt: (total: number) => string;
  recipeNotes: (hours: number, rate: number, localUnits: boolean) => string[];
  materialNotes: (hours: number, rate: number) => string[];
  product: string;
  issue: (issue: MarketIssue | SaleIssue) => string;
  warning: (warning: ListingWarning) => string;
  ownScans: string;
  synced: (build: string, recipes: number, items: number) => string;
};
