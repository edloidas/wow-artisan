import { type Coins, formatMoney } from '../money.ts';
import type { Messages } from './messages.ts';

const COINS: Coins = ['з', 'с', 'м'];
const money = (copper: number | undefined, exact = false) => formatMoney(copper, exact, COINS);

/** Picks the form for 1, for 2-4 and for 5+ (21 takes the first, 11-14 the last). */
function plural(n: number, one: string, few: string, many: string): string {
  const tens = Math.abs(n) % 100;
  const ones = tens % 10;
  if (tens >= 11 && tens <= 14) return many;
  if (ones === 1) return one;
  if (ones >= 2 && ones <= 4) return few;
  return many;
}

const days = (n: number) => `${n} ${plural(n, 'день', 'дня', 'дней')}`;

export const ru: Messages = {
  locale: 'ru',
  money,
  usage: `wow-artisan: советник по ремеслу для World of Warcraft Forever

Использование:
  wow-artisan recipes   -p <профессия> [-s <навык>] [--min-profit 50с] [опции]
  wow-artisan materials -p <профессия> (--have "Copper Bar:200" ... | --inventory) [--min-profit 10с] [опции]
  wow-artisan obtain    -p <профессия> "Bronze Bar:100" [--have "Copper Ore:40" ... | --inventory] [опции]
  wow-artisan markets
  wow-artisan sync      [--build <версия>]

Профессии: blacksmithing (кузнечное дело), mining (горное дело)

Опции:
  -p, --profession <имя>    профессия для подсчёта
  -s, --skill <n>           ваш навык: скрыть рецепты, для изучения которых нужно больше
      --min-skill <n>       скрыть рецепты, изучаемые ниже этого навыка
      --trainer-only        скрыть рецепты из чертежей, оставить рецепты учителя
      --min-profit <сумма>  например 50с, 1з20с, 2з или 50s, 1g20s (по умолчанию 1с; для materials — выгода сверх продажи, по умолчанию 1м)
      --crafts <n>          recipes: покупать реагенты на столько крафтов (по умолчанию 1)
      --hours <2|8|24>      срок лота для расчёта залога (по умолчанию как в Auctionator, иначе 24)
      --craft-with <имя>    другая профессия, которая может делать промежуточные материалы (можно повторять)
  -m, --market <spec>       auctionator[:realm] (по умолчанию) или ahledger:<id рынка>
      --have <предмет:кол>  ваш материал, по названию (русскому или английскому) или id (можно повторять)
      --inventory           взять материалы из сохранённого инвентаря Syndicator
  -n, --limit <n>           строк в категории (по умолчанию 10)
      --details             показать материалы каждого рецепта
      --json                машиночитаемый вывод (тексты в нём на английском)
      --lang <en|ru>        язык вывода (по умолчанию WOW_ARTISAN_LANG, иначе en)
      --thin <n>            меньше единиц на рынке — мало (по умолчанию 5)
      --spread <доля>       макс. разрыв между самым дешёвым лотом и обычной ценой (по умолчанию 0.35)
      --swing <отношение>   макс. отношение максимальной цены к минимальной (по умолчанию 3)
      --trend <доля>        макс. отклонение медианы за 7 дней от медианы за 30 (по умолчанию 0.4)
`,
  professions: { blacksmithing: 'Кузнечное дело', mining: 'Горное дело' },
  categories: {
    steady: 'Стабильно: товара хватает, цены лотов держатся',
    vendor: 'Торговцу: продать торговцу, без риска аукциона и залога',
    volatile: 'Нестабильно: цены лотов скачут',
    thin: 'Мало: мало товара, нет в последнем скане или редко бывает в сканах',
    'no-market': 'Нет рынка: ничего не выставлено, торговец не покупает (только затраты)',
  },
  sources: {
    auction: 'аукцион',
    vendor: 'торговец',
    craft: 'крафт',
    held: 'своё',
    unknown: 'нет',
  },
  routes: { auction: 'аукцион', vendor: 'торговец', none: 'никуда' },
  statuses: { stable: 'стабильно', volatile: 'нестабильно', thin: 'мало', none: 'нет рынка' },
  columns: {
    recipe: 'рецепт',
    learn: 'изуч.',
    cost: 'затраты',
    breakEven: 'безуб./шт',
    listAt: 'лот/шт',
    vendor: 'торг./шт',
    ifSold: 'продано',
    margin: 'маржа',
    ifUnsold: 'не продано',
    units: 'на АХ',
    profit: 'прибыль',
    gain: 'выгода',
    crafts: 'крафты',
    totalGain: 'всего',
    route: 'способ',
    unitCost: 'цена/шт',
    total: 'всего',
  },
  plan: 'чертеж',
  anySkill: 'любой навык',
  skillAtMost: (skill) => `навык <= ${skill}`,
  trainerOnly: 'только рецепты учителя',
  scanAge: (date, n) =>
    `, последний скан ${date} (${['сегодня', 'вчера'][n] ?? `${days(n)} назад`})`,
  pricesFrom: (date) => `, цены на ${date}`,
  noFullScan: ', полного скана ещё нет',
  auctionatorMarket: (realm) => `${realm} (ваши сканы Auctionator)`,
  header: (profession, skill, market, age) => `${profession} (${skill}), ${market}${age}`,
  stale: (n) => `! ценам ${days(n)}; отсканируйте аукцион и сделайте /reload`,
  summary: (considered, unpriced, bound, minProfit) =>
    `Рецептов в диапазоне: ${considered}; пропущено: без цены реагентов — ${unpriced}, персональных при поднятии — ${bound}; мин. прибыль ${money(minProfit)}`,
  more: (count) => `... ещё ${count}`,
  risk: 'риск',
  crafted: (recipe) => `крафт: ${recipe}`,
  auctionFrom: (cheapest, listed) => `аукцион, от ${cheapest}, на АХ ${listed}`,
  heldPart: (held, rest) => `своих ${held} + ${rest}`,
  boughtPart: (units, auction, rest) => `${units} шт.: ${auction} + ${rest}`,
  spare: (units) => `лишних ${units} шт., по цене их продажи, но не дороже их себестоимости`,
  batch: (crafts) => `реагенты покупаются на ${crafts} крафтов`,
  obtainTitle: (item, quantity) => `${item} x${quantity}`,
  cheapestRoute: '<- дешевле всего',
  noRoute: 'Ничто в рамках запроса не даёт этот предмет: нет лотов, торговца или рецепта.',
  obtainNotes: [
    'цена/шт усреднена по всем единицам. Покупка дорожает от самого дешёвого лота, чем большую долю рынка она забирает; сверх выставленного единицы стоят по верхней цене.',
    'Сначала идут способы, которые рынок покрывает целиком, при любой цене: единицы сверх выставленного — догадка, и сегодня их может не быть в продаже.',
    'свои единицы стоят столько, сколько принесёт их продажа, поэтому способ, который их тратит, соревнуется с их продажей.',
  ],
  uses: (list) => `расходует ${list}`,
  noGainfulRecipe: (minProfit) =>
    `Ни один рецепт не приносит ${money(minProfit)} или больше сверх продажи материалов.`,
  sellAsIs: 'Продать как есть',
  holding: (h) =>
    `${h.name} x${h.quantity} (${h.via}): ${h.listAt ? `лот ${h.listAt}, ` : ''}чистыми ${h.net} за шт. -> ${h.total}${h.vendor ? `; торговец платит ${h.vendor}` : ''}${h.flag ?? ''}`,
  moreThanMarket: 'у вас больше, чем видно на рынке; если продать всё, цена упадёт',
  allOfIt: (total) => `всё вместе: ${money(total)}`,
  recipeNotes: (hours, rate, localUnits) => [
    'затраты, продано, не продано и прибыль — на один крафт; цены с /шт — за единицу.',
    'лот: цена, которую ставить на аукционе, до комиссии 5%. безуб.: самая низкая цена лота, которая окупает затраты после комиссии.',
    'продано: если каждая единица продастся по цене «лот», после комиссии. Продажи нигде не записываются, так что это не прогноз. маржа: «продано» как доля затрат.',
    'торг.: сколько платит торговец (- если в данных игры цены нет). не продано: лот один раз истекает, залог теряется, и все единицы уходят торговцу.',
    localUnits
      ? 'на АХ: больше всего единиц, замеченных в последний день, когда предмет сканировался.'
      : 'на АХ: выставлено сейчас.',
    'затраты: покупные реагенты дорожают от самого дешёвого лота, чем большую долю рынка забирает партия (--crafts).',
    'изуч.: навык для изучения рецепта; ~ — оценка, чертеж — рецепт учится из чертежа (--trainer-only скрывает такие).',
    `залог: ${rate}% цены торговца за единицу для лота на ${hours} ч (--hours); ставки Classic Era, на Forever ещё не подтверждены. При продаже возвращается, поэтому в «продано» не входит.`,
  ],
  materialNotes: (hours, rate) => [
    'Ваши материалы стоят столько, сколько принесёт их продажа, поэтому выгода — сколько один крафт приносит сверх продажи того, что расходует; всего — по всем крафтам.',
    'крафты: сколько целых крафтов покрывают ваши материалы, включая промежуточные из них; остальные реагенты покупаются. Варианты делят одни и те же материалы, поэтому суммы не складываются.',
    'лот: цена на аукционе до комиссии 5%. не продано: один истёкший лот теряет залог, и единицы уходят торговцу — в сравнении с продажей ваших материалов.',
    `залог: ${rate}% цены торговца за единицу для лота на ${hours} ч (--hours); ставки Classic Era, на Forever ещё не подтверждены.`,
  ],
  product: 'товар',
  issue: (issue) => {
    switch (issue.kind) {
      case 'nothing-listed':
        return 'ничего не выставлено';
      case 'missing-from-scan':
        return `нет в последнем скане (последний раз ${issue.lastSeen})`;
      case 'few-seen':
        return `не больше ${issue.quantity} шт. на ${issue.date}`;
      case 'few-listed':
        return `выставлено всего ${issue.quantity} шт.`;
      case 'short-supply':
        return `нужно ${issue.need}, выставлено всего ${issue.listed} шт.`;
      case 'rarely-scanned':
        return `был в ${issue.seen} из ${issue.scans} последних полных сканов`;
      case 'undercut':
        return `самый дешёвый лот на ${issue.percent}% ниже обычной цены`;
      case 'swing':
        return `цена менялась в ${issue.ratio.toFixed(1).replace('.', ',')} раза за период`;
      case 'trend':
        return `медиана за 7 дней ${issue.percent > 0 ? '+' : ''}${issue.percent}% к медиане за 30`;
      case 'unsellable':
        return 'ничего не выставлено, торговец не покупает';
      case 'vendor-beats-auction':
        return `аукцион даёт чистыми ${money(issue.auctionNet)}/шт, меньше, чем торговец: ${money(issue.vendor)}/шт`;
    }
  },
  warning: (warning) =>
    warning.kind === 'deposit-exceeds-sale'
      ? `один истёкший лот (залог ~${money(warning.deposit)}) стоит больше, чем приносит продажа`
      : `торговец платит ${money(warning.vendor)}/шт; аукцион добавляет меньше одного залога ~${money(warning.deposit)}/шт`,
  ownScans: 'ваши собственные сканы (по умолчанию)',
  synced: (build, recipes, items) =>
    `Данные игры ${build}: рецептов — ${recipes}, предметов — ${items}`,
};
