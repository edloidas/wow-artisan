export const PROFESSIONS = {
  blacksmithing: 164,
  mining: 186,
} as const;

export type Profession = keyof typeof PROFESSIONS;

export type ItemInfo = {
  name: string;
  /** Copper a vendor pays for one. */
  sellPrice: number;
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
};

export type GameData = {
  build: string;
  items: Record<string, ItemInfo>;
  recipes: Recipe[];
};
