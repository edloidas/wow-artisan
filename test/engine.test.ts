import { describe, expect, test } from 'bun:test';
import {
  buyPrice,
  type Classification,
  classify as classifyIssues,
  DEFAULT_THRESHOLDS,
  referencePrice,
} from '../src/engine/classify.ts';
import {
  type Holding,
  heldCandidates,
  heldPerCraft,
  heldUses,
  holdingSale,
  mergeHoldings,
} from '../src/engine/materials.ts';
import {
  auctionParts,
  type CostQuote,
  type ListingHours,
  Pricer,
  shortfalls,
} from '../src/engine/pricer.ts';
import { type Evaluation, recommend, selectRecipes } from '../src/engine/recommend.ts';
import { buildGameData, localNames } from '../src/gamedata/load.ts';
import type { GameData, ItemInfo, Recipe } from '../src/gamedata/types.ts';
import { tradeSupplyPrices } from '../src/gamedata/vendors.ts';
import { en, reasonText } from '../src/i18n/index.ts';
import type { Market, PriceStats } from '../src/prices/types.ts';
import { evaluationJson } from '../src/serialize.ts';

/** Classification with its reasons rendered as the English CLI shows them. */
function classify(...args: Parameters<typeof classifyIssues>): Omit<Classification, 'reasons'> & {
  reasons: string[];
} {
  const { status, reasons } = classifyIssues(...args);
  return { status, reasons: reasons.map(en.issue) };
}

function reasonsOf(p: Pricer, e: Evaluation | undefined): string[] | undefined {
  return e?.reasons.map((r) => reasonText(en, (id) => p.name(id), r));
}

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

