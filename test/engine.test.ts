import { describe, expect, test } from 'bun:test';
import { buyPrice, classify, DEFAULT_THRESHOLDS, referencePrice } from '../src/engine/classify.ts';
import { type Holding, heldUses, holdingSale } from '../src/engine/materials.ts';
import { auctionParts, type ListingHours, Pricer } from '../src/engine/pricer.ts';
import { recommend, selectRecipes } from '../src/engine/recommend.ts';
import { buildGameData } from '../src/gamedata/load.ts';
import type { GameData, ItemInfo, Recipe } from '../src/gamedata/types.ts';
import { tradeSupplyPrices } from '../src/gamedata/vendors.ts';
import type { Market, PriceStats } from '../src/prices/types.ts';
import { evaluationJson } from '../src/serialize.ts';

const ORE = 1;
const BAR = 2;
const FLUX = 3;
const SWORD = 4;
const HELM = 5;
const DAGGER = 6;

function item(name: string, sellPrice: number, boundOnPickup = false): ItemInfo {
  return {
    name,
    sellPrice,
    buyPrice: 0,
    quality: 1,
    itemLevel: 10,
    requiredLevel: 5,
    boundOnPickup,
  };
}

function recipe(
  spellId: number,
  name: string,
  profession: Recipe['profession'],
  output: number,
  reagents: [number, number][],
  learnSkill: number,
): Recipe {
  return {
    spellId,
    name,
    profession,
    output: { itemId: output, count: 1 },
    reagents: reagents.map(([itemId, count]) => ({ itemId, count })),
    yellow: learnSkill + 20,
    grey: learnSkill + 40,
    learnSkill,
    learnSkillExact: true,
  };
}

const game: GameData = {
  build: 'test',
  items: {
    [ORE]: item('Ore', 5),
    [BAR]: item('Bar', 10),
    [FLUX]: item('Flux', 0),
    [SWORD]: item('Sword', 100),
    [HELM]: item('Helm', 0, true),
    [DAGGER]: item('Dagger', 0),
  },
  recipes: [
    recipe(101, 'Smelt Bar', 'mining', BAR, [[ORE, 1]], 1),
    recipe(
      201,
      'Sword',
      'blacksmithing',
      SWORD,
      [
        [BAR, 4],
        [FLUX, 1],
      ],
      50,
    ),
    recipe(202, 'Helm', 'blacksmithing', HELM, [[BAR, 2]], 10),
    recipe(203, 'Dagger', 'blacksmithing', DAGGER, [[BAR, 2]], 200),
  ],
};

const prices = new Map<number, PriceStats>([
  [ORE, { median: 20, min: 18, quantity: 500 }],
  [BAR, { median: 100, min: 95, quantity: 300 }],
  [SWORD, { median: 2000, min: 1900, quantity: 50, median7d: 1950, median30d: 2000 }],
  [DAGGER, { median: 900, min: 900, quantity: 2 }],
]);
const market: Market = { id: 'test', label: 'test', source: 'ahledger', prices };

function pricer(professions: Recipe['profession'][]): Pricer {
  return new Pricer({
    game,
    market,
    vendorBuy: new Map([[FLUX, 50]]),
    thresholds: DEFAULT_THRESHOLDS,
    recipes: game.recipes.filter((r) => professions.includes(r.profession)),
  });
}

describe('classify', () => {
  test('a deep, steady market is stable', () => {
    expect(classify(prices.get(SWORD)).status).toBe('stable');
  });

  test('few listings are thin, even when the price is steady', () => {
    expect(classify(prices.get(DAGGER))).toEqual({ status: 'thin', reasons: ['only 2 listed'] });
  });

  test('a cheapest listing far from the usual price, or a drifting median, is volatile', () => {
    expect(classify({ min: 100, median7d: 1000, quantity: 50 }).status).toBe('volatile');
    expect(
      classify({ min: 100, median: 100, median7d: 150, median30d: 100, quantity: 50 }).reasons,
    ).toEqual(['7-day median +50% vs 30-day']);
  });

  test('only a cheapest listing below the usual price is volatile', () => {
    expect(classify({ min: 1500, median7d: 1000, quantity: 50 }).status).toBe('stable');
  });

  test('local counts are reported as most seen, and an item missing from the latest scan is thin', () => {
    const seen = { min: 100, quantity: 2, lastSeen: '2026-09-29' };
    expect(classify(seen, DEFAULT_THRESHOLDS, { latestScan: '2026-09-29' }).reasons).toEqual([
      'at most 2 seen on 2026-09-29',
    ]);
    const stale = { min: 100, quantity: 50, lastSeen: '2026-09-27' };
    expect(classify(stale, DEFAULT_THRESHOLDS, { latestScan: '2026-09-29' })).toEqual({
      status: 'thin',
      reasons: ['missing from the latest scan (last seen 2026-09-27)'],
    });
  });

  test('nothing listed has no market', () => {
    expect(classify(undefined).status).toBe('none');
    expect(classify({ min: 5, quantity: 0 }).status).toBe('none');
  });

  test('the usual price prefers medians, then recent daily minimums', () => {
    expect(referencePrice({ median7d: 7, median: 9, min: 1, quantity: 1 })).toBe(7);
    const history = [10, 30, 20].map((min, i) => ({ date: `2026-09-2${i}`, min }));
    expect(referencePrice({ min: 1, quantity: 1, history })).toBe(20);
  });
});

