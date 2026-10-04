/// <reference lib="dom" />
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps';
import { formatMoney } from '../money.ts';
import type { evaluationJson, materialsJson, recommendationsJson } from '../serialize.ts';

type Recommendations = ReturnType<typeof recommendationsJson>;
type Materials = ReturnType<typeof materialsJson>;
type Row = ReturnType<typeof evaluationJson>;
type MaterialRow = Materials['groups'][string]['top'][number];
type Group<T> = { total: number; top: T[] };

const CATEGORIES = ['steady', 'vendor', 'volatile', 'thin', 'no-market'] as const;
const CATEGORY_HINT: Record<string, string> = {
  steady: 'enough units, stable asking prices',
  vendor: 'sold to a merchant, no auction risk',
  volatile: 'asking prices move',
  thin: 'few units or rarely scanned',
  'no-market': 'nothing to sell it for',
};

const root = document.getElementById('app') as HTMLElement;
const app = new App({ name: 'wow-artisan', version: '0.1.0' });

type Child = Node | string | number | false | null | undefined;

function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  for (const child of children) {
    if (child === false || child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

/** Wowhead opens through the host: the sandboxed iframe can't navigate on its own. */
function link(text: string, url: string | undefined): Node {
  if (!url) return document.createTextNode(text);
  const a = h('a', { href: url, title: url }, text);
  a.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void app.openLink({ url });
  });
  return a;
}

function named(entity: { name: string; localName?: string | undefined; url?: string }): Node {
  return link(entity.localName ?? entity.name, entity.url);
}

function money(copper: number | undefined, signed = false): HTMLElement {
  if (copper === undefined) return h('span', { class: 'muted' }, '–');
  const span = h('span', { class: 'coin' });
  for (const part of formatMoney(copper).match(/-|\d+[gsc]/g) ?? []) {
    const unit = part.at(-1);
    span.append(
      unit === 'g' || unit === 's' || unit === 'c'
        ? h('span', {}, part.slice(0, -1), h('span', { class: unit }, unit))
        : part,
    );
  }
  if (signed) span.classList.add(['neg', 'muted', 'pos'][Math.sign(copper) + 1] as string);
  return span;
}

/** 0 means the game data has no vendor price, not that a merchant pays nothing. */
function vendor(copper: number): HTMLElement {
  return copper > 0 ? money(copper) : h('span', { class: 'muted', title: 'No vendor price' }, '–');
}

function cell(content: Child, numeric = false): HTMLElement {
  return h('td', numeric ? { class: 'num' } : {}, content);
}

function header(columns: [string, boolean?][]): HTMLElement {
  return h(
    'thead',
    {},
    h(
      'tr',
      {},
      ...columns.map(([label, numeric]) => h('th', numeric ? { class: 'num' } : {}, label)),
    ),
  );
}

function marketLine(market: Recommendations['market']): HTMLElement {
  const days = market.scanAgeDays;
  const age = days === 0 ? 'scanned today' : days !== undefined && `scanned ${days}d ago`;
  return h(
    'div',
    { class: 'muted' },
    [market.label, age, `${market.items} items priced`].filter(Boolean).join(' · '),
  );
}

function warnings(list: string[]): Child {
  if (list.length === 0) return null;
  return h(
    'div',
    { class: 'warnings', role: 'alert' },
    ...list.map((text) => h('p', {}, `⚠ ${text}`)),
  );
}

