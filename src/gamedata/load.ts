import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseCsv } from './csv.ts';
import type {
  GameData,
  ItemInfo,
  LocalNames,
  NameLocale,
  Profession,
  Reagent,
  Recipe,
} from './types.ts';
import { NAME_LOCALES, PROFESSIONS } from './types.ts';

const WAGO = 'https://wago.tools/db2';
const SPELL_EFFECT_CREATE_ITEM = '24';
const ACQUIRE_ON_SKILL_LEARN = '1';
const MAX_REAGENTS = 8;
const BONDING_ON_PICKUP = '1';
/** Bump when the cached shape changes. */
const CACHE_FILE = 'gamedata-v6.json';
/** Most common gap between learn skill and yellow among recipes that come from plans. */
const ESTIMATED_LEARN_OFFSET = 20;

type Row = Record<string, string>;

export function cacheDir(build: string): string {
  const base = process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache');
  return join(base, 'wow-artisan', build);
}

async function fetchTable(build: string, table: string, locale?: string): Promise<Row[]> {
  const query = locale ? `&locale=${locale}` : '';
  const response = await fetch(`${WAGO}/${table}/csv?build=${build}${query}`);
  if (!response.ok) throw new Error(`wago.tools ${table}@${build}: HTTP ${response.status}`);
  return parseCsv(await response.text());
}

export async function loadGameData(build: string, refresh = false): Promise<GameData> {
  const dir = cacheDir(build);
  const file = join(dir, CACHE_FILE);
  if (!refresh && existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as GameData;

  // Translations are optional: a build wago.tools has no locale for still syncs in English.
  const locales = (Object.entries(NAME_LOCALES) as [NameLocale, string][]).map(
    async ([lang, locale]) => {
      const tables = await Promise.all([
        fetchTable(build, 'ItemSparse', locale),
        fetchTable(build, 'SpellName', locale),
      ]).catch(() => undefined);
      return [lang, tables] as const;
    },
  );
  const [abilities, names, effects, reagents, items] = await Promise.all(
    ['SkillLineAbility', 'SpellName', 'SpellEffect', 'SpellReagents', 'ItemSparse'].map((table) =>
      fetchTable(build, table),
    ),
  );
  const data = buildGameData(build, {
    abilities: abilities ?? [],
    names: names ?? [],
    effects: effects ?? [],
    reagents: reagents ?? [],
    items: items ?? [],
  });
  const translated: GameData['localNames'] = {};
  for (const [lang, tables] of await Promise.all(locales)) {
    if (tables) translated[lang] = localNames(data, ...tables);
  }
  if (Object.keys(translated).length > 0) data.localNames = translated;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(data));
  return data;
}

type Tables = {
  abilities: Row[];
  names: Row[];
  effects: Row[];
  reagents: Row[];
  items: Row[];
};

