#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { Advisor, isProfession, type Scope } from './advisor.ts';
import type { Thresholds } from './engine/classify.ts';
import type { Holding, MaterialReport } from './engine/materials.ts';
import { DEPOSIT_RATES, isListingHours, type Pricer } from './engine/pricer.ts';
import type { Category, Evaluation } from './engine/recommend.ts';
import { loadGameData } from './gamedata/load.ts';
import type { Profession } from './gamedata/types.ts';
import { formatMoney, parseMoney } from './money.ts';
import { listAhledgerMarkets } from './prices/ahledger.ts';
import { marketFreshness } from './prices/freshness.ts';
import { materialReportJson, recommendationsJson } from './serialize.ts';
import { FALLBACK_BUILD, findInstallation } from './wow.ts';

const USAGE = `wow-artisan: World of Warcraft Forever craft advisor

Usage:
  wow-artisan recipes   -p <profession> [-s <skill>] [--min-profit 50s] [options]
  wow-artisan materials -p <profession> (--have "Copper Bar:200" ... | --inventory) [options]
  wow-artisan markets
  wow-artisan sync      [--build <version>]

Professions: blacksmithing, mining

Options:
  -p, --profession <name>   profession to advise on
  -s, --skill <n>           your skill: hide recipes that need more to learn
      --min-skill <n>       hide recipes learnable below this skill
      --min-profit <money>  e.g. 50s, 1g20s, 2g (default 1s)
      --hours <2|8|24>      listing duration for deposits (default: Auctionator's, else 24)
      --craft-with <name>   another profession that may make intermediates (repeatable)
  -m, --market <spec>       auctionator[:realm] (default) or ahledger:<market id>
      --have <item:qty>     a material you own, by name or id (repeatable)
      --inventory           use materials from Syndicator's saved inventory
  -n, --limit <n>           rows per category (default 10)
      --details             list materials for each recipe
      --json                machine-readable output
      --thin <n>            fewer listed units than this is thin (default 5)
      --spread <share>      max cheapest-vs-usual price gap (default 0.35)
      --swing <ratio>       max high/low price ratio (default 3)
      --trend <share>       max 7d vs 30d median drift (default 0.4)
`;

const CATEGORY_TITLES: Record<Category, string> = {
  steady: 'Steady: enough units, stable asking prices',
  vendor: 'Vendor: sell to a merchant, no auction risk or deposit',
  volatile: 'Volatile: asking prices jump around',
  thin: 'Thin: few units, missing from the latest scan, or seen on few scans',
  'no-market': 'No market: nothing listed, no vendor floor (cost only)',
};

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      profession: { type: 'string', short: 'p' },
      skill: { type: 'string', short: 's' },
      'min-skill': { type: 'string' },
      'min-profit': { type: 'string' },
      hours: { type: 'string' },
      'craft-with': { type: 'string', multiple: true },
      market: { type: 'string', short: 'm' },
      have: { type: 'string', multiple: true },
      inventory: { type: 'boolean' },
      limit: { type: 'string', short: 'n' },
      details: { type: 'boolean' },
      json: { type: 'boolean' },
      build: { type: 'string' },
      thin: { type: 'string' },
      spread: { type: 'string' },
      swing: { type: 'string' },
      trend: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command] = positionals;
  if (!command || values.help) {
    console.log(USAGE);
    return;
  }

  if (command === 'markets') {
    const markets = await listAhledgerMarkets();
    console.log('auctionator            your own scans (default)');
    for (const market of markets) console.log(`ahledger:${market.id.padEnd(26)} ${market.label}`);
    return;
  }

  if (command === 'sync') {
    const build = values.build ?? findInstallation()?.build ?? FALLBACK_BUILD;
    const data = await loadGameData(build, true);
    console.log(
      `Game data ${data.build}: ${data.recipes.length} recipes, ${Object.keys(data.items).length} items`,
    );
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
    const { pricer, result } = advisor.recommend(scope, minProfit);
    if (values.json) {
      console.log(JSON.stringify(recommendationsJson(pricer, result, limit), null, 2));
      return;
    }
    printHeader(advisor, scope);
    console.log(
      `${result.considered} recipes in range; skipped: ${result.unpriced} unpriced reagents, ${result.bound} bind on pickup; min profit ${formatMoney(minProfit)}\n`,
    );
    for (const [category, list] of Object.entries(result.groups) as [Category, Evaluation[]][]) {
      printGroup(pricer, category, list, limit, values.details ?? false);
    }
    printRecipeNotes(advisor, pricer);
    return;
  }

  if (command === 'materials') {
    const holdings: Holding[] = values.inventory
      ? advisor.ownedMaterials(scope)
      : (values.have ?? []).map((spec) => parseHolding(advisor, spec));
    if (holdings.length === 0) throw new Error('Nothing to evaluate: pass --have or --inventory');
    const reports = advisor.materials(scope, holdings, limit);
    if (values.json) {
      console.log(JSON.stringify(reports.map(materialReportJson), null, 2));
      return;
    }
    printHeader(advisor, scope);
    for (const report of reports) printMaterial(report);
    return;
  }

  throw new Error(`Unknown command '${command}'\n\n${USAGE}`);
}

