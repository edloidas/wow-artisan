import { afterEach, describe, expect, test } from 'bun:test';
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Advisor } from '../src/advisor.ts';
import type { GameData, ItemInfo, Recipe } from '../src/gamedata/types.ts';
import type { Inventory } from '../src/inventory/syndicator.ts';
import { createServer, type itemPriceJson, type ServerDeps, VIEW_URI } from '../src/mcp/server.ts';
import { buildView, inlineScript } from '../src/mcp/view-build.ts';
import type { Market, PriceStats } from '../src/prices/types.ts';
import type { materialsJson, recommendationsJson } from '../src/serialize.ts';

const ORE = 1;
const BAR = 2;
const SWORD = 3;
const PICK = 4;
const PLAN = 5;
const CHAIN = 6;
const BRACERS = 7;

function item(name: string, sellPrice: number): ItemInfo {
  return {
    name,
    sellPrice,
    buyPrice: 0,
    quality: 1,
    itemLevel: 10,
    requiredLevel: 5,
    boundOnPickup: false,
  };
}

function recipe(
  spellId: number,
  name: string,
  profession: Recipe['profession'],
  output: number,
  reagents: [number, number][],
  learnSkill: number,
  planItemId?: number,
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
    ...(planItemId === undefined ? {} : { planItemId }),
  };
}

const game: GameData = {
  build: 'test',
  items: {
    [ORE]: item('Copper Ore', 5),
    [BAR]: item('Copper Bar', 10),
    [SWORD]: item('Copper Sword', 100),
    [PICK]: item('Mining Pick', 400),
    [PLAN]: item('Plans: Mining Pick', 0),
    [CHAIN]: item('Iron Chain', 500),
    [BRACERS]: item('Iron Bracers', 300),
  },
  recipes: [
    recipe(101, 'Smelt Copper', 'mining', BAR, [[ORE, 2]], 1),
    recipe(201, 'Copper Sword', 'blacksmithing', SWORD, [[BAR, 4]], 20),
    recipe(202, 'Mining Pick', 'blacksmithing', PICK, [[BAR, 3]], 40, PLAN),
    recipe(203, 'Iron Chain', 'blacksmithing', CHAIN, [[BAR, 1]], 10),
    recipe(204, 'Iron Bracers', 'blacksmithing', BRACERS, [[BAR, 1]], 15),
  ],
  localNames: { ru: { items: { [ORE]: 'Медная руда' }, recipes: { 201: 'Медный меч' } } },
};

const LATEST = '2026-09-29';
const history = ['2026-09-27', '2026-09-28', LATEST].map((date) => ({ date, min: 1900 }));
const seen = (min: number, quantity: number): PriceStats => ({
  min,
  quantity,
  lastSeen: LATEST,
  history: history.map((day) => ({ ...day, min })),
});

const market: Market = {
  id: 'auctionator:Test',
  label: 'Auctionator (Test)',
  source: 'auctionator',
  latestScan: LATEST,
  prices: new Map([
    [ORE, seen(20, 500)],
    [BAR, seen(100, 300)],
    [SWORD, seen(1900, 50)],
    [PICK, seen(5000, 40)],
    [BRACERS, seen(400, 50)],
  ]),
};

const inventory: Inventory = {
  characters: [],
  totals: new Map([
    [ORE, 40],
    [PLAN, 1],
  ]),
  names: new Map(),
};

/** The local calendar day of the latest scan, so the data is fresh. */
const FRESH = new Date(2026, 8, 29, 12);
const STALE = new Date(2026, 9, 3, 12);

let client: Client | undefined;

async function connect(overrides: Partial<ServerDeps> = {}): Promise<Client> {
  const advisor = Advisor.fromData({ game, market, inventory });
  const server = createServer({
    advisorFor: async () => advisor,
    listMarkets: async () => {
      throw new Error('offline');
    },
    now: () => FRESH,
    view: async () => '<!doctype html><html><body>view</body></html>',
    ...overrides,
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: 'test', version: '1' });
  await client.connect(clientSide);
  return client;
}

afterEach(async () => {
  await client?.close();
  client = undefined;
});