describe('buyPrice', () => {
  const stats = { min: 95, median7d: 100, quantity: 300 };

  test('a small buy from a deep market pays the cheapest listing', () => {
    expect(buyPrice(stats, 4)).toBe(95);
    expect(buyPrice({ min: 95, median: 100, quantity: 300 }, 4)).toBe(95);
  });

  test('a buy that is a large share of the market pays the usual price', () => {
    expect(buyPrice(stats, 40)).toBe(100);
    expect(buyPrice({ min: 95, median: 110, quantity: 300 }, 40)).toBe(110);
  });

  test('a lone cheap listing far under the usual price is not trusted', () => {
    expect(buyPrice({ min: 50, median7d: 100, quantity: 300 }, 4)).toBe(100);
  });
});

describe('Pricer', () => {
  test('buys a reagent when nothing cheaper is in scope', () => {
    expect(pricer(['blacksmithing']).cost(BAR)).toMatchObject({ unit: 95, source: 'auction' });
  });

  test('crafts an intermediate when a helper profession makes it cheaper', () => {
    expect(pricer(['blacksmithing', 'mining']).cost(BAR)).toMatchObject({
      unit: 18,
      source: 'craft',
    });
  });

  test('lists at the lower of the cheapest listing and the usual price, and nets it after the cut', () => {
    // min(1900, 1950), then * 0.95
    expect(pricer(['blacksmithing']).sale(SWORD)).toMatchObject({
      auctionGross: 1900,
      auctionNet: 1805,
      unit: 1805,
      via: 'auction',
      vendor: 100,
    });
  });
});

describe('recommend', () => {
  test('filters by skill, skips bind-on-pickup products, and groups by market health', () => {
    const p = pricer(['blacksmithing', 'mining']);
    const inRange = selectRecipes(game.recipes, { profession: 'blacksmithing', maxSkill: 100 });
    const result = recommend(p, inRange, 0);
    expect(result.considered).toBe(2);
    expect(result.bound).toBe(1);
    expect(result.groups.steady.map((e) => [e.recipe.name, e.ifSold])).toEqual([
      ['Sword', 1805 - (4 * 18 + 50)],
    ]);
  });

  test('reports the break-even asking price and the deposit estimate without subtracting it', () => {
    const p = pricer(['blacksmithing', 'mining']);
    const [sword] = recommend(
      p,
      selectRecipes(game.recipes, { profession: 'blacksmithing', maxSkill: 100 }),
      0,
    ).groups.steady;
    expect(sword?.breakEven).toBe(122 / 0.95);
    // 60% of the 100c vendor price for the default 24h listing
    expect(sword?.depositEstimate).toBe(60);
    // vendored: 100 - 122, then one lost deposit
    expect(sword).toMatchObject({ ifVendored: -22, ifUnsold: -82 });
  });

  test('a reagent missing from the latest local scan makes the recipe thin', () => {
    const staleBar = new Map(prices);
    staleBar.set(BAR, { min: 95, quantity: 300, lastSeen: '2026-09-27' });
    staleBar.set(SWORD, { min: 1900, quantity: 50, lastSeen: '2026-09-29' });
    const p = new Pricer({
      game,
      market: { ...market, source: 'auctionator', latestScan: '2026-09-29', prices: staleBar },
      vendorBuy: new Map([[FLUX, 50]]),
      thresholds: DEFAULT_THRESHOLDS,
      recipes: game.recipes.filter((r) => r.profession === 'blacksmithing'),
    });
    const result = recommend(
      p,
      selectRecipes(game.recipes, { profession: 'blacksmithing', maxSkill: 100 }),
      0,
    );
    expect(result.groups.thin.map((e) => [e.recipe.name, e.reasons])).toEqual([
      ['Sword', ['Bar: missing from the latest scan (last seen 2026-09-27)']],
    ]);
  });

  test('a profitable recipe with a thin product market lands in thin', () => {
    const all = selectRecipes(game.recipes, { profession: 'blacksmithing' });
    const result = recommend(pricer(['blacksmithing']), all, 0);
    expect(result.groups.thin.map((e) => e.recipe.name)).toEqual(['Dagger']);
  });

  test('the minimum profit filter drops weak recipes', () => {
    const all = selectRecipes(game.recipes, { profession: 'blacksmithing' });
    const result = recommend(pricer(['blacksmithing']), all, 2_000);
    expect(result.groups.steady).toEqual([]);
    expect(result.groups.thin).toEqual([]);
  });
});