function parseScope(values: Record<string, unknown>): Scope {
  const profession = String(values.profession ?? '');
  if (!isProfession(profession))
    throw new Error(`Pick a profession with -p: blacksmithing or mining`);
  const scope: Scope = { profession };
  if (values.skill !== undefined) scope.maxSkill = Number(values.skill);
  if (values['min-skill'] !== undefined) scope.minSkill = Number(values['min-skill']);
  if (values.hours !== undefined) {
    const hours = Number(values.hours);
    if (!isListingHours(hours))
      throw new Error(`Listing hours are 2, 8 or 24, got '${values.hours}'`);
    scope.listingHours = hours;
  }
  const craftWith = (values['craft-with'] as string[] | undefined) ?? [];
  const invalid = craftWith.filter((p) => !isProfession(p));
  if (invalid.length > 0) throw new Error(`Unknown profession: ${invalid.join(', ')}`);
  if (craftWith.length > 0) scope.craftWith = craftWith as Profession[];
  return scope;
}

function parseHolding(advisor: Advisor, spec: string): Holding {
  const separator = spec.lastIndexOf(':');
  if (separator === -1) throw new Error(`Use item:quantity, got '${spec}'`);
  const quantity = Number(spec.slice(separator + 1));
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error(`Bad quantity in '${spec}'`);
  return { itemId: advisor.resolveItem(spec.slice(0, separator)), quantity };
}

function printHeader(advisor: Advisor, scope: Scope): void {
  const skill = scope.maxSkill === undefined ? 'any skill' : `skill <= ${scope.maxSkill}`;
  const { market } = advisor;
  const { latestScan, scanAgeDays, stale } = marketFreshness(market);
  let age = '';
  if (latestScan !== undefined && scanAgeDays !== undefined) {
    const ago = ['today', 'yesterday'][scanAgeDays] ?? `${scanAgeDays} days ago`;
    age = `, latest scan ${latestScan} (${ago})`;
  } else if (market.observedAt) {
    age = `, prices from ${new Date(market.observedAt).toLocaleString()}`;
  } else if (market.source === 'auctionator') {
    age = ', no full scan yet';
  }
  console.log(`${scope.profession} (${skill}) on ${market.label}${age}`);
  if (stale)
    console.log(`! prices are ${scanAgeDays} days old; scan the auction house and /reload`);
}

type Column = { title: string; width: number; cell: (e: Evaluation) => string };

function percent(ratio: number | undefined): string {
  if (ratio === undefined) return '-';
  return ratio >= 10 ? '>999%' : `${Math.round(ratio * 100)}%`;
}

function columnsFor(pricer: Pricer, category: Category): Column[] {
  const units: Column = {
    title: 'units',
    width: 6,
    cell: (e) => String(pricer.ctx.market.prices.get(e.recipe.output.itemId)?.quantity ?? 0),
  };
  const cost: Column = { title: 'cost', width: 10, cell: (e) => formatMoney(e.cost) };
  const breakEven: Column = {
    title: 'b-even/u',
    width: 11,
    cell: (e) => formatMoney(Math.ceil(e.breakEven), true),
  };
  const vendor: Column = {
    title: 'vendor/u',
    width: 10,
    cell: (e) => (e.sale.vendor > 0 ? formatMoney(e.sale.vendor) : '-'),
  };
  const margin: Column = { title: 'margin', width: 7, cell: (e) => percent(e.marginRatio) };
  if (category === 'no-market') return [cost, breakEven, units];
  if (category === 'vendor') {
    return [
      cost,
      vendor,
      { title: 'profit', width: 10, cell: (e) => formatMoney(e.ifSold) },
      margin,
    ];
  }
  return [
    cost,
    breakEven,
    { title: 'list at/u', width: 11, cell: (e) => formatMoney(e.sale.auctionGross, true) },
    vendor,
    { title: 'if sold', width: 10, cell: (e) => formatMoney(e.ifSold) },
    margin,
    { title: 'if unsold', width: 11, cell: (e) => formatMoney(e.ifUnsold) },
    units,
  ];
}

