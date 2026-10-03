#!/usr/bin/env bun
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Advisor, type Scope } from './advisor.ts';
import { referencePrice } from './engine/classify.ts';
import type { Holding } from './engine/materials.ts';
import type { ListingHours } from './engine/pricer.ts';
import { PROFESSIONS, type Profession } from './gamedata/types.ts';
import { resolveLang } from './i18n/index.ts';
import { parseMoney } from './money.ts';
import { listAhledgerMarkets } from './prices/ahledger.ts';
import {
  classificationJson,
  localName,
  marketJson,
  marketWarnings,
  materialsJson,
  partsJson,
  recommendationsJson,
  saleJson,
} from './serialize.ts';
import { wowheadUrl } from './wowhead.ts';

/** Wowhead links follow WOW_ARTISAN_LANG; the payload text stays English for the agent. */
const lang = resolveLang();

/** Saved scans and AHledger tables change slowly; reload an advisor after this long. */
const ADVISOR_TTL_MS = 5 * 60_000;

const advisors = new Map<string, { advisor: Promise<Advisor>; createdAt: number }>();

function advisorFor(market: string | undefined): Promise<Advisor> {
  const key = market ?? '';
  const cached = advisors.get(key);
  if (cached && Date.now() - cached.createdAt < ADVISOR_TTL_MS) return cached.advisor;
  const advisor = Advisor.create(market ? { market } : {});
  advisor.catch(() => advisors.delete(key));
  advisors.set(key, { advisor, createdAt: Date.now() });
  return advisor;
}

const professionNames = Object.keys(PROFESSIONS) as [Profession, ...Profession[]];
const profession = z.enum(professionNames).describe('Profession to advise on');
const market = z
  .string()
  .optional()
  .describe(
    "Price source: 'auctionator' (the player's own scans, default), 'auctionator:<realm>', or 'ahledger:<market id>' (see list_markets)",
  );
const maxSkill = z
  .number()
  .int()
  .positive()
  .optional()
  .describe('Player skill; hides recipes that need more to learn');
const craftWith = z
  .array(z.enum(professionNames))
  .optional()
  .describe('Other professions allowed to make intermediates, e.g. mining to smelt bars');
const trainerOnly = z
  .boolean()
  .optional()
  .describe('Hide recipes taught by plan items, keeping those a trainer teaches');
const listingHours = z
  .union([z.literal(2), z.literal(8), z.literal(24)])
  .optional()
  .describe(
    "Auction listing hours for the deposit (default: the player's Auctionator setting, else 24)",
  );

function scopeOf(args: {
  profession: Profession;
  maxSkill?: number | undefined;
  minSkill?: number | undefined;
  craftWith?: Profession[] | undefined;
  listingHours?: ListingHours | undefined;
  trainerOnly?: boolean | undefined;
}): Scope {
  const scope: Scope = { profession: args.profession };
  if (args.maxSkill !== undefined) scope.maxSkill = args.maxSkill;
  if (args.minSkill !== undefined) scope.minSkill = args.minSkill;
  if (args.craftWith?.length) scope.craftWith = args.craftWith;
  if (args.listingHours !== undefined) scope.listingHours = args.listingHours;
  if (args.trainerOnly) scope.trainerOnly = true;
  return scope;
}

function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

const server = new McpServer({ name: 'wow-artisan', version: '0.1.0' });