function expandable(tbody: HTMLElement, row: HTMLElement, detail: HTMLElement, span: number) {
  const extra = h('tr', { class: 'detail' }, h('td', { colspan: String(span) }, detail));
  extra.hidden = true;
  row.classList.add('row');
  row.tabIndex = 0;
  row.setAttribute('aria-expanded', 'false');
  const toggle = () => {
    extra.hidden = !extra.hidden;
    row.setAttribute('aria-expanded', String(!extra.hidden));
  };
  row.addEventListener('click', toggle);
  row.addEventListener('keydown', (event) => {
    if (event.target !== row || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    toggle();
  });
  tbody.append(row, extra);
}

function batchText(data: Recommendations): string {
  return data.batch > 1 ? ` · reagents bought for ${data.batch} crafts` : '';
}

function rowDetail(row: Row): HTMLElement {
  const supply = row.productMarket;
  return h(
    'div',
    {},
    h(
      'div',
      { class: 'muted' },
      `Learn at ${row.learnSkill}${row.learnSkillExact ? '' : ' (estimated)'} from ${row.learnedFrom} · yellow ${row.yellow} · grey ${row.grey}`,
    ),
    h(
      'ul',
      {},
      ...row.materials.map((m) =>
        h(
          'li',
          {},
          `${m.count} × `,
          named(m),
          ' — ',
          money(m.unitCost),
          ` each, ${m.source}`,
          m.craftedWith ? ` (${m.craftedWith})` : '',
          m.restSource ? ` (${Math.round(m.held ?? 0)} held, the rest ${m.restSource})` : '',
          ...(m.cheapestUnit !== undefined &&
          m.unitCost !== undefined &&
          m.unitCost > m.cheapestUnit
            ? [' (from ', money(m.cheapestUnit), `, ${m.listed} listed)`]
            : []),
        ),
      ),
    ),
    h(
      'div',
      { class: 'muted' },
      `Market: ${supply.units} units ${supply.unitsAre === 'listed now' ? 'listed' : `seen on ${supply.lastSeen}`}`,
      supply.fullScansInWindow
        ? ` · on ${supply.seenOnFullScans} of the last ${supply.fullScansInWindow} full scans`
        : '',
      row.breakEven === undefined ? '' : ' · break-even ',
      row.breakEven === undefined ? '' : money(row.breakEven),
      row.depositEstimate === undefined ? '' : ' · deposit ~',
      row.depositEstimate === undefined ? '' : money(row.depositEstimate),
    ),
    ...row.reasons.map((r) => h('div', { class: 'flag' }, r)),
    ...row.warnings.map((w) => h('div', { class: 'flag' }, `⚠ ${w}`)),
  );
}

function groupHeading(category: string, group: Group<unknown>): HTMLElement {
  const shown =
    group.top.length < group.total ? `${group.top.length} of ${group.total}` : `${group.total}`;
  return h(
    'h3',
    {},
    h('span', { class: `tag ${category}` }, category),
    h('span', { class: 'muted' }, `${shown} · ${CATEGORY_HINT[category] ?? ''}`),
  );
}

function recipeCells(row: Row): HTMLElement[] {
  return [
    cell(
      h(
        'span',
        {},
        named({
          ...row.product,
          name: row.recipe,
          localName: row.recipeLocalName,
          url: row.recipeUrl,
        }),
        row.product.count > 1 ? h('span', { class: 'muted' }, ` ×${row.product.count}`) : '',
        row.warnings.length
          ? h('span', { class: 'flag', title: row.warnings.join('\n') }, ' ⚠')
          : '',
      ),
    ),
    cell(row.learnSkill, true),
    cell(money(row.cost), true),
    cell(
      row.sellVia === 'vendor' ? h('span', { class: 'muted' }, 'vendor') : money(row.listUnit),
      true,
    ),
    cell(vendor(row.vendorUnit), true),
  ];
}

function renderRecommendations(data: Recommendations): Child[] {
  const sections: Child[] = [];
  for (const category of CATEGORIES) {
    const group = data.groups[category] as Group<Row> | undefined;
    if (!group || group.total === 0) continue;
    const tbody = h('tbody');
    for (const row of group.top) {
      expandable(
        tbody,
        h(
          'tr',
          {},
          ...recipeCells(row),
          cell(money(row.ifSold, true), true),
          cell(money(row.sellVia === 'vendor' ? row.ifVendored : row.ifUnsold, true), true),
          cell(row.marginRatio === undefined ? '–' : `${Math.round(row.marginRatio * 100)}%`, true),
        ),
        rowDetail(row),
        8,
      );
    }
    sections.push(
      groupHeading(category, group),
      h(
        'div',
        { class: 'scroll' },
        h(
          'table',
          {},
          header([
            ['Recipe'],
            ['Skill', true],
            ['Cost', true],
            ['List at', true],
            ['Vendor', true],
            ['If sold', true],
            ['If unsold', true],
            ['Margin', true],
          ]),
          tbody,
        ),
      ),
    );
  }
  if (sections.length === 0)
    sections.push(h('p', { class: 'empty' }, 'No recipe clears the minimum profit.'));
  return [
    h('div', { class: 'head' }, h('h2', {}, 'Crafts'), marketLine(data.market)),
    warnings(data.warnings),
    h(
      'div',
      { class: 'muted' },
      `${data.considered} recipes considered · ${data.unpriced} unpriced · ${data.boundOnPickup} bind on pickup · ${data.listingHours}h listings${batchText(data)}. Click a row for materials and risks.`,
    ),
    ...sections,
  ];
}

function renderMaterials(data: Materials): Child[] {
  const holdings = h('tbody');
  for (const holding of data.holdings) {
    holdings.append(
      h(
        'tr',
        {},
        cell(named(holding)),
        cell(holding.quantity, true),
        cell(
          holding.sell.via === 'vendor'
            ? h('span', { class: 'muted' }, 'vendor')
            : money(holding.sell.listUnit),
          true,
        ),
        cell(money(holding.sell.netUnit), true),
        cell(money(holding.sell.total), true),
        cell(
          holding.lastSeen && holding.lastSeen !== data.market.latestScan
            ? h(
                'span',
                { class: 'flag', title: 'Missing from the latest scan' },
                `${holding.marketUnits} (${holding.lastSeen})`,
              )
            : holding.marketUnits,
          true,
        ),
      ),
    );
  }
  const sections: Child[] = [];
  for (const category of CATEGORIES) {
    const group = data.groups[category] as Group<MaterialRow> | undefined;
    if (!group || group.total === 0) continue;
    const tbody = h('tbody');
    for (const use of group.top) {
      const detail = rowDetail(use);
      detail.prepend(
        h(
          'div',
          {},
          'Uses: ',
          ...use.consumes.flatMap((c, i) => [i ? ', ' : '', `${c.total} × `, named(c)]),
        ),
      );
      expandable(
        tbody,
        h(
          'tr',
          {},
          ...recipeCells(use),
          cell(use.crafts, true),
          cell(money(use.ifSold, true), true),
          cell(money(use.gain, true), true),
        ),
        detail,
        8,
      );
    }
    sections.push(
      groupHeading(category, group),
      h(
        'div',
        { class: 'scroll' },
        h(
          'table',
          {},
          header([
            ['Recipe'],
            ['Skill', true],
            ['Cost', true],
            ['List at', true],
            ['Vendor', true],
            ['Crafts', true],
            ['Per craft', true],
            ['Gain', true],
          ]),
          tbody,
        ),
      ),
    );
  }
  if (sections.length === 0)
    sections.push(h('p', { class: 'empty' }, 'No craft earns more than selling these.'));
  return [
    h('div', { class: 'head' }, h('h2', {}, 'Sell or craft'), marketLine(data.market)),
    warnings(data.warnings),
    h('h3', {}, 'Selling as is'),
    h(
      'div',
      { class: 'scroll' },
      h(
        'table',
        {},
        header([
          ['Item'],
          ['Held', true],
          ['List at', true],
          ['Nets', true],
          ['Total', true],
          ['On market', true],
        ]),
        holdings,
      ),
    ),
    h(
      'div',
      { class: 'muted' },
      'Uses compete for the same holdings, so their gains do not add up.',
    ),
    ...sections,
  ];
}

function render(payload: unknown) {
  const data = payload as Record<string, unknown> | undefined;
  let nodes: Child[];
  if (!data) nodes = [h('p', { class: 'empty' }, 'No data.')];
  else if ('holdings' in data) nodes = renderMaterials(data as Materials);
  else if ('groups' in data) nodes = renderRecommendations(data as Recommendations);
  else nodes = [h('pre', {}, JSON.stringify(data, null, 2))];
  const source = (data?.market as { source?: string } | undefined)?.source;
  if (source === 'ahledger')
    nodes.push(
      h('footer', {}, 'Auction prices: data by ', link('AHledger', 'https://ahledger.com')),
    );
  root.replaceChildren(h('div', {}, ...nodes));
}

function applyContext(ctx: McpUiHostContext | undefined) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
}

/** Some hosts forward only `content`; the server puts the same JSON there as text. */
function parsedText(content: { type: string; text?: string }[] | undefined): unknown {
  const text = content?.find((c) => c.type === 'text')?.text;
  try {
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

app.ontoolresult = (result) => {
  if (result.isError) {
    const text = result.content?.find((c) => c.type === 'text');
    root.replaceChildren(
      h('div', { class: 'warnings' }, text && 'text' in text ? text.text : 'The tool failed.'),
    );
    return;
  }
  render(result.structuredContent ?? parsedText(result.content));
};
app.ontoolcancelled = () => {
  root.replaceChildren(h('p', { class: 'empty' }, 'Cancelled.'));
};
app.onhostcontextchanged = applyContext;

await app.connect();
applyContext(app.getHostContext());
