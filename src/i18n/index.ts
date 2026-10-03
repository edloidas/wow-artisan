import type { Reason } from '../engine/recommend.ts';
import type { NameLocale } from '../gamedata/types.ts';
import { en } from './en.ts';
import type { Messages } from './messages.ts';
import { ru } from './ru.ts';

export type { HoldingLine, Messages } from './messages.ts';
export { en, ru };

/** Every cached name locale needs messages too. */
const LANGS: Record<'en' | NameLocale, Messages> = { en, ru };
export type Lang = keyof typeof LANGS;

/** The `--lang` value, else `WOW_ARTISAN_LANG`, else English. */
export function resolveLang(value = process.env.WOW_ARTISAN_LANG): Lang {
  if (!value) return 'en';
  const lang = value.toLowerCase();
  if (lang in LANGS) return lang as Lang;
  throw new Error(`Unknown language '${value}'; use ${Object.keys(LANGS).join(' or ')}`);
}

export function messages(lang: Lang): Messages {
  return LANGS[lang];
}

export function reasonText(t: Messages, name: (itemId: number) => string, reason: Reason): string {
  const subject = reason.item === 'product' ? t.product : name(reason.item);
  return `${subject}: ${t.issue(reason.issue)}`;
}