server.registerTool(
  'recommend_crafts',
  {
    title: 'Recommend profitable crafts',
    description:
      'Recipes with a positive margin from bought or crafted materials, grouped by where the product sells and the health of its markets: steady (enough units, stable asking prices, seen on most recent full scans), vendor (sold to a merchant, no auction risk), volatile, thin (few units, missing from the latest scan, or seen on few scans) and no-market. Each row has the auction price to list at, what a merchant pays, profit if sold and if a listing expires once (losing its deposit) and the units go to a merchant, and warnings when a deposit outweighs what the auction earns. ifSold assumes every unit sells; nothing records sales, so it is not a forecast. Pass on any top-level warnings. Items and recipes carry Wowhead urls; link their names with them. Copper amounts: 10000 = 1g.',
    inputSchema: {
      profession,
      maxSkill,
      minSkill: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Hide recipes learnable below this skill'),
      minProfit: z
        .union([z.string(), z.number()])
        .optional()
        .describe(
          "Minimum profit per craft, e.g. '50s', '1g20s', or copper as a number (default 1s)",
        ),
      craftWith,
      trainerOnly,
      listingHours,
      market,
      limit: z
        .number()
        .int()
        .positive()
        .max(50)
        .optional()
        .describe('Rows per category (default 8)'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args) => {
    const advisor = await advisorFor(args.market);
    const { pricer, result } = advisor.recommend(scopeOf(args), parseMoney(args.minProfit ?? '1s'));
    return json(recommendationsJson(pricer, result, args.limit ?? 8, lang));
  },
);

server.registerTool(
  'evaluate_materials',
  {
    title: 'Sell materials or craft them',
    description:
      'For materials the player holds: what selling each as is brings, and the recipes that earn more than that, following chains like ore -> bar -> item. Each use has the same fields as recommend_crafts, with the holdings costing what selling them nets, plus crafts (whole crafts the holdings cover, buying the other reagents) and gain (copper above selling the holdings those crafts use). Uses compete for the same holdings, so gains do not add up. Pass on any top-level warnings. Items and recipes carry Wowhead urls; link their names with them.',
    inputSchema: {
      profession,
      items: z
        .array(
          z.object({
            item: z.string().describe('Item name or id'),
            quantity: z.number().int().positive(),
          }),
        )
        .optional()
        .describe('Materials to evaluate'),
      fromInventory: z
        .boolean()
        .optional()
        .describe(
          "Use every in-scope material from the player's saved Syndicator inventory instead",
        ),
      maxSkill,
      craftWith,
      trainerOnly,
      listingHours,
      minProfit: z
        .union([z.string(), z.number()])
        .optional()
        .describe(
          "Minimum gain per craft over selling the holdings, e.g. '10s', or copper (default 1)",
        ),
      market,
      limit: z
        .number()
        .int()
        .positive()
        .max(20)
        .optional()
        .describe('Uses per category (default 5)'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args) => {
    const advisor = await advisorFor(args.market);
    const scope = scopeOf(args);
    const holdings: Holding[] = args.fromInventory
      ? advisor.ownedMaterials(scope)
      : (args.items ?? []).map(({ item, quantity }) => ({
          itemId: advisor.resolveItem(item),
          quantity,
        }));
    if (holdings.length === 0) throw new Error('Pass items, or fromInventory: true');
    const { pricer, report } = advisor.materials(scope, holdings, parseMoney(args.minProfit ?? 1));
    return json(materialsJson(pricer, report, args.limit ?? 5, lang));
  },
);

server.registerTool(
  'item_price',
  {
    title: 'Item price and market health',
    description:
      'Market stats for one item: cheapest listing, usual price, listed quantity, history, market status, the cheapest way to obtain it, the auction price to list it at, what that nets, and what a merchant pays.',
    inputSchema: {
      item: z.string().describe('Item name or id'),
      market,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args) => {
    const advisor = await advisorFor(args.market);
    const itemId = advisor.resolveItem(args.item);
    const pricer = advisor.pricer({ profession: 'blacksmithing', craftWith: ['mining'] });
    const stats = advisor.market.prices.get(itemId);
    const cost = pricer.cost(itemId);
    const sale = pricer.sale(itemId);
    return json({
      market: marketJson(advisor.market),
      warnings: marketWarnings(advisor.market),
      item: {
        itemId,
        name: pricer.name(itemId),
        localName: localName(pricer, itemId, lang),
        url: wowheadUrl('item', itemId, lang),
        info: advisor.game.items[itemId],
      },
      stats: stats ?? null,
      usualPrice: referencePrice(stats),
      status: classificationJson(pricer.classification(itemId)),
      cheapestToObtain: {
        unit: cost.unit === undefined ? undefined : Math.round(cost.unit),
        source: cost.source,
        recipe: cost.recipe?.name,
        recipeUrl: cost.recipe && wowheadUrl('spell', cost.recipe.spellId, lang),
        materials: cost.parts ? partsJson(pricer, cost.parts, lang) : undefined,
      },
      sell: saleJson(sale),
    });
  },
);

server.registerTool(
  'find_items',
  {
    title: 'Find items by name',
    description: 'Search item names, English or translated; returns ids usable in the other tools.',
    inputSchema: {
      query: z.string().describe('Part of the item name, or an id'),
      limit: z.number().int().positive().max(50).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async (args) => {
    const advisor = await advisorFor(undefined);
    const pricer = advisor.pricer({ profession: 'blacksmithing' });
    return json(
      advisor.findItems(args.query, args.limit ?? 10).map((item) => ({
        ...item,
        localName: localName(pricer, item.itemId, lang),
        url: wowheadUrl('item', item.itemId, lang),
      })),
    );
  },
);

server.registerTool(
  'list_markets',
  {
    title: 'List price sources',
    description:
      "Available markets: the player's own Auctionator scans, and AHledger's public US WoW Forever markets.",
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => {
    const ahledger = await listAhledgerMarkets().catch(() => []);
    return json([
      { id: 'auctionator', label: "The player's own Auctionator scans (default)" },
      ...ahledger.map((m) => ({
        id: `ahledger:${m.id}`,
        label: `${m.label} (${m.region.toUpperCase()}, AHledger)`,
      })),
    ]);
  },
);

await server.connect(new StdioServerTransport());