export function buildGameData(build: string, tables: Tables): GameData {
  const items: Record<string, ItemInfo> = {};
  for (const row of tables.items) {
    items[row.ID ?? ''] = {
      name: row.Display_lang ?? '',
      sellPrice: Number(row.SellPrice) || 0,
      buyPrice: Number(row.BuyPrice) || 0,
      quality: Number(row.OverallQualityID) || 0,
      itemLevel: Number(row.ItemLevel) || 0,
      requiredLevel: Number(row.RequiredLevel) || 0,
      boundOnPickup: row.Bonding === BONDING_ON_PICKUP,
    };
  }

  const professionBySkillLine = new Map<string, Profession>(
    Object.entries(PROFESSIONS).map(([name, id]) => [String(id), name as Profession]),
  );
  const abilities = new Map(
    tables.abilities
      .filter((row) => professionBySkillLine.has(row.SkillLine ?? ''))
      .map((row) => [row.Spell ?? '', row]),
  );
  const spellNames = new Map(
    tables.names.filter((row) => abilities.has(row.ID ?? '')).map((r) => [r.ID, r.Name_lang]),
  );

  const outputs = new Map<string, Reagent>();
  for (const row of tables.effects) {
    if (
      row.Effect === SPELL_EFFECT_CREATE_ITEM &&
      row.DifficultyID === '0' &&
      abilities.has(row.SpellID ?? '')
    ) {
      outputs.set(row.SpellID ?? '', {
        itemId: Number(row.EffectItemType),
        count: Math.max(1, Math.round(Number(row.EffectBasePointsF) || 1)),
      });
    }
  }

  const reagentsBySpell = new Map<string, Reagent[]>();
  for (const row of tables.reagents) {
    if (!abilities.has(row.SpellID ?? '')) continue;
    const list: Reagent[] = [];
    for (let i = 0; i < MAX_REAGENTS; i++) {
      const itemId = Number(row[`Reagent_${i}`]);
      if (itemId > 0) list.push({ itemId, count: Number(row[`ReagentCount_${i}`]) || 1 });
    }
    reagentsBySpell.set(row.SpellID ?? '', list);
  }

  const plans = plansByRecipeName(tables.items);

  const recipes: Recipe[] = [];
  for (const [spell, ability] of abilities) {
    const output = outputs.get(spell);
    const name = spellNames.get(spell);
    const profession = professionBySkillLine.get(ability.SkillLine ?? '');
    if (!output || !name || !profession) continue;
    const yellow = Number(ability.TrivialSkillLineRankLow) || 1;
    const grey = Number(ability.TrivialSkillLineRankHigh) || yellow;
    const plan = plans.get(`${ability.SkillLine}:${name}`);
    // A plan demanding more than the yellow threshold is a name collision, not this recipe.
    const ownPlan = plan && plan.rank <= yellow ? plan : undefined;
    const learn = resolveLearnSkill(ability, yellow, ownPlan?.rank);
    const recipe: Recipe = {
      spellId: Number(spell),
      name,
      profession,
      output,
      reagents: reagentsBySpell.get(spell) ?? [],
      yellow,
      grey,
      learnSkill: learn.skill,
      learnSkillExact: learn.exact,
    };
    if (ownPlan && ability.AcquireMethod !== ACQUIRE_ON_SKILL_LEARN)
      recipe.planItemId = ownPlan.itemId;
    recipes.push(recipe);
  }
  recipes.sort((a, b) => a.learnSkill - b.learnSkill || a.name.localeCompare(b.name));
  return { build, items, recipes };
}

/** Translated names for every known item and recipe; rows without a translation are left out. */
export function localNames(data: GameData, items: Row[], spells: Row[]): LocalNames {
  const result: LocalNames = { items: {}, recipes: {} };
  for (const row of items) {
    const id = row.ID ?? '';
    if (row.Display_lang && data.items[id]) result.items[id] = row.Display_lang;
  }
  const recipeIds = new Set(data.recipes.map((r) => String(r.spellId)));
  for (const row of spells) {
    const id = row.ID ?? '';
    if (row.Name_lang && recipeIds.has(id)) result.recipes[id] = row.Name_lang;
  }
  return result;
}

/** "Plans: Copper Chain Belt" requiring Blacksmithing 35 -> "164:Copper Chain Belt" => its id, 35. */
function plansByRecipeName(items: Row[]): Map<string, { itemId: number; rank: number }> {
  const result = new Map<string, { itemId: number; rank: number }>();
  for (const row of items) {
    const skillLine = row.RequiredSkill;
    const rank = Number(row.RequiredSkillRank);
    const name = row.Display_lang ?? '';
    const separator = name.indexOf(': ');
    if (!skillLine || skillLine === '0' || !rank || separator === -1) continue;
    result.set(`${skillLine}:${name.slice(separator + 2)}`, { itemId: Number(row.ID), rank });
  }
  return result;
}

function resolveLearnSkill(
  ability: Row,
  yellow: number,
  plan: number | undefined,
): { skill: number; exact: boolean } {
  if (ability.AcquireMethod === ACQUIRE_ON_SKILL_LEARN) return { skill: 1, exact: true };
  if (plan !== undefined) return { skill: plan, exact: true };
  return { skill: Math.max(1, yellow - ESTIMATED_LEARN_OFFSET), exact: false };
}