function printGroup(
  pricer: Pricer,
  category: Category,
  list: Evaluation[],
  limit: number,
  details: boolean,
) {
  if (list.length === 0) return;
  console.log(`== ${CATEGORY_TITLES[category]} (${list.length})`);
  const columns = columnsFor(pricer, category);
  const header = columns.map((c) => c.title.padStart(c.width)).join('');
  console.log(`${'recipe'.padEnd(32)}${header}  learn`);
  for (const e of list.slice(0, limit)) {
    const count = e.recipe.output.count > 1 ? ` x${e.recipe.output.count}` : '';
    const learn = `${e.recipe.learnSkillExact ? '' : '~'}${e.recipe.learnSkill}`;
    const cells = columns.map((c) => c.cell(e).padStart(c.width)).join('');
    console.log(`${(e.recipe.name + count).slice(0, 31).padEnd(32)}${cells}  ${learn}`);
    if (e.warnings.length > 0) console.log(`    ! risk: ${e.warnings.join('; ')}`);
    if (category !== 'steady' && e.reasons.length > 0)
      console.log(`    ! ${e.reasons.slice(0, 2).join('; ')}`);
    if (details) {
      const mats = e.parts.map((p) => {
        const how = p.quote.source === 'craft' ? `craft: ${p.quote.recipe?.name}` : p.quote.source;
        return `${p.count}x ${pricer.name(p.itemId)} @${formatMoney(p.quote.unit)} (${how})`;
      });
      console.log(`    ${mats.join(', ')}`);
    }
  }
  if (list.length > limit) console.log(`    ... ${list.length - limit} more`);
  console.log('');
}

function printRecipeNotes(advisor: Advisor, pricer: Pricer): void {
  const hours = pricer.listingHours;
  const units =
    advisor.market.source === 'auctionator'
      ? 'units: the most seen on the last day the item was scanned.'
      : 'units: listed now.';
  console.log(
    [
      'cost, if sold, if unsold and profit are per craft; prices marked /u are per unit.',
      'list at: the auction asking price to type in, before the 5% cut. b-even: the lowest asking price that covers the cost after the cut.',
      'if sold: if every unit sells at "list at", after the cut. Nothing records sales, so this is not a forecast. margin: "if sold" as a share of cost.',
      'vendor: what a merchant pays (- when the game data has none). if unsold: the listing expires once, its deposit is lost, and every unit goes to a merchant.',
      `${units}`,
      `deposit: ${Math.round(DEPOSIT_RATES[hours] * 100)}% of the vendor price per unit for a ${hours}h listing (--hours); Classic Era rates, not yet confirmed on Forever. Refunded on sale, so "if sold" excludes it.`,
    ].join('\n'),
  );
}

function printMaterial(report: MaterialReport): void {
  const supply = report.lastSeen
    ? `at most ${report.marketQuantity} seen on ${report.lastSeen}`
    : `${report.marketQuantity} listed`;
  console.log(`\n== ${report.name} x${report.quantity} (market: ${supply})`);
  const status = report.sale.classification.status;
  const flag =
    status === 'stable' ? '' : `  [${status}: ${report.sale.classification.reasons.join('; ')}]`;
  const { sale } = report;
  const list =
    sale.auctionGross === undefined ? '' : `list at ${formatMoney(sale.auctionGross, true)}, `;
  const vendor = sale.vendor > 0 ? `; vendor pays ${formatMoney(sale.vendor)}` : '';
  console.log(
    `  sell as is (${sale.via}): ${list}nets ${formatMoney(sale.unit)} each -> ${formatMoney(report.sellTotal)}${vendor}${flag}`,
  );
  if (report.quantity > report.marketQuantity && report.sale.via === 'auction') {
    console.log(`  ! you hold more than the market shows; selling it all will push the price down`);
  }
  if (report.uses.length === 0) {
    console.log('  no priced recipe in scope uses it');
    return;
  }
  for (const use of report.uses) {
    const better = report.sale.unit === undefined || use.perUnit > report.sale.unit;
    console.log(
      `  ${better ? '+' : ' '} ${formatMoney(use.perUnit).padStart(9)}/unit  ${use.recipe.name} (${use.need} per craft, ${use.crafts} crafts${use.capped ? ', capped at market units' : ''} -> ${formatMoney(use.total)})  [${use.status}]`,
    );
    const rest =
      use.totalWithRest === undefined
        ? ''
        : `; with the rest sold: ${formatMoney(use.totalWithRest)}`;
    console.log(`      then: ${use.route}${rest}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