// Reagents are listed at one price, so buying any amount of them pays it.
const prices = new Map<number, PriceStats>([
  [ORE, { median: 18, min: 18, quantity: 500 }],
  [BAR, { median: 95, min: 95, quantity: 300 }],
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
  const unit = (...args: Parameters<typeof buyPrice>) => buyPrice(...args)?.unit;
  // Climbs from 90 at the first unit to the 110 median at the 100th, and 130 at the 200th.
  const ahledger = { min: 90, median: 110, quantity: 200 };

  test('a small buy from a deep market pays about the cheapest listing', () => {
    expect(unit(ahledger, 2)).toBe(90.2);
    expect(buyPrice(ahledger, 2)).toMatchObject({ cheapest: 90, listed: 200 });
  });

  test('the more of the market a batch takes, the more each unit costs on average', () => {
    expect(unit(ahledger, 100)).toBe(100);
    expect(unit(ahledger, 200)).toBe(110);
  });

  test('units beyond what is listed cost the top of the ladder', () => {
    // 200 at the 110 average, 200 more at 130
    expect(unit(ahledger, 400)).toBe(120);
  });

  test('a listing median equal to the cheapest is a flat market', () => {
    expect(unit({ min: 95, median: 95, quantity: 300 }, 300)).toBe(95);
  });

  test('without a listing median, the ladder rises to the usual price, and at least 20%', () => {
    // Local scans: min 100, usual 150, so the middle unit costs 150.
    expect(unit({ min: 100, median7d: 150, quantity: 100 }, 100)).toBe(150);
    // A cheapest listing at the usual price still climbs to 120 by the middle unit.
    expect(unit({ min: 100, median7d: 100, quantity: 100 }, 100)).toBe(120);
    expect(unit({ min: 100, median7d: 80, quantity: 100 }, 50)).toBe(110);
  });

  test('a lone cheap listing far under the usual price is not trusted', () => {
    expect(buyPrice({ min: 50, median: 100, median7d: 100, quantity: 300 }, 4)).toMatchObject({
      unit: 100,
      cheapest: 100,
    });
  });

  test('nothing listed cannot be bought', () => {
    expect(buyPrice({ min: 90, quantity: 0 }, 1)).toBeUndefined();
    expect(buyPrice(undefined)).toBeUndefined();
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
    expect(result.groups.thin.map((e) => [e.recipe.name, reasonsOf(p, e)])).toEqual([
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
      held: new Map(held.map((h) => [h.itemId, h.quantity])),
    });
    const all = selectRecipes(game.recipes, { profession: 'blacksmithing' });
    return { p, groups: heldUses(p, heldCandidates(p, all), held, 1) };
  }

  test('a held reagent costs what selling it nets, and is not bought', () => {
    const { p } = materials([{ itemId: BAR, quantity: 100 }], ['blacksmithing']);
    // 95 * 0.95
    expect(p.cost(BAR)).toEqual({ unit: 90.25, source: 'held', units: 1, held: 1 });
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

describe('batches', () => {
  // Ore climbs from 15c to the 20c median at the 50th of 100 units; bars cost 40c flat.
  const batchPrices = new Map<number, PriceStats>([
    [ORE, { min: 15, median: 20, quantity: 100 }],
    [BAR, { min: 40, median: 40, quantity: 1000 }],
    [SWORD, { median: 2000, min: 2000, quantity: 50 }],
  ]);

  function batchPricer(held?: Map<number, number>, overrides: [number, PriceStats][] = []) {
    return new Pricer({
      game,
      market: { ...market, prices: new Map([...batchPrices, ...overrides]) },
      vendorBuy: new Map([[FLUX, 50]]),
      thresholds: DEFAULT_THRESHOLDS,
      recipes: game.recipes,
      ...(held ? { held } : {}),
    });
  }
  const sword = game.recipes.find((r) => r.name === 'Sword') as Recipe;

  test('a larger batch pays more per unit', () => {
    const p = batchPricer();
    // 10 ore: 15 + 5 * 10/100
    expect(p.cost(BAR, [], 10)).toMatchObject({ unit: 15.5, source: 'craft', units: 10 });
    // 100 ore, the whole market, averages the 20c median
    expect(p.cost(BAR, [], 100).unit).toBe(20);
  });

  test('a route the market can supply beats a cheaper one it cannot', () => {
    const p = batchPricer();
    // 300 ore of 100 listed would average 23.33c, but only bought bars come in that number
    const routes = p.routes(BAR, 300);
    expect(routes.map((r) => [r.source, r.short ?? false])).toEqual([
      ['auction', false],
      ['craft', true],
    ]);
    expect(routes[1]?.unit).toBeCloseTo(23.33, 2);
    expect(p.cost(BAR, [], 300)).toMatchObject({ source: 'auction', unit: 40 });
    expect(shortfalls(BAR, routes[1] as CostQuote)).toEqual([
      { itemId: ORE, need: 300, listed: 100 },
    ]);
  });

  test('the craft batch reaches reagents of intermediates', () => {
    // 25 swords: 100 bars from 100 ore averaging 20c
    expect(batchPricer().craftCost(sword, [], 25).parts?.[0]?.quote).toMatchObject({
      unit: 20,
      units: 100,
    });
  });

  test('past what is listed, a flat market prices units at the listing price', () => {
    expect(buyPrice({ min: 40, median: 40, quantity: 100 }, 1000)).toMatchObject({
      unit: 40,
      listed: 100,
    });
  });

  test('an item the player holds lists the held route among the others', () => {
    const p = batchPricer(new Map([[BAR, 30]]));
    expect(p.routes(BAR, 50).map((r) => r.source)).toEqual(['craft', 'held', 'auction']);
  });

  test('a held share counts toward what one craft uses, the bought rest does not', () => {
    const p = batchPricer(new Map([[ORE, 30]]));
    // 25 swords smelt 100 bars: 30 from held ore, 70 from bought ore
    const crafted = p.craftCost(sword, [], 25);
    expect([...heldPerCraft(crafted.parts ?? [])]).toEqual([[ORE, 30 / 25]]);
  });

  test('holdings short of the batch cover what they can, and the rest is bought', () => {
    const p = batchPricer(new Map([[BAR, 30]]));
    // 30 held at what they net (40 * 0.95 = 38), 20 smelted from ore at 15 + 5 * 20/100 = 16
    const quote = p.cost(BAR, [], 50);
    expect(quote).toMatchObject({ source: 'held', units: 50, held: 30 });
    expect(quote.rest).toMatchObject({ source: 'craft', units: 20, unit: 16 });
    expect(quote.unit).toBe(29.2);
  });

  test('a stale reagent short for the batch says both', () => {
    const p = batchPricer(undefined, [
      [ORE, { min: 15, median: 20, quantity: 3 }],
      [BAR, { min: 40, median: 40, quantity: 3 }],
    ]);
    const [thin] = recommend(p, [sword], 0, 2).groups.thin;
    expect(reasonsOf(p, thin)).toEqual(['Ore: only 3 listed', 'Ore: need 8, only 3 listed']);
  });

  test('a batch needing more than is listed makes the recipe thin and says by how much', () => {
    // 150 bars listed: 200 bars for 50 swords can't be bought or smelted from listed ore
    const p = batchPricer(undefined, [[BAR, { min: 40, median: 40, quantity: 150 }]]);
    const [one] = recommend(p, [sword], 0).groups.steady;
    expect(one?.batch).toBe(1);
    const thin = recommend(p, [sword], 0, 50).groups.thin;
    expect(thin.map((e) => [e.batch, reasonsOf(p, e)])).toEqual([
      [50, ['Ore: need 200, only 100 listed']],
    ]);
  });

  test('materials buy the other reagents for every craft the holdings cover', () => {
    // 25 flux held, the only limit: 25 swords smelt 100 bars from 100 ore averaging 20c
    const held: Holding[] = [{ itemId: FLUX, quantity: 25 }];
    const p = batchPricer(new Map([[FLUX, 25]]));
    const [use] = heldUses(p, heldCandidates(p, [sword]), held, 1).steady;
    expect(use).toMatchObject({ batch: 25, crafts: 25 });
    expect(use?.parts[0]?.quote.unit).toBe(20);
  });

  test('held units in the bought rest count too', () => {
    // 50 bars: 30 held, and the other 20 smelted from 20 of 30 held ore
    const p = batchPricer(
      new Map([
        [BAR, 30],
        [ORE, 30],
      ]),
    );
    const quote = p.cost(BAR, [], 50);
    expect([...heldPerCraft([{ itemId: BAR, count: 50, quote }])]).toEqual([
      [BAR, 30],
      [ORE, 20],
    ]);
  });

  describe('one item in two branches of a craft', () => {
    const ALLOY = 30;
    const alloy = recipe(
      401,
      'Alloy',
      'blacksmithing',
      ALLOY,
      [
        [BAR, 1],
        [ORE, 1],
      ],
      1,
    );
    const smeltBar = game.recipes.find((r) => r.name === 'Smelt Bar') as Recipe;
    // No bars listed, so every bar is smelted from ore the direct ore branch also needs.
    const alloyPricer = (held?: Map<number, number>) =>
      new Pricer({
        game: { ...game, items: { ...game.items, [ALLOY]: item('Alloy', 1) } },
        market: {
          ...market,
          prices: new Map<number, PriceStats>([
            [ORE, { min: 15, median: 20, quantity: 100 }],
            [ALLOY, { min: 1000, median: 1000, quantity: 50 }],
          ]),
        },
        vendorBuy: new Map(),
        thresholds: DEFAULT_THRESHOLDS,
        recipes: [smeltBar, alloy],
        ...(held ? { held } : {}),
      });

    test('draw on the holding once', () => {
      // 10 alloys need 20 ore: the bars take the 10 held, the direct ore is bought
      const quote = alloyPricer(new Map([[ORE, 10]])).craftCost(alloy, [], 10);
      expect([...heldPerCraft(quote.parts ?? [], 10)]).toEqual([[ORE, 10]]);
    });

    test('buy along one climb, and say when together they need more than is listed', () => {
      // 60 alloys: 60 ore smelted for bars, then 60 more ore from where those left off
      const quote = alloyPricer().craftCost(alloy, [], 60);
      const [, direct] = quote.parts ?? [];
      // 15 + 5 * 60/100 for the first 60; the next 40 to the 20c middle and 20 past it at 25c
      expect(direct?.quote).toMatchObject({ source: 'auction', after: 60, short: true });
      expect(direct?.quote.unit).toBeCloseTo((100 * 20 - 60 * 18 + 20 * 25) / 60, 9);
      expect(shortfalls(ALLOY, quote)).toEqual([{ itemId: ORE, need: 120, listed: 100 }]);
    });
  });

  test('cheap listings are bought up to where another route is cheaper', () => {
    // Bars climb from 10c to 14c by the 10th of 20; smelted from ore they cost 12c. A bar costs
    // under 12c until the 5th, so 5 are bought and 95 smelted.
    const p = batchPricer(undefined, [
      [ORE, { min: 12, median: 12, quantity: 100_000 }],
      [BAR, { min: 10, median: 14, quantity: 20 }],
    ]);
    const quote = p.cost(BAR, [], 100);
    expect(quote).toMatchObject({ source: 'auction', bought: 5 });
    expect(quote.rest).toMatchObject({ source: 'craft', units: 95, unit: 12 });
    // the first 5 average 10 + 4 * 5/20 = 11
    expect(quote.unit).toBeCloseTo((5 * 11 + 95 * 12) / 100, 9);
  });

  test('a holding only worth using at scale is still found', () => {
    // Bars climb from 13c to 16c at the 50th of 100: one craft buys 4 under the 14.25c held ore
    // nets. A batch buys only the bars under what smelting costs and smelts the rest.
    const ore: Holding[] = [{ itemId: ORE, quantity: 100 }];
    const p = batchPricer(new Map([[ORE, 100]]), [
      [ORE, { min: 15, median: 15, quantity: 1000 }],
      [BAR, { min: 13, median: 16, quantity: 100 }],
    ]);
    expect(recommend(p, [sword], 1).groups.steady[0]?.parts[0]?.quote.source).toBe('auction');
    const [use] = heldUses(p, heldCandidates(p, [sword]), ore, 1).steady;
    // 31 swords take 124 bars. Smelting them all averages 14.40c (100 held at 14.25c, 24 bought
    // at 15c), so the 23 bars under that are bought and 101 smelted: all 100 held ore and 1 more.
    expect(use).toMatchObject({ batch: 31, crafts: 31 });
    expect(use?.parts[0]?.quote).toMatchObject({ source: 'auction', bought: 23 });
    expect((use?.consumes.get(ORE) ?? 0) * 31).toBeCloseTo(100, 9);
  });

  test('a batch grows to every craft the holdings cover when intermediates come in pairs', () => {
    // Ore smelts into 2 bars: one craft smelts a whole ore for its bar, 10 crafts only 5
    const smelt = game.recipes.find((r) => r.name === 'Smelt Bar') as Recipe;
    const pairs = { ...smelt, output: { itemId: BAR, count: 2 } };
    const dagger = recipe(203, 'Dagger', 'blacksmithing', DAGGER, [[BAR, 1]], 1);
    const p = new Pricer({
      game,
      market: {
        ...market,
        prices: new Map([...batchPrices, [DAGGER, { min: 900, median: 900, quantity: 50 }]]),
      },
      vendorBuy: new Map(),
      thresholds: DEFAULT_THRESHOLDS,
      recipes: [pairs, dagger],
      held: new Map([[ORE, 10]]),
    });
    const [use] = heldUses(
      p,
      heldCandidates(p, [dagger]),
      [{ itemId: ORE, quantity: 10 }],
      1,
    ).steady;
    expect(use).toMatchObject({ crafts: 20 });
    expect([...(use?.consumes ?? [])]).toEqual([[ORE, 0.5]]);
  });

  test('the same item held twice counts both', () => {
    const held: Holding[] = [
      { itemId: FLUX, quantity: 10 },
      { itemId: FLUX, quantity: 15 },
    ];
    const p = batchPricer(new Map([[FLUX, 25]]));
    expect(heldUses(p, heldCandidates(p, [sword]), held, 1).steady[0]?.crafts).toBe(25);
    expect(mergeHoldings(held)).toEqual([{ itemId: FLUX, quantity: 25 }]);
  });
});

describe('bronze: every entry point competes', () => {
  const [CU_ORE, TIN_ORE, CU_BAR, TIN_BAR, BRONZE] = [21, 22, 23, 24, 25];
  const smelt = (spellId: number, output: number, reagents: [number, number][], count = 1) => ({
    ...recipe(spellId, 'Smelt', 'mining', output, reagents, 1),
    output: { itemId: output, count },
  });
  const recipes = [
    smelt(1, CU_BAR, [[CU_ORE, 1]]),
    smelt(2, TIN_BAR, [[TIN_ORE, 1]]),
    smelt(
      3,
      BRONZE,
      [
        [CU_BAR, 1],
        [TIN_BAR, 1],
      ],
      2,
    ),
  ];
  const bronzeGame: GameData = {
    build: 'test',
    items: {
      [CU_ORE]: item('Copper Ore', 1),
      [TIN_ORE]: item('Tin Ore', 1),
      [CU_BAR]: item('Copper Bar', 1),
      [TIN_BAR]: item('Tin Bar', 1),
      [BRONZE]: item('Bronze Bar', 1),
    },
    recipes,
  };
  const flat = (price: number, quantity = 100_000): PriceStats => ({
    min: price,
    median: price,
    quantity,
  });
  const base: Record<number, PriceStats> = {
    [CU_ORE]: flat(10),
    [TIN_ORE]: flat(30),
    [CU_BAR]: flat(20),
    [TIN_BAR]: flat(40),
    [BRONZE]: flat(100),
  };

  function bronze(prices: Record<number, PriceStats>, units = 100, held?: Map<number, number>) {
    const p = new Pricer({
      game: bronzeGame,
      market: {
        ...market,
        prices: new Map(Object.entries(prices).map(([id, stats]) => [Number(id), stats])),
      },
      vendorBuy: new Map(),
      thresholds: DEFAULT_THRESHOLDS,
      recipes,
      ...(held ? { held } : {}),
    });
    return p.cost(BRONZE, [], units);
  }

  /** The chosen route as a tree of sources, e.g. craft(auction, craft(auction)). */
  function path(quote: CostQuote | undefined): string {
    if (!quote) return '?';
    if (quote.source === 'craft')
      return `craft(${(quote.parts ?? []).map((p) => path(p.quote)).join(', ')})`;
    if (quote.source === 'held' && quote.rest) return `held ${quote.held} + ${path(quote.rest)}`;
    return quote.source;
  }

  test('ores cheapest: smelt both bars, then bronze', () => {
    expect(path(bronze(base))).toBe('craft(craft(auction), craft(auction))');
    // 1 copper bar at 10c and 1 tin bar at 30c make 2 bronze
    expect(bronze(base).unit).toBe(20);
  });

  test('cheap copper bars are bought, tin is still smelted', () => {
    expect(path(bronze({ ...base, [CU_BAR]: flat(8) }))).toBe('craft(auction, craft(auction))');
  });

  test('cheap tin bars are bought, copper is still smelted', () => {
    expect(path(bronze({ ...base, [TIN_BAR]: flat(25) }))).toBe('craft(craft(auction), auction)');
  });

  test('bronze cheaper than any chain is bought outright', () => {
    expect(path(bronze({ ...base, [BRONZE]: flat(15) }))).toBe('auction');
  });

  test('tin ore missing from the market falls back to tin bars', () => {
    expect(path(bronze({ ...base, [TIN_ORE]: flat(30, 0) }))).toBe(
      'craft(craft(auction), auction)',
    );
  });

  test('held tin ore goes first and the rest is bought', () => {
    const quote = bronze(base, 100, new Map([[TIN_ORE, 40]]));
    expect(path(quote)).toBe('craft(craft(auction), craft(held 40 + auction))');
  });

  test('an odd quantity takes whole crafts, and a spare worth more than it cost only covers itself', () => {
    // 3 bronze: 2 crafts at 40c make 4 at 20c each; the spare would net 95c, credited 20c
    const quote = bronze(base, 3);
    expect(quote).toMatchObject({ source: 'craft', crafts: 2, surplus: 1 });
    expect(quote.unit).toBe(20);
  });

  test('a spare that sells under its cost raises what the wanted units cost', () => {
    // Nothing listed: the spare goes to a merchant for 1c
    const quote = bronze({ ...base, [BRONZE]: flat(100, 0) }, 3);
    expect(quote.unit).toBe((80 - 1) / 3);
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
    expect(reasonsOf(p, result.groups.vendor[0])).toEqual([
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
    expect(result.groups.steady[0]?.warnings.map(en.warning)).toEqual([
      'vendor pays 10s00c/u; the auction adds less than one ~50c/u deposit',
    ]);
  });

  test('a deposit above the profit of a sale is flagged', () => {
    // cost 2 * 480 = 960, nets 1045: profit 85 against a 600 deposit
    const { result } = evaluate({ median: 1100, min: 1100, quantity: 50 }, 480);
    expect(result.groups.steady[0]?.warnings.map(en.warning)).toEqual([
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

describe('translated names', () => {
  const sword = game.recipes.find((r) => r.name === 'Sword') as Recipe;
  const translated: GameData = {
    ...game,
    localNames: {
      ru: localNames(
        game,
        [
          { ID: String(BAR), Display_lang: 'Слиток' },
          { ID: '999', Display_lang: 'Чужой предмет' },
        ],
        [{ ID: String(sword.spellId), Name_lang: 'Меч' }],
      ),
    },
  };
  const p = new Pricer({
    game: translated,
    market,
    vendorBuy: new Map(),
    thresholds: DEFAULT_THRESHOLDS,
    recipes: translated.recipes,
  });

  test('only known items and recipes keep a translation', () => {
    expect(translated.localNames?.ru).toEqual({
      items: { [BAR]: 'Слиток' },
      recipes: { [sword.spellId]: 'Меч' },
    });
  });

  test('names fall back to English where no translation is cached', () => {
    expect(p.name(BAR, 'ru')).toBe('Слиток');
    expect(p.name(BAR)).toBe('Bar');
    expect(p.name(ORE, 'ru')).toBe('Ore');
    expect(p.recipeName(sword, 'ru')).toBe('Меч');
    expect(p.recipeName(sword, 'en')).toBe('Sword');
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