describe('materials', () => {
  function materials(held: Holding[], professions: Recipe['profession'][], marketPrices = prices) {
    const p = new Pricer({
      game,
      market: { ...market, prices: marketPrices },
      vendorBuy: new Map([[FLUX, 50]]),
      thresholds: DEFAULT_THRESHOLDS,
      recipes: game.recipes.filter((r) => professions.includes(r.profession)),
      held: new Set(held.map((h) => h.itemId)),
    });
    const all = selectRecipes(game.recipes, { profession: 'blacksmithing' });
    return { p, groups: heldUses(recommend(p, all, 1), held) };
  }

  test('a held reagent costs what selling it nets, and is not bought', () => {
    const { p } = materials([{ itemId: BAR, quantity: 100 }], ['blacksmithing']);
    // min(95, 100) * 0.95
    expect(p.cost(BAR)).toEqual({ unit: 90.25, source: 'held' });
    const sword = game.recipes.find((r) => r.name === 'Sword');
    if (!sword) throw new Error('no sword recipe');
    expect(auctionParts(p.craftCost(sword).parts ?? []).map((part) => part.itemId)).toEqual([]);
  });

  test('a use earns above selling the holdings, over the whole crafts they cover', () => {
    const { groups } = materials([{ itemId: BAR, quantity: 100 }], ['blacksmithing']);
    const [sword] = groups.steady;
    // 1805 - (4 * 90.25 + 50 flux)
    expect(sword).toMatchObject({ ifSold: 1394, crafts: 25, gain: 1394 * 25 });
    expect([...(sword?.consumes ?? [])]).toEqual([[BAR, 4]]);
    // the same deposit and unsold floor as recipes: 100 - 411, then a 60 deposit
    expect(sword).toMatchObject({ ifVendored: -311, ifUnsold: -371, depositEstimate: 60 });
    // a thin product is no cap on crafts: 2 dagger on the market, 50 crafts from 100 bars
    expect(groups.thin.map((u) => [u.recipe.name, u.crafts])).toEqual([['Dagger', 50]]);
  });

  test('held ore reaches a sword through bars smelted from it', () => {
    const { groups } = materials([{ itemId: ORE, quantity: 10 }], ['blacksmithing', 'mining']);
    const [sword] = groups.steady;
    expect([...(sword?.consumes ?? [])]).toEqual([[ORE, 4]]);
    expect(sword?.crafts).toBe(2);
  });

  test('uses that earn less than selling the holdings are dropped', () => {
    const dear = new Map(prices);
    dear.set(BAR, { median: 1000, min: 1000, quantity: 300 });
    const { groups } = materials([{ itemId: BAR, quantity: 100 }], ['blacksmithing'], dear);
    expect(Object.values(groups).flat()).toEqual([]);
  });

  test('holdings too few for one craft give no use', () => {
    const { groups } = materials([{ itemId: BAR, quantity: 3 }], ['blacksmithing']);
    expect(groups.steady).toEqual([]);
    expect(groups.thin.map((u) => u.crafts)).toEqual([1]);
  });

  test('holding sales report what the stack brings as is', () => {
    const p = pricer(['blacksmithing']);
    expect(holdingSale(p, { itemId: BAR, quantity: 10 })).toMatchObject({
      name: 'Bar',
      sellTotal: 902.5,
      marketQuantity: 300,
    });
  });
});

