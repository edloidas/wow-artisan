import { formatMoney } from '../money.ts';
import type { Messages } from './messages.ts';

const money = (copper: number | undefined, exact = false) => formatMoney(copper, exact);

export const en: Messages = {
  locale: 'en',
  money,
  usage: `wow-artisan: World of Warcraft Forever craft advisor

Usage:
  wow-artisan recipes   -p <profession> [-s <skill>] [--min-profit 50s] [options]
  wow-artisan materials -p <profession> (--have "Copper Bar:200" ... | --inventory) [--min-profit 10s] [options]
  wow-artisan markets
  wow-artisan sync      [--build <version>]

Professions: blacksmithing, mining

Options:
  -p, --profession <name>   profession to advise on
  -s, --skill <n>           your skill: hide recipes that need more to learn
      --min-skill <n>       hide recipes learnable below this skill
      --trainer-only        hide recipes taught by plans, keep trainer recipes
      --min-profit <money>  e.g. 50s, 1g20s, 2g (default 1s; materials: gain over selling, default 1c)
      --hours <2|8|24>      listing duration for deposits (default: Auctionator's, else 24)
      --craft-with <name>   another profession that may make intermediates (repeatable)
  -m, --market <spec>       auctionator[:realm] (default) or ahledger:<market id>
      --have <item:qty>     a material you own, by name or id (repeatable)
      --inventory           use materials from Syndicator's saved inventory
  -n, --limit <n>           rows per category (default 10)
      --details             list materials for each recipe
      --json                machine-readable output
      --lang <en|ru>        output language (default: WOW_ARTISAN_LANG, else en)
      --thin <n>            fewer listed units than this is thin (default 5)
      --spread <share>      max cheapest-vs-usual price gap (default 0.35)
      --swing <ratio>       max high/low price ratio (default 3)
      --trend <share>       max 7d vs 30d median drift (default 0.4)
`,
  professions: { blacksmithing: 'blacksmithing', mining: 'mining' },
  categories: {
    steady: 'Steady: enough units, stable asking prices',
    vendor: 'Vendor: sell to a merchant, no auction risk or deposit',
    volatile: 'Volatile: asking prices jump around',
    thin: 'Thin: few units, missing from the latest scan, or seen on few scans',
    'no-market': 'No market: nothing listed, no vendor floor (cost only)',
  },
  sources: {
    auction: 'auction',
    vendor: 'vendor',
    craft: 'craft',
    held: 'held',
    unknown: 'unknown',
  },
  routes: { auction: 'auction', vendor: 'vendor', none: 'none' },
  statuses: { stable: 'stable', volatile: 'volatile', thin: 'thin', none: 'none' },
  columns: {
    recipe: 'recipe',
    learn: 'learn',
    cost: 'cost',
    breakEven: 'b-even/u',
    listAt: 'list at/u',
    vendor: 'vendor/u',
    ifSold: 'if sold',
    margin: 'margin',
    ifUnsold: 'if unsold',
    units: 'units',
    profit: 'profit',
    gain: 'gain',
    crafts: 'crafts',
    totalGain: 'total gain',
  },
  plan: 'plan',
  anySkill: 'any skill',
  skillAtMost: (skill) => `skill <= ${skill}`,
  trainerOnly: 'trainer recipes only',
  scanAge: (date, days) =>
    `, latest scan ${date} (${['today', 'yesterday'][days] ?? `${days} days ago`})`,
  pricesFrom: (date) => `, prices from ${date}`,
  noFullScan: ', no full scan yet',
  auctionatorMarket: (realm) => `${realm} (your Auctionator scans)`,
  header: (profession, skill, market, age) => `${profession} (${skill}) on ${market}${age}`,
  stale: (days) => `! prices are ${days} days old; scan the auction house and /reload`,
  summary: (considered, unpriced, bound, minProfit) =>
    `${considered} recipes in range; skipped: ${unpriced} unpriced reagents, ${bound} bind on pickup; min profit ${money(minProfit)}`,
  more: (count) => `... ${count} more`,
  risk: 'risk',
  crafted: (recipe) => `craft: ${recipe}`,
  uses: (list) => `uses ${list}`,
  noGainfulRecipe: (minProfit) =>
    `No recipe in scope earns ${money(minProfit)} or more above selling them.`,
  sellAsIs: 'Sell as is',
  holding: (h) =>
    `${h.name} x${h.quantity} (${h.via}): ${h.listAt ? `list at ${h.listAt}, ` : ''}nets ${h.net} each -> ${h.total}${h.vendor ? `; vendor pays ${h.vendor}` : ''}${h.flag ?? ''}`,
  moreThanMarket: 'you hold more than the market shows; selling it all will push the price down',
  allOfIt: (total) => `all of it: ${money(total)}`,
  recipeNotes: (hours, rate, localUnits) => [
    'cost, if sold, if unsold and profit are per craft; prices marked /u are per unit.',
    'list at: the auction asking price to type in, before the 5% cut. b-even: the lowest asking price that covers the cost after the cut.',
    'if sold: if every unit sells at "list at", after the cut. Nothing records sales, so this is not a forecast. margin: "if sold" as a share of cost.',
    'vendor: what a merchant pays (- when the game data has none). if unsold: the listing expires once, its deposit is lost, and every unit goes to a merchant.',
    localUnits
      ? 'units: the most seen on the last day the item was scanned.'
      : 'units: listed now.',
    'learn: the skill to learn the recipe; ~ is estimated, plan means a plan item teaches it (--trainer-only hides those).',
    `deposit: ${rate}% of the vendor price per unit for a ${hours}h listing (--hours); Classic Era rates, not yet confirmed on Forever. Refunded on sale, so "if sold" excludes it.`,
  ],
  materialNotes: (hours, rate) => [
    'Your materials cost what selling them nets, so gain is what one craft earns above selling what it uses; total gain is over all crafts.',
    'crafts: whole crafts your materials cover, through intermediates made from them; other reagents are bought. Uses compete for the same materials, so totals do not add up.',
    'list at: the auction asking price, before the 5% cut. if unsold: one expired listing loses its deposit and the units go to a merchant, against selling your materials.',
    `deposit: ${rate}% of the vendor price per unit for a ${hours}h listing (--hours); Classic Era rates, not yet confirmed on Forever.`,
  ],
  product: 'product',
  issue: (issue) => {
    switch (issue.kind) {
      case 'nothing-listed':
        return 'nothing listed';
      case 'missing-from-scan':
        return `missing from the latest scan (last seen ${issue.lastSeen})`;
      case 'few-seen':
        return `at most ${issue.quantity} seen on ${issue.date}`;
      case 'few-listed':
        return `only ${issue.quantity} listed`;
      case 'rarely-scanned':
        return `seen on ${issue.seen} of the last ${issue.scans} full scans`;
      case 'undercut':
        return `cheapest is ${issue.percent}% under the usual price`;
      case 'swing':
        return `price swung ${issue.ratio.toFixed(1)}x over the period`;
      case 'trend':
        return `7-day median ${issue.percent > 0 ? '+' : ''}${issue.percent}% vs 30-day`;
      case 'unsellable':
        return 'nothing listed, no vendor price';
      case 'vendor-beats-auction':
        return `auction nets ${money(issue.auctionNet)}/u, under the vendor's ${money(issue.vendor)}/u`;
    }
  },
  warning: (warning) =>
    warning.kind === 'deposit-exceeds-sale'
      ? `one expired listing (~${money(warning.deposit)} deposit) costs more than a sale earns`
      : `vendor pays ${money(warning.vendor)}/u; the auction adds less than one ~${money(warning.deposit)}/u deposit`,
  ownScans: 'your own scans (default)',
  synced: (build, recipes, items) => `Game data ${build}: ${recipes} recipes, ${items} items`,
};