type Payloads = {
  recommend_crafts: ReturnType<typeof recommendationsJson>;
  evaluate_materials: ReturnType<typeof materialsJson>;
  item_price: ReturnType<typeof itemPriceJson>;
  find_items: { items: { itemId: number; name: string; url: string }[] };
  list_markets: { markets: { id: string; label: string }[]; warnings: string[] };
};

function row<T extends { spellId: number }>(group: { top: T[] } | undefined, spellId: number): T {
  const found = group?.top.find((r) => r.spellId === spellId);
  if (!found) throw new Error(`No row for spell ${spellId}`);
  return found;
}

function spells(data: Payloads['recommend_crafts']): number[] {
  return Object.values(data.groups).flatMap((g) => g.top.map((r) => r.spellId));
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  return (await c.callTool({ name, arguments: args })) as CallToolResult;
}

/** The structured payload, after checking the text block carries the same JSON. */
async function payload<K extends keyof Payloads>(
  c: Client,
  name: K,
  args: Record<string, unknown> = {},
): Promise<Payloads[K]> {
  const result = await call(c, name, args);
  expect(result.isError).toBeFalsy();
  const [text] = result.content;
  expect(text?.type).toBe('text');
  expect(JSON.parse((text as { text: string }).text)).toEqual(result.structuredContent);
  return result.structuredContent as Payloads[K];
}

function errorText(result: CallToolResult): string {
  expect(result.isError).toBe(true);
  return (result.content[0] as { text: string }).text;
}

describe('tool list', () => {
  test('all tools are read-only, and the three result tools point at the view', async () => {
    const { tools } = await (await connect()).listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'evaluate_materials',
      'find_items',
      'item_price',
      'list_markets',
      'recommend_crafts',
    ]);
    const views = Object.fromEntries(
      tools.map((t) => [
        t.name,
        (t._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri,
      ]),
    );
    expect(views).toEqual({
      recommend_crafts: VIEW_URI,
      evaluate_materials: VIEW_URI,
      item_price: VIEW_URI,
      find_items: undefined,
      list_markets: undefined,
    });
    expect(tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name)).toEqual(
      [],
    );
  });

  test('serves the view as an MCP Apps resource', async () => {
    const c = await connect();
    const { resources } = await c.listResources();
    expect(resources.map((r) => r.uri)).toContain(VIEW_URI);
    const { contents } = await c.readResource({ uri: VIEW_URI });
    expect(contents[0]).toEqual({
      uri: VIEW_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: '<!doctype html><html><body>view</body></html>',
    });
  });
});

describe('view', () => {
  test('bundles into one HTML file with the script inline', async () => {
    const html = await buildView();
    expect(html).toStartWith('<!doctype html>');
    expect(html).toContain('<script type="module">');
    expect(html).not.toContain('<!-- view.js -->');
    expect(html).not.toMatch(/<script[^>]+src=/);
    const body = /<script type="module">([\s\S]*)<\/script>/.exec(html)?.[1] ?? '';
    expect(body.length).toBeGreaterThan(10_000);
  });

  test('a closing script tag inside the bundle cannot end the inline tag', () => {
    expect(inlineScript('<body><!-- view.js --></body>', 'a("</script>")')).toBe(
      '<body><script type="module">a("<\\/script>")</script></body>',
    );
  });
});

