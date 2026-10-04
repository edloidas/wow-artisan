export const PROFESSIONS = {
  alchemy: 171,
  blacksmithing: 164,
  cooking: 185,
  enchanting: 333,
  engineering: 202,
  'first-aid': 129,
  leatherworking: 165,
  mining: 186,
  tailoring: 197,
} as const;

export type Profession = keyof typeof PROFESSIONS;

export type ItemInfo = {
  name: string;
  /** Copper a vendor pays for one. */
  sellPrice: number;
  /** Copper a merchant charges, if one sells it; game data has a value even for items none sells. */
  buyPrice: number;
  quality: number;
  itemLevel: number;
  requiredLevel: number;
  /** True for bind-on-pickup items, which can't go on the auction house. */
  boundOnPickup: boolean;
};

export type Reagent = { itemId: number; count: number };

export type Recipe = {
  spellId: number;
  name: string;
  profession: Profession;
  output: Reagent;
  reagents: Reagent[];
  /** Skill at which the recipe turns yellow. */
  yellow: number;
  /** Skill at which the recipe turns grey. */
  grey: number;
  learnSkill: number;
  /**
   * False when estimated: trainer recipes carry no learn skill in client data,
   * only plan/pattern items do.
   */
  learnSkillExact: boolean;
  /** The plan item that teaches the recipe; absent for recipes learned from a trainer. */
  planItemId?: number;
};

/** Client locales whose names are cached besides English, keyed by output language. */
export const NAME_LOCALES = { ru: 'ruRU' } as const;
export type NameLocale = keyof typeof NAME_LOCALES;

/** Translated names by item id and by recipe spell id. */
export type LocalNames = { items: Record<string, string>; recipes: Record<string, string> };

export type GameData = {
  build: string;
  items: Record<string, ItemInfo>;
  recipes: Recipe[];
  localNames?: Partial<Record<NameLocale, LocalNames>>;
};
