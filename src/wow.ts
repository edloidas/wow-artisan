import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const FOREVER_VERSION_PREFIX = '1.60.';
export const FALLBACK_BUILD = '1.60.1.70170';

const DEFAULT_ROOTS = [
  '/Applications/World of Warcraft',
  'C:\\Program Files (x86)\\World of Warcraft',
  'C:\\Program Files\\World of Warcraft',
];

export type Installation = {
  root: string;
  /** Client folder such as `_classic_beta_`. */
  flavorDir: string;
  build: string;
};

type BuildInfoRow = { product: string; version: string };

export function findWowRoot(): string | undefined {
  const fromEnv = process.env.WOW_ARTISAN_WOW_DIR;
  if (fromEnv) return fromEnv;
  return DEFAULT_ROOTS.find((root) => existsSync(root));
}

function readBuildInfo(root: string): BuildInfoRow[] {
  const file = join(root, '.build.info');
  if (!existsSync(file)) return [];
  const [header, ...lines] = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const columns = (header ?? '').split('|').map((column) => column.split('!')[0]);
  const product = columns.indexOf('Product');
  const version = columns.indexOf('Version');
  return lines.map((line) => {
    const cells = line.split('|');
    return { product: cells[product] ?? '', version: cells[version] ?? '' };
  });
}

/** `wow_classic_beta` -> `_classic_beta_`, `wow` -> `_retail_`. */
function productDir(product: string): string {
  return `_${product.replace(/^wow_?/, '') || 'retail'}_`;
}

/**
 * Picks the Forever client: `WOW_ARTISAN_FLAVOR` wins, otherwise the installed
 * product whose version is 1.60.x.
 */
export function findInstallation(): Installation | undefined {
  const root = findWowRoot();
  if (!root) return undefined;
  const rows = readBuildInfo(root);
  const flavorDir = process.env.WOW_ARTISAN_FLAVOR;
  const row = flavorDir
    ? rows.find((r) => productDir(r.product) === flavorDir)
    : rows.find((r) => r.version.startsWith(FOREVER_VERSION_PREFIX));
  const dir = flavorDir ?? (row ? productDir(row.product) : undefined);
  if (!dir || !existsSync(join(root, dir))) return undefined;
  return { root, flavorDir: dir, build: row?.version || FALLBACK_BUILD };
}

/**
 * Account-wide SavedVariables file of an addon. With several accounts the most
 * recently written one wins, unless `WOW_ARTISAN_ACCOUNT` names one.
 */
export function findAccountSavedVariables(
  installation: Installation,
  addon: string,
): string | undefined {
  const accountsDir = join(installation.root, installation.flavorDir, 'WTF', 'Account');
  if (!existsSync(accountsDir)) return undefined;
  const wanted = process.env.WOW_ARTISAN_ACCOUNT;
  const candidates = readdirSync(accountsDir)
    .filter((account) => !wanted || account === wanted)
    .map((account) => join(accountsDir, account, 'SavedVariables', `${addon}.lua`))
    .filter((file) => existsSync(file));
  return candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}
