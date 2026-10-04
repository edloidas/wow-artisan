#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { Advisor, type Helper, helpersOf, isProfession, type Scope } from './advisor.ts';
import type { Thresholds } from './engine/classify.ts';
import { type HeldUse, type Holding, type HoldingSale, heldPerCraft } from './engine/materials.ts';
import {
  type CostQuote,
  DEPOSIT_RATES,
  isListingHours,
  type Pricer,
  shortfalls,
} from './engine/pricer.ts';
import type { Category, Evaluation } from './engine/recommend.ts';
import { loadGameData } from './gamedata/load.ts';
import {
  type HoldingLine,
  type Lang,
  type Messages,
  messages,
  reasonText,
  resolveLang,
} from './i18n/index.ts';
import { parseMoney } from './money.ts';
import { listAhledgerMarkets } from './prices/ahledger.ts';
import { marketFreshness } from './prices/freshness.ts';
import { materialsJson, obtainJson, recommendationsJson } from './serialize.ts';
import { FALLBACK_BUILD, findInstallation } from './wow.ts';
import { wowheadUrl } from './wowhead.ts';

const MAX_NAME_WIDTH = 46;

/** Output language and whether names become terminal hyperlinks. */
type Out = { t: Messages; lang: Lang; links: boolean };

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      profession: { type: 'string', short: 'p' },
      skill: { type: 'string', short: 's' },
      'min-skill': { type: 'string' },
      'trainer-only': { type: 'boolean' },
      'min-profit': { type: 'string' },
      crafts: { type: 'string' },
      hours: { type: 'string' },
      'craft-with': { type: 'string', multiple: true },
      market: { type: 'string', short: 'm' },
      have: { type: 'string', multiple: true },
      inventory: { type: 'boolean' },
      limit: { type: 'string', short: 'n' },
      details: { type: 'boolean' },
      json: { type: 'boolean' },
      lang: { type: 'string' },
      build: { type: 'string' },
      thin: { type: 'string' },
      spread: { type: 'string' },
      swing: { type: 'string' },
      trend: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const lang = resolveLang(values.lang);
  const out: Out = { t: messages(lang), lang, links: process.stdout.isTTY === true };
  const { t } = out;
  const [command] = positionals;
  if (!command || values.help) {
    console.log(t.usage);
    return;
  }

  if (command === 'markets') {
    const markets = await listAhledgerMarkets();
    console.log(`${'auctionator'.padEnd(23)}${t.ownScans}`);
    for (const market of markets) console.log(`ahledger:${market.id.padEnd(26)} ${market.label}`);
    return;
  }

  if (command === 'sync') {
    const build = values.build ?? findInstallation()?.build ?? FALLBACK_BUILD;
    const data = await loadGameData(build, true);
    console.log(t.synced(data.build, data.recipes.length, Object.keys(data.items).length));
    return;
  }

  const thresholds: Partial<Thresholds> = {};
  if (values.thin) thresholds.thinQuantity = Number(values.thin);
  if (values.spread) thresholds.maxSpread = Number(values.spread);
  if (values.swing) thresholds.maxSwing = Number(values.swing);
  if (values.trend) thresholds.maxTrend = Number(values.trend);

  const options: Parameters<typeof Advisor.create>[0] = { thresholds };
  if (values.market) options.market = values.market;
  if (values.build) options.build = values.build;
  const advisor = await Advisor.create(options);
  const scope = parseScope(values);
  const limit = values.limit ? Number(values.limit) : 10;

  if (command === 'recipes') {
    const minProfit = parseMoney(values['min-profit'] ?? '1s');
    const crafts = values.crafts === undefined ? 1 : Number(values.crafts);
    if (!Number.isSafeInteger(crafts) || crafts < 1)
      throw new Error(`--crafts takes a positive whole number, got '${values.crafts}'`);
    const { pricer, result } = advisor.recommend(scope, minProfit, crafts);
    if (values.json) {
      console.log(JSON.stringify(recommendationsJson(pricer, result, limit, lang), null, 2));
      return;
    }
    printHeader(out, advisor, scope);
    if (crafts > 1) console.log(t.batch(crafts));
    console.log(`${t.summary(result.considered, result.unpriced, result.bound, minProfit)}\n`);
    for (const [category, list] of Object.entries(result.groups) as [Category, Evaluation[]][]) {
      printGroup(out, pricer, category, list, {
        limit,
        details: values.details ?? false,
        columns: columnsFor(t, pricer, category),
      });
    }
    printRecipeNotes(t, advisor, pricer);
    return;
  }

  if (command === 'materials') {
    const holdings: Holding[] = values.inventory
      ? advisor.ownedMaterials(scope)
      : (values.have ?? []).map((spec) => parseHolding(advisor, spec));
    if (holdings.length === 0) throw new Error('Nothing to evaluate: pass --have or --inventory');
    const minProfit = parseMoney(values['min-profit'] ?? '1c');
    const { pricer, report } = advisor.materials(scope, holdings, minProfit);
    if (values.json) {
      console.log(JSON.stringify(materialsJson(pricer, report, limit, lang), null, 2));
      return;
    }
    printHeader(out, advisor, scope);
    printHoldings(out, pricer, report.holdings);
    const groups = Object.entries(report.groups) as [Category, HeldUse[]][];
    if (groups.every(([, list]) => list.length === 0)) {
      console.log(t.noGainfulRecipe(minProfit));
      return;
    }
    for (const [category, list] of groups) {
      printGroup(out, pricer, category, list, {
        limit,
        details: values.details ?? false,
        columns: heldColumnsFor(t, category),
        note: (e) => t.uses(heldList(out, pricer, e.consumes, e.crafts)),
      });
    }
    printMaterialNotes(t, pricer);
    return;
  }

  if (command === 'obtain') {
    const [, target] = positionals;
    if (!target) throw new Error('Name what to obtain, e.g. obtain "Bronze Bar:100"');
    const wanted = target.includes(':')
      ? parseHolding(advisor, target)
      : { itemId: advisor.resolveItem(target), quantity: 1 };
    const holdings: Holding[] = values.inventory
      ? advisor.inventoryHoldings()
      : (values.have ?? []).map((spec) => parseHolding(advisor, spec));
    const { pricer, routes } = advisor.obtain(scope, wanted.itemId, wanted.quantity, holdings);
    if (values.json) {
      console.log(JSON.stringify(obtainJson(pricer, wanted, routes, lang), null, 2));
      return;
    }
    printHeader(out, advisor, scope);
    printRoutes(out, pricer, wanted, routes);
    return;
  }

  throw new Error(`Unknown command '${command}'\n\n${t.usage}`);
}

