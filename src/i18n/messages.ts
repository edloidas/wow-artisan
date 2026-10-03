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
  stale: (days: number) => string;
  summary: (considered: number, unpriced: number, bound: number, minProfit: number) => string;
  more: (count: number) => string;
  risk: string;
  crafted: (recipe: string) => string;
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
