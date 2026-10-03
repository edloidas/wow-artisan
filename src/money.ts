export const COPPER_PER_SILVER = 100;
export const COPPER_PER_GOLD = 10_000;

export function formatMoney(copper: number | undefined): string {
  if (copper === undefined || !Number.isFinite(copper)) return '-';
  const sign = copper < 0 ? '-' : '';
  const total = Math.round(Math.abs(copper));
  const gold = Math.floor(total / COPPER_PER_GOLD);
  const silver = Math.floor((total % COPPER_PER_GOLD) / COPPER_PER_SILVER);
  const rest = total % COPPER_PER_SILVER;
  if (gold > 0) return `${sign}${gold}g${String(silver).padStart(2, '0')}s`;
  if (silver > 0) return `${sign}${silver}s${String(rest).padStart(2, '0')}c`;
  return `${sign}${rest}c`;
}

/** Parses "1g20s", "50s", "1.5g", "75c"; a bare number is copper. */
export function parseMoney(input: string | number): number {
  if (typeof input === 'number') return input;
  const text = input.trim().toLowerCase().replace(/\s+/g, '');
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  const match = /^(-)?(?:(\d+(?:\.\d+)?)g)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)c)?$/.exec(text);
  if (!match || text === '' || text === '-') throw new Error(`Invalid amount: ${input}`);
  const [, minus, g = '0', s = '0', c = '0'] = match;
  const copper = Number(g) * COPPER_PER_GOLD + Number(s) * COPPER_PER_SILVER + Number(c);
  return Math.round(minus ? -copper : copper);
}