function parseScope(values: Record<string, unknown>): Scope {
  const profession = String(values.profession ?? '');
  if (!isProfession(profession))
    throw new Error(`Pick a profession with -p: blacksmithing or mining`);
  const scope: Scope = { profession };
  if (values.skill !== undefined) scope.maxSkill = Number(values.skill);
  if (values['min-skill'] !== undefined) scope.minSkill = Number(values['min-skill']);
  if (values['trainer-only']) scope.trainerOnly = true;
  if (values.hours !== undefined) {
    const hours = Number(values.hours);
    if (!isListingHours(hours))
      throw new Error(`Listing hours are 2, 8 or 24, got '${values.hours}'`);
    scope.listingHours = hours;
  }
  const craftWith = ((values['craft-with'] as string[] | undefined) ?? []).map(parseHelper);
  if (craftWith.length > 0) scope.craftWith = craftWith;
  return scope;
}

/** `mining` or `mining:120`. */
function parseHelper(spec: string): Helper {
  const [profession = '', skill, ...extra] = spec.split(':');
  if (!isProfession(profession)) throw new Error(`Unknown profession: ${profession}`);
  if (skill === undefined) return { profession };
  const maxSkill = Number(skill);
  if (extra.length > 0 || !Number.isSafeInteger(maxSkill) || maxSkill < 1)
    throw new Error(`Use profession or profession:skill, got '${spec}'`);
  return { profession, maxSkill };
}

function parseHolding(advisor: Advisor, spec: string): Holding {
  const separator = spec.lastIndexOf(':');
  if (separator === -1) throw new Error(`Use item:quantity, got '${spec}'`);
  const quantity = Number(spec.slice(separator + 1));
  if (!Number.isSafeInteger(quantity) || quantity <= 0)
    throw new Error(`Bad quantity in '${spec}'`);
  return { itemId: advisor.resolveItem(spec.slice(0, separator)), quantity };
}