describe('recommend_crafts', () => {
  test('rows carry the list, net and vendor prices, deposits and what an unsold listing costs', async () => {
    const data = await payload(await connect(), 'recommend_crafts', {
      profession: 'blacksmithing',
      craftWith: ['mining'],
    });
    expect(Object.keys(data.groups).sort()).toEqual(
      ['no-market', 'steady', 'thin', 'vendor', 'volatile'].sort(),
    );
    expect(data.warnings).toEqual([]);
    expect(data.market).toMatchObject({ latestScan: LATEST, scanAgeDays: 0, stale: false });
    expect(data.listingHours).toBe(24);
    const sword = row(data.groups.steady, 201);
    // 4 bars smelted from 8 ore at 20c; listed at the cheapest 1900c, netting 95%.
    expect(sword).toMatchObject({
      cost: 160,
      sellVia: 'auction',
      listUnit: 1900,
      netUnit: 1805,
      vendorUnit: 100,
      ifSold: 1645,
      ifVendored: -60,
      depositEstimate: 60,
      ifUnsold: -120,
      learnedFrom: 'trainer',
      warnings: [],
      recipeUrl: 'https://www.wowhead.com/forever/spell=201',
    });
    expect(sword.materials).toEqual([
      expect.objectContaining({ itemId: BAR, count: 4, unitCost: 40, source: 'craft' }),
    ]);
  });

  test('a product nobody lists goes to a merchant, and a thin auction premium is flagged', async () => {
    const data = await payload(await connect(), 'recommend_crafts', {
      profession: 'blacksmithing',
      craftWith: ['mining'],
    });
    // One 40c bar each. The chain has no auction, so it sells to a merchant for 500c.
    expect(row(data.groups.vendor, 203)).toMatchObject({
      sellVia: 'vendor',
      listUnit: undefined,
      netUnit: 500,
      vendorUnit: 500,
      ifSold: 460,
      ifVendored: 460,
      ifUnsold: undefined,
      warnings: [],
    });
    // Bracers net 380c at auction, only 80c over the merchant's 300c: less than a 180c deposit.
    expect(row(data.groups.steady, 204)).toMatchObject({
      sellVia: 'auction',
      listUnit: 400,
      netUnit: 380,
      ifSold: 340,
      depositEstimate: 180,
      warnings: ['vendor pays 3s00c/u; the auction adds less than one ~1s80c/u deposit'],
    });
  });

  test('listingHours sets the deposit, and trainerOnly drops plan recipes', async () => {
    const c = await connect();
    const all = await payload(c, 'recommend_crafts', { profession: 'blacksmithing' });
    expect(spells(all)).toContain(202);

    const short = await payload(c, 'recommend_crafts', {
      profession: 'blacksmithing',
      listingHours: 2,
      trainerOnly: true,
    });
    expect(short.listingHours).toBe(2);
    expect(spells(short)).not.toContain(202);
    const sword = row(short.groups.steady, 201);
    expect(sword.depositEstimate).toBe(5);
  });

  test('old scans add a top-level warning', async () => {
    const data = await payload(await connect({ now: () => STALE }), 'recommend_crafts', {
      profession: 'blacksmithing',
    });
    expect(data.market).toMatchObject({ scanAgeDays: 4, stale: true });
    expect(data.warnings).toEqual([
      'Prices are 4 days old; ask the player to scan the auction house and /reload.',
    ]);
  });

  test('Russian names sit beside the English ones, and links follow the language', async () => {
    const data = await payload(await connect({ lang: 'ru' }), 'recommend_crafts', {
      profession: 'blacksmithing',
      craftWith: ['mining'],
    });
    const sword = row(data.groups.steady, 201);
    expect(sword).toMatchObject({
      recipe: 'Copper Sword',
      recipeLocalName: 'Медный меч',
      recipeUrl: 'https://www.wowhead.com/forever/ru/spell=201',
      product: { url: 'https://www.wowhead.com/forever/ru/item=3' },
    });
    expect(sword.materials[0]?.url).toBe('https://www.wowhead.com/forever/ru/item=2');
  });

  test('the schema rejects listing hours Forever lacks, and unknown professions', async () => {
    const c = await connect();
    expect(
      errorText(
        await call(c, 'recommend_crafts', { profession: 'blacksmithing', listingHours: 5 }),
      ),
    ).toContain('listingHours');
    expect(errorText(await call(c, 'recommend_crafts', { profession: 'alchemy' }))).toContain(
      'profession',
    );
  });

  test('an amount that does not parse is a tool error', async () => {
    const result = await call(await connect(), 'recommend_crafts', {
      profession: 'blacksmithing',
      minProfit: '5x',
    });
    expect(errorText(result)).toBe('Invalid amount: 5x');
  });
});

