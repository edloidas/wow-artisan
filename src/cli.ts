#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { Advisor, isProfession, type Scope } from './advisor.ts';
import type { Thresholds } from './engine/classify.ts';
import type { Holding, MaterialReport } from './engine/materials.ts';
import type { Pricer } from './engine/pricer.ts';
import type { Category, Evaluation } from './engine/recommend.ts';
import { loadGameData } from './gamedata/load.ts';
import type { Profession } from './gamedata/types.ts';
import { formatMoney, parseMoney } from './money.ts';
import { listAhledgerMarkets } from './prices/ahledger.ts';
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
  reliable: 'Reliable',
  risky: 'Risky: prices jump around',
  thin: 'Thin: very few listed',
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
  const age = advisor.market.observedAt
    ? `, data from ${advisor.market.observedAt.slice(0, 16).replace('T', ' ')}`
    : '';
  console.log(`${scope.profession} (${skill}) on ${advisor.market.label}${age}`);
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
  const showProfit = category !== 'no-market';
  const moneyHeader = showProfit ? `${'sells'.padStart(10)}${'profit'.padStart(10)}  via    ` : '';
  console.log(
    `${'recipe'.padEnd(34)}${'cost'.padStart(10)}${moneyHeader}${'listed'.padStart(7)}  learn`,
  );
  for (const e of list.slice(0, limit)) {
    const listed = pricer.ctx.market.prices.get(e.recipe.output.itemId)?.quantity ?? 0;
    const count = e.recipe.output.count > 1 ? ` x${e.recipe.output.count}` : '';
    const learn = `${e.recipe.learnSkillExact ? '' : '~'}${e.recipe.learnSkill}`;
    const money = showProfit
      ? `${formatMoney(e.sale.unit).padStart(10)}${formatMoney(e.profit).padStart(10)}  ${e.sale.via.padEnd(7)}`
      : '';
    console.log(
      `${(e.recipe.name + count).slice(0, 33).padEnd(34)}${formatMoney(e.cost).padStart(10)}${money}${String(listed).padStart(7)}  ${learn}`,
    );
    if (category !== 'reliable' && e.reasons.length > 0)
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

function printMaterial(report: MaterialReport): void {
  console.log(`\n== ${report.name} x${report.quantity} (market lists ${report.marketQuantity})`);
  const status = report.sale.classification.status;
  const flag =
    status === 'stable' ? '' : `  [${status}: ${report.sale.classification.reasons.join('; ')}]`;
  console.log(
    `  sell as is: ${formatMoney(report.sale.unit)} each -> ${formatMoney(report.sellTotal)} (${report.sale.via})${flag}`,
  );
  if (report.quantity > report.marketQuantity && report.sale.via === 'auction') {
    console.log(`  ! you hold more than the market lists; selling it all will push the price down`);
  }
  if (report.uses.length === 0) {
    console.log('  no priced recipe in scope uses it');
    return;
  }
  for (const use of report.uses) {
    const better = report.sale.unit === undefined || use.perUnit > report.sale.unit;
    console.log(
      `  ${better ? '+' : ' '} ${formatMoney(use.perUnit).padStart(9)}/unit  ${use.recipe.name} (${use.need} per craft, ${use.crafts} crafts${use.capped ? ', capped by market' : ''} -> ${formatMoney(use.total)})  [${use.status}]`,
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