describe('presence over full scans', () => {
  const full = ['2026-09-24', '2026-09-27', '2026-09-29'];
  const seenOn = (...dates: string[]): PriceStats => ({
    min: 100,
    quantity: 20,
    lastSeen: dates.at(-1) as string,
    history: dates.map((date) => ({ date, min: 100, quantity: 20 })),
  });

  test('an item missing from a recent full scan is not steady', () => {
    const scans = { latestScan: '2026-09-29', fullScans: full };
    expect(classify(seenOn('2026-09-27', '2026-09-29'), DEFAULT_THRESHOLDS, scans)).toEqual({
      status: 'thin',
      reasons: ['seen on 2 of the last 3 full scans'],
    });
    expect(classify(seenOn(...full), DEFAULT_THRESHOLDS, scans).status).toBe('stable');
  });

  test('searches between full scans do not count as presence', () => {
    const stats = seenOn('2026-09-25', '2026-09-27', '2026-09-29');
    expect(
      classify(stats, DEFAULT_THRESHOLDS, { latestScan: '2026-09-29', fullScans: full }).status,
    ).toBe('thin');
  });

  test('the minimum number of scans is capped by how many exist', () => {
    const two = ['2026-09-27', '2026-09-29'];
    const scans = { latestScan: '2026-09-29', fullScans: two };
    expect(classify(seenOn(...two), DEFAULT_THRESHOLDS, scans).status).toBe('stable');
  });

  test('only the last seven full scans count', () => {
    const days = Array.from({ length: 9 }, (_, i) => `2026-09-${String(i + 10)}`);
    const scans = { latestScan: days.at(-1) as string, fullScans: days };
    expect(classify(seenOn(...days.slice(-4)), DEFAULT_THRESHOLDS, scans).status).toBe('stable');
    expect(classify(seenOn(...days.slice(-3)), DEFAULT_THRESHOLDS, scans).reasons).toEqual([
      'seen on 3 of the last 7 full scans',
    ]);
  });

  test('markets without scan days, like AHledger, skip the check', () => {
    expect(classify({ min: 100, quantity: 20 }).status).toBe('stable');
  });
});

describe('sale routes and listing risk', () => {
  const PLATE = 10;
  const items = {
    [BAR]: item('Bar', 10),
    [PLATE]: item('Plate', 1000),
  };
  const plate = recipe(301, 'Plate', 'blacksmithing', PLATE, [[BAR, 2]], 10);

  function evaluate(
    plateStats: PriceStats | undefined,
    barPrice = 100,
    listingHours: ListingHours = 24,
  ) {
    const marketPrices = new Map<number, PriceStats>([
      [BAR, { median: barPrice, min: barPrice, quantity: 300 }],
    ]);
    if (plateStats) marketPrices.set(PLATE, plateStats);
    const p = new Pricer({
      game: { build: 'test', items, recipes: [plate] },
      market: { id: 'test', label: 'test', source: 'ahledger', prices: marketPrices },
      vendorBuy: new Map(),
      thresholds: DEFAULT_THRESHOLDS,
      recipes: [plate],
      listingHours,
    });
    return { p, result: recommend(p, [plate], 0) };
  }

  test('a product with no listings that a merchant buys above cost goes to the vendor group', () => {
    const { result } = evaluate(undefined);
    const [row] = result.groups.vendor;
    expect(row).toMatchObject({ ifSold: 1000 - 200, ifVendored: 800, warnings: [] });
    expect(row?.depositEstimate).toBeUndefined();
    expect(result.groups.steady).toEqual([]);
  });

  test('an auction netting no more than the vendor loses to it, and says so', () => {
    // 1000 * 0.95 = 950 nets under the 1000 vendor price; a tie would go to the vendor too
    const { p, result } = evaluate({ median: 1000, min: 1000, quantity: 50 });
    expect(p.sale(PLATE)).toMatchObject({ via: 'vendor', unit: 1000, auctionGross: 1000 });
    expect(result.groups.vendor[0]?.reasons).toEqual([
      "product: auction nets 9s50c/u, under the vendor's 10s00c/u",
    ]);
  });

  test('the deposit follows the listing hours: 5%, 20% or 60% of the vendor price', () => {
    const stats = { median: 1100, min: 1100, quantity: 50 };
    expect(evaluate(stats, 100, 2).result.groups.steady[0]?.depositEstimate).toBe(50);
    expect(evaluate(stats, 100, 8).result.groups.steady[0]?.depositEstimate).toBe(200);
    expect(evaluate(stats, 100, 24).result.groups.steady[0]?.depositEstimate).toBe(600);
  });

  test('an auction premium smaller than one deposit is flagged on a steady row', () => {
    // nets 1045 vs vendor 1000; a 2h deposit is 50 per unit
    const { result } = evaluate({ median: 1100, min: 1100, quantity: 50 }, 100, 2);
    expect(result.groups.steady[0]?.warnings).toEqual([
      'vendor pays 10s00c/u; the auction adds less than one ~50c/u deposit',
    ]);
  });

  test('a deposit above the profit of a sale is flagged', () => {
    // cost 2 * 480 = 960, nets 1045: profit 85 against a 600 deposit
    const { result } = evaluate({ median: 1100, min: 1100, quantity: 50 }, 480);
    expect(result.groups.steady[0]?.warnings).toEqual([
      'one expired listing (~6s00c deposit) costs more than a sale earns',
    ]);
  });

  test('a vendor floor under the cost shows in ifVendored, not as a warning', () => {
    // cost 2 * 2000 = 4000, nets 4750 for 750; vendored: 1000 - 4000 = -3000
    const { result } = evaluate({ median: 5000, min: 5000, quantity: 50 }, 2000);
    expect(result.groups.steady[0]).toMatchObject({
      ifSold: 750,
      ifVendored: -3000,
      ifUnsold: -3600,
      warnings: [],
    });
  });

  test('a product with no vendor price has no deposit estimate', () => {
    const p = pricer(['blacksmithing']);
    const all = selectRecipes(game.recipes, { profession: 'blacksmithing' });
    const [dagger] = recommend(p, all, 0).groups.thin;
    expect(dagger).toMatchObject({ ifVendored: -190, warnings: [] });
    expect(dagger?.depositEstimate).toBeUndefined();
  });

  test('JSON names the listing price, what it nets and what a merchant pays', () => {
    const { p, result } = evaluate({ median: 1100, min: 1100, quantity: 50 });
    const [row] = result.groups.steady;
    if (!row) throw new Error('expected a steady row');
    const json = evaluationJson(p, row);
    expect(json).toMatchObject({
      sellVia: 'auction',
      listUnit: 1100,
      netUnit: 1045,
      vendorUnit: 1000,
      ifSold: 845,
      ifVendored: 800,
      ifUnsold: 200,
      depositEstimate: 600,
    });
    expect(json).not.toHaveProperty('sellUnit');
  });
});