describe('evaluate_materials', () => {
  test('values named holdings sold as is and the crafts that beat selling them', async () => {
    const data = await payload(await connect(), 'evaluate_materials', {
      profession: 'blacksmithing',
      craftWith: ['mining'],
      items: [{ item: 'copper ore', quantity: 40 }],
    });
    expect(data.holdings).toEqual([
      expect.objectContaining({
        itemId: ORE,
        quantity: 40,
        marketUnits: 500,
        sell: { via: 'auction', listUnit: 20, netUnit: 19, vendorUnit: 5, total: 760 },
      }),
    ]);
    const sword = row(data.groups.steady, 201);
    // Held ore costs the 19c it nets, so a bar costs 38c and a sword 152c: 1805 - 152 per craft.
    expect(sword).toMatchObject({
      cost: 152,
      ifSold: 1653,
      crafts: 5,
      gain: 8265,
      consumes: [expect.objectContaining({ itemId: ORE, perCraft: 8, total: 40 })],
    });
  });

  test('reads the saved inventory, keeping only materials in scope', async () => {
    const data = await payload(await connect(), 'evaluate_materials', {
      profession: 'blacksmithing',
      craftWith: ['mining'],
      fromInventory: true,
    });
    expect(data.holdings.map((h) => h.itemId)).toEqual([ORE]);
  });

  test('needs items or the inventory', async () => {
    const c = await connect();
    expect(errorText(await call(c, 'evaluate_materials', { profession: 'blacksmithing' }))).toBe(
      'Pass items, or fromInventory: true',
    );
  });

  test('an item name that matches nothing is a tool error', async () => {
    expect(
      errorText(
        await call(await connect(), 'evaluate_materials', {
          profession: 'blacksmithing',
          items: [{ item: 'Unobtainium', quantity: 1 }],
        }),
      ),
    ).toBe("No item matches 'Unobtainium'");
  });
});

describe('item_price', () => {
  test('returns the sale, market status and the cheapest way to obtain an item', async () => {
    const data = await payload(await connect(), 'item_price', { item: 'Copper Bar' });
    expect(data.item).toMatchObject({
      itemId: BAR,
      name: 'Copper Bar',
      url: 'https://www.wowhead.com/forever/item=2',
    });
    expect(data.sell).toEqual({ via: 'auction', listUnit: 100, netUnit: 95, vendorUnit: 10 });
    expect(data.status).toEqual({ status: 'stable', reasons: [] });
    expect(data.stats?.history).toHaveLength(3);
    expect(data.cheapestToObtain).toMatchObject({
      unit: 40,
      source: 'craft',
      recipe: 'Smelt Copper',
    });
    expect(data.warnings).toEqual([]);
  });

  test('an unknown item is a tool error', async () => {
    expect(errorText(await call(await connect(), 'item_price', { item: 'Unobtainium' }))).toBe(
      "No item matches 'Unobtainium'",
    );
  });
});

describe('find_items', () => {
  test('matches English and translated names, with links', async () => {
    const c = await connect();
    expect((await payload(c, 'find_items', { query: 'copper' })).items).toEqual([
      expect.objectContaining({ itemId: ORE, name: 'Copper Ore' }),
      expect.objectContaining({ itemId: BAR, name: 'Copper Bar' }),
      expect.objectContaining({ itemId: SWORD, name: 'Copper Sword' }),
    ]);
    expect((await payload(c, 'find_items', { query: 'руда' })).items).toEqual([
      { itemId: ORE, name: 'Copper Ore', url: 'https://www.wowhead.com/forever/item=1' },
    ]);
  });
});

describe('list_markets', () => {
  test('keeps local scans available when AHledger cannot be reached, and says so', async () => {
    const data = await payload(await connect(), 'list_markets');
    expect(data.markets).toEqual([{ id: 'auctionator', label: expect.any(String) }]);
    expect(data.warnings).toEqual(["AHledger's market list could not be fetched."]);
  });

  test('lists AHledger markets by the id other tools take', async () => {
    const data = await payload(
      await connect({
        listMarkets: async () => [
          {
            id: 'forever.normal.alliance.us',
            label: 'Forever Alliance',
            game: 'wow',
            region: 'us',
          },
        ],
      }),
      'list_markets',
    );
    expect(data.markets.at(-1)).toEqual({
      id: 'ahledger:forever.normal.alliance.us',
      label: 'Forever Alliance (US, AHledger)',
    });
    expect(data.warnings).toEqual([]);
  });
});
