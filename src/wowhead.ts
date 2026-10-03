import type { Lang } from './i18n/index.ts';

/** Wowhead's Forever database; non-English pages sit under a locale segment after `forever/`. */
export function wowheadUrl(kind: 'item' | 'spell', id: number, lang: Lang = 'en'): string {
  const locale = lang === 'en' ? '' : `${lang}/`;
  return `https://www.wowhead.com/forever/${locale}${kind}=${id}`;
}