/** An OSC 8 hyperlink; terminals without support show the plain text. */
function link(out: Out, text: string, url: string): string {
  return out.links ? `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\` : text;
}

function itemLink(out: Out, pricer: Pricer, itemId: number): string {
  return link(out, pricer.name(itemId, out.lang), wowheadUrl('item', itemId, out.lang));
}

function printHeader({ t }: Out, advisor: Advisor, scope: Scope): void {
  const skill = [
    scope.maxSkill === undefined ? t.anySkill : t.skillAtMost(scope.maxSkill),
    ...(scope.trainerOnly ? [t.trainerOnly] : []),
  ].join(', ');
  const { market } = advisor;
  const { latestScan, scanAgeDays, stale } = marketFreshness(market);
  let age = '';
  if (latestScan !== undefined && scanAgeDays !== undefined) {
    age = t.scanAge(latestScan, scanAgeDays);
  } else if (market.observedAt) {
    age = t.pricesFrom(new Date(market.observedAt).toLocaleString(t.locale));
  } else if (market.source === 'auctionator') {
    age = t.noFullScan;
  }
  const label =
    market.source === 'auctionator'
      ? t.auctionatorMarket(market.id.slice('auctionator:'.length))
      : market.label;
  const helpers = helpersOf(scope).map(({ profession, maxSkill }) =>
    t.helper(
      t.professions[profession],
      maxSkill === undefined ? t.anySkill : t.skillAtMost(maxSkill),
    ),
  );
  console.log(t.header(t.professions[scope.profession], skill, label, age));
  if (helpers.length > 0) console.log(t.craftingWith(helpers.join(', ')));
  if (stale && scanAgeDays !== undefined) console.log(t.stale(scanAgeDays));
}

type Column<E extends Evaluation = Evaluation> = {
  title: string;
  width: number;
  cell: (e: E) => string;
};

function percent(ratio: number | undefined): string {
  if (ratio === undefined) return '-';
  return ratio >= 10 ? '>999%' : `${Math.round(ratio * 100)}%`;
}

/** Materials rows: profit is above selling the holdings, so it shows per craft and in total. */
function heldColumnsFor(t: Messages, category: Category): Column<HeldUse>[] {
  const { columns: c, money } = t;
  const cost: Column<HeldUse> = { title: c.cost, width: 10, cell: (e) => money(e.cost) };
  const vendor: Column<HeldUse> = {
    title: c.vendor,
    width: 10,
    cell: (e) => (e.sale.vendor > 0 ? money(e.sale.vendor) : '-'),
  };
  const gains: Column<HeldUse>[] = [
    { title: c.gain, width: 10, cell: (e) => money(e.ifSold) },
    { title: c.crafts, width: 7, cell: (e) => String(e.crafts) },
    { title: c.totalGain, width: 11, cell: (e) => money(e.gain) },
  ];
  if (category === 'vendor') return [cost, vendor, ...gains];
  return [
    cost,
    { title: c.listAt, width: 11, cell: (e) => money(e.sale.auctionGross, true) },
    vendor,
    ...gains,
    { title: c.ifUnsold, width: 11, cell: (e) => money(e.ifUnsold) },
  ];
}

function columnsFor(t: Messages, pricer: Pricer, category: Category): Column[] {
  const { columns: c, money } = t;
  const units: Column = {
    title: c.units,
    width: 6,
    cell: (e) => String(pricer.ctx.market.prices.get(e.recipe.output.itemId)?.quantity ?? 0),
  };
  const cost: Column = { title: c.cost, width: 10, cell: (e) => money(e.cost) };
  const breakEven: Column = {
    title: c.breakEven,
    width: 11,
    cell: (e) => money(Math.ceil(e.breakEven), true),
  };
  const vendor: Column = {
    title: c.vendor,
    width: 10,
    cell: (e) => (e.sale.vendor > 0 ? money(e.sale.vendor) : '-'),
  };
  const margin: Column = { title: c.margin, width: 7, cell: (e) => percent(e.marginRatio) };
  if (category === 'no-market') return [cost, breakEven, units];
  if (category === 'vendor') {
    return [cost, vendor, { title: c.profit, width: 10, cell: (e) => money(e.ifSold) }, margin];
  }
  return [
    cost,
    breakEven,
    { title: c.listAt, width: 11, cell: (e) => money(e.sale.auctionGross, true) },
    vendor,
    { title: c.ifSold, width: 10, cell: (e) => money(e.ifSold) },
    margin,
    { title: c.ifUnsold, width: 11, cell: (e) => money(e.ifUnsold) },
    units,
  ];
}

function printGroup<E extends Evaluation>(
  out: Out,
  pricer: Pricer,
  category: Category,
  list: E[],
  options: {
    limit: number;
    details: boolean;
    columns: Column<E>[];
    /** A line under each row before the warnings, e.g. what the row uses up. */
    note?: (e: E) => string;
  },
) {
  if (list.length === 0) return;
  const { t } = out;
  const { limit, details, columns, note } = options;
  // Translated titles can outgrow the default widths.
  const widths = columns.map((c) => Math.max(c.width, c.title.length + 1));
  const name = (id: number) => pricer.name(id, out.lang);
  const titles = list.slice(0, limit).map((e) => {
    const count = e.recipe.output.count > 1 ? ` x${e.recipe.output.count}` : '';
    return pricer.recipeName(e.recipe, out.lang) + count;
  });
  // Translated names run longer; the column grows to fit them, within reason.
  const nameWidth = Math.min(MAX_NAME_WIDTH, Math.max(32, ...titles.map((t) => t.length + 1)));
  console.log(`== ${t.categories[category]} (${list.length})`);
  const header = columns.map((c, i) => c.title.padStart(widths[i] ?? c.width)).join('');
  console.log(`${t.columns.recipe.padEnd(nameWidth)}${header}  ${t.columns.learn}`);
  for (const [i, e] of list.slice(0, limit).entries()) {
    const plan = e.recipe.planItemId === undefined ? '' : ` ${t.plan}`;
    const learn = `${e.recipe.learnSkillExact ? '' : '~'}${e.recipe.learnSkill}${plan}`;
    const cells = columns.map((c, i) => c.cell(e).padStart(widths[i] ?? c.width)).join('');
    const title = (titles[i] ?? '').slice(0, nameWidth - 1);
    const recipe = link(out, title, wowheadUrl('spell', e.recipe.spellId, out.lang));
    console.log(`${recipe}${' '.repeat(nameWidth - title.length)}${cells}  ${learn}`);
    if (note) console.log(`    ${note(e)}`);
    if (e.warnings.length > 0)
      console.log(`    ! ${t.risk}: ${e.warnings.map(t.warning).join('; ')}`);
    if (category !== 'steady' && e.reasons.length > 0)
      console.log(
        `    ! ${e.reasons
          .slice(0, 2)
          .map((r) => reasonText(t, name, r))
          .join('; ')}`,
      );
    if (details) console.log(`    ${partsText(out, pricer, e.parts, 1)}`);
  }
  if (list.length > limit) console.log(`    ${t.more(list.length - limit)}`);
  console.log('');
}

/** How a quote gets its units, e.g. "auction, from 2s00c, 1173 listed". */
function quoteText(out: Out, pricer: Pricer, quote: CostQuote): string {
  const { t } = out;
  if (quote.source === 'craft' && quote.recipe)
    return t.crafted(pricer.recipeName(quote.recipe, out.lang));
  if (quote.source === 'held' && quote.rest)
    return t.heldPart(Math.round(quote.held ?? 0), quoteText(out, pricer, quote.rest));
  if (quote.source === 'auction' && quote.rest) {
    const { rest, ...listings } = quote;
    const bought = quote.bought ?? 0;
    const auction = quoteText(out, pricer, { ...listings, units: bought });
    return t.boughtPart(bought, auction, quoteText(out, pricer, rest));
  }
  if (
    quote.source === 'auction' &&
    quote.cheapest !== undefined &&
    quote.listed !== undefined &&
    Math.round(quote.unit ?? 0) > Math.round(quote.cheapest)
  )
    return t.auctionFrom(t.money(Math.round(quote.cheapest)), quote.listed);
  return t.sources[quote.source];
}

/** Reagents of `crafts` crafts, e.g. "50x Tin Bar @2s02c (auction, from 2s00c, 1173 listed)". */
function partsText(
  out: Out,
  pricer: Pricer,
  parts: CostQuote['parts'] = [],
  crafts: number,
): string {
  return parts
    .map(
      (p) =>
        `${formatCount(p.count * crafts)}x ${itemLink(out, pricer, p.itemId)} @${out.t.money(p.quote.unit)} (${quoteText(out, pricer, p.quote)})`,
    )
    .join(', ');
}

function printRoutes(out: Out, pricer: Pricer, wanted: Holding, routes: CostQuote[]): void {
  const { t } = out;
  console.log(`== ${t.obtainTitle(itemLink(out, pricer, wanted.itemId), wanted.quantity)}`);
  const priced = routes.filter((r) => r.unit !== undefined);
  if (priced.length === 0) {
    console.log(t.noRoute);
    return;
  }
  const labels = priced.map((r) => quoteText(out, pricer, r));
  const width = Math.max(32, ...labels.map((l) => l.length + 1));
  const { columns: c } = t;
  console.log(`${c.route.padEnd(width)}${c.unitCost.padStart(11)}${c.total.padStart(12)}`);
  for (const [i, route] of priced.entries()) {
    const label = (labels[i] ?? '').padEnd(width);
    const unit = t.money(route.unit).padStart(11);
    const total = t.money((route.unit ?? 0) * wanted.quantity).padStart(12);
    console.log(`${label}${unit}${total}${i === 0 ? `  ${t.cheapestRoute}` : ''}`);
    const parts = route.rest ?? route;
    if (parts?.source === 'craft' && parts.recipe) {
      const crafts = parts.crafts ?? parts.units / parts.recipe.output.count;
      console.log(`    ${partsText(out, pricer, parts.parts, crafts)}`);
      if (parts.surplus) console.log(`    ${t.spare(formatCount(parts.surplus))}`);
      const used = heldPerCraft(parts.parts ?? [], crafts);
      if (used.size > 0) console.log(`    ${t.uses(heldList(out, pricer, used))}`);
    }
    for (const { itemId, need, listed } of shortfalls(wanted.itemId, route)) {
      const issue = t.issue({ kind: 'short-supply', need, listed });
      console.log(`    ! ${pricer.name(itemId, out.lang)}: ${issue}`);
    }
  }
  console.log(`\n${t.obtainNotes.join('\n')}`);
}

function printRecipeNotes(t: Messages, advisor: Advisor, pricer: Pricer): void {
  const hours = pricer.listingHours;
  const rate = Math.round(DEPOSIT_RATES[hours] * 100);
  console.log(t.recipeNotes(hours, rate, advisor.market.source === 'auctionator').join('\n'));
}

function printHoldings(out: Out, pricer: Pricer, holdings: HoldingSale[]): void {
  const { t } = out;
  console.log(`== ${t.sellAsIs}`);
  for (const h of holdings) {
    const { sale } = h;
    const status = sale.classification.status;
    const line: HoldingLine = {
      name: itemLink(out, pricer, h.itemId),
      quantity: h.quantity,
      via: t.routes[sale.via],
      net: t.money(sale.unit),
      total: t.money(h.sellTotal),
    };
    if (sale.auctionGross !== undefined) line.listAt = t.money(sale.auctionGross, true);
    if (sale.via === 'auction' && sale.vendor > 0) line.vendor = t.money(sale.vendor);
    if (sale.via === 'auction' && status !== 'stable') {
      line.flag = `  [${t.statuses[status]}: ${sale.classification.reasons.map(t.issue).join('; ')}]`;
    }
    console.log(t.holding(line));
    if (sale.via === 'auction' && h.quantity > h.marketQuantity) {
      console.log(`    ! ${t.moreThanMarket}`);
    }
  }
  const total = holdings.reduce((sum, h) => sum + (h.sellTotal ?? 0), 0);
  console.log(`${t.allOfIt(total)}\n`);
}

function heldList(out: Out, pricer: Pricer, used: Map<number, number>, times = 1): string {
  return [...used]
    .map(([id, n]) => `${formatCount(n * times)}x ${itemLink(out, pricer, id)}`)
    .join(', ');
}

function formatCount(units: number): string {
  return Number.isInteger(units) ? String(units) : units.toFixed(1);
}

function printMaterialNotes(t: Messages, pricer: Pricer): void {
  const hours = pricer.listingHours;
  console.log(t.materialNotes(hours, Math.round(DEPOSIT_RATES[hours] * 100)).join('\n'));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
