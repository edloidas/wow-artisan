import { describe, expect, test } from 'bun:test';
import { classify, DEFAULT_THRESHOLDS, referencePrice } from '../src/engine/classify.ts';
import { MaterialAdvisor } from '../src/engine/materials.ts';
import { Pricer } from '../src/engine/pricer.ts';
import { recommend, selectRecipes } from '../src/engine/recommend.ts';
import type { GameData, ItemInfo, Recipe } from '../src/gamedata/types.ts';
import type { Market, PriceStats } from '../src/prices/types.ts';

const ORE = 1;
const BAR = 2;
const FLUX = 3;
const SWORD = 4;
const HELM = 5;
const DAGGER = 6;

function item(name: string, sellPrice: number, boundOnPickup = false): ItemInfo {
  return { name, sellPrice, quality: 1, itemLevel: 10, requiredLevel: 5, boundOnPickup };
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

describe('Pricer', () => {
  test('buys a reagent when nothing cheaper is in scope', () => {
    expect(pricer(['blacksmithing']).cost(BAR)).toMatchObject({ unit: 100, source: 'auction' });
  });

  test('crafts an intermediate when a helper profession makes it cheaper', () => {
    expect(pricer(['blacksmithing', 'mining']).cost(BAR)).toMatchObject({
      unit: 20,
      source: 'craft',
    });
  });

  test('sells at the lower of the cheapest listing and the usual price, after cut and deposit', () => {
    // min(1900, 1950) * 0.95 - 100 vendor * 0.15
    expect(pricer(['blacksmithing']).sale(SWORD)).toMatchObject({ unit: 1790, via: 'auction' });
  });
});

describe('recommend', () => {
  test('filters by skill, skips bind-on-pickup products, and groups by market health', () => {
    const p = pricer(['blacksmithing', 'mining']);
    const inRange = selectRecipes(game.recipes, { profession: 'blacksmithing', maxSkill: 100 });
    const result = recommend(p, inRange, 0);
    expect(result.considered).toBe(2);
    expect(result.bound).toBe(1);
    expect(result.groups.reliable.map((e) => [e.recipe.name, e.profit])).toEqual([
      ['Sword', 1790 - (4 * 20 + 50)],
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
    expect(result.groups.reliable).toEqual([]);
    expect(result.groups.thin).toEqual([]);
  });
});

describe('MaterialAdvisor', () => {
  test('compares selling with crafting and caps crafts at what the product market lists', () => {
    const p = pricer(['blacksmithing']);
    const advisor = new MaterialAdvisor(
      p,
      game.recipes.filter((r) => r.profession === 'blacksmithing'),
    );
    const report = advisor.report({ itemId: BAR, quantity: 100 });
    // min(95, 100) * 0.95 - 10 * 0.15
    expect(report.sale.unit).toBe(88.75);

    const dagger = report.uses.find((u) => u.recipe.name === 'Dagger');
    expect(dagger).toMatchObject({ crafts: 2, capped: true });
    expect(dagger?.totalWithRest).toBe((dagger?.total ?? 0) + 96 * 88.75);

    const sword = report.uses.find((u) => u.recipe.name === 'Sword');
    expect(sword).toMatchObject({ crafts: 25, capped: false, need: 4 });
    expect(sword?.perUnit).toBe((1790 - 50) / 4);
  });

  test('follows a chain: ore is worth what the best item made from its bar earns', () => {
    const p = pricer(['blacksmithing', 'mining']);
    const advisor = new MaterialAdvisor(p, game.recipes);
    const [best] = advisor.report({ itemId: ORE, quantity: 10 }).uses;
    expect(best?.recipe.name).toBe('Smelt Bar');
    expect(best?.route).toStartWith('Sword');
  });
});