describe('trainer and plan recipes', () => {
  const ability = (spell: string, yellow: string) => ({
    SkillLine: '164',
    Spell: spell,
    AcquireMethod: '2',
    TrivialSkillLineRankLow: yellow,
    TrivialSkillLineRankHigh: String(Number(yellow) + 20),
  });
  const data = buildGameData('test', {
    abilities: [ability('1', '50'), ability('2', '120'), ability('3', '40')],
    names: [
      { ID: '1', Name_lang: 'Copper Belt' },
      { ID: '2', Name_lang: 'Bronze Poniard' },
      { ID: '3', Name_lang: 'Iron Spaulders' },
    ],
    effects: ['1', '2', '3'].map((spell) => ({
      SpellID: spell,
      Effect: '24',
      DifficultyID: '0',
      EffectItemType: `10${spell}`,
      EffectBasePointsF: '1',
    })),
    reagents: [],
    items: [
      {
        ID: '900',
        Display_lang: 'Plans: Bronze Poniard',
        RequiredSkill: '164',
        RequiredSkillRank: '100',
      },
      // Demands more than the recipe's yellow 40: a different recipe with the same name.
      {
        ID: '901',
        Display_lang: 'Plans: Iron Spaulders',
        RequiredSkill: '164',
        RequiredSkillRank: '200',
      },
    ],
  });
  const byName = (name: string) => data.recipes.find((r) => r.name === name);

  test('a recipe taught by a plan item records it, and a name collision does not', () => {
    expect(byName('Bronze Poniard')).toMatchObject({ planItemId: 900, learnSkill: 100 });
    expect(byName('Copper Belt')?.planItemId).toBeUndefined();
    expect(byName('Iron Spaulders')?.planItemId).toBeUndefined();
  });

  test('trainerOnly hides plan recipes', () => {
    const names = (trainerOnly: boolean) =>
      selectRecipes(data.recipes, { profession: 'blacksmithing', trainerOnly }).map((r) => r.name);
    expect(names(false)).toContain('Bronze Poniard');
    expect(names(true)).toEqual(['Iron Spaulders', 'Copper Belt']);
  });
});

describe('trade supplies', () => {
  test('only listed trade supplies get a merchant price from game data', () => {
    const items = {
      3466: { ...item('Strong Flux', 500), buyPrice: 2000 },
      2770: { ...item('Copper Ore', 5), buyPrice: 20 },
    };
    expect([...tradeSupplyPrices({ build: 'test', items, recipes: [] })]).toEqual([[3466, 2000]]);
  });
});
