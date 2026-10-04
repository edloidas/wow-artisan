import type { GameData } from './types.ts';

/**
 * Reagents merchants stock without limit all year. Game data prices every item, sold or
 * not, so only these ids are trusted; each matched Wowhead's vendor price for Forever.
 */
const TRADE_SUPPLIES = [
  159, // Refreshing Spring Water
  1179, // Ice Cold Milk
  1205, // Melon Juice
  1645, // Moonberry Juice
  1708, // Sweet Nectar
  2320, // Coarse Thread
  2321, // Fine Thread
  2324, // Bleach
  2325, // Black Dye
  2596, // Skin of Dwarven Stout
  2604, // Red Dye
  2605, // Green Dye
  2678, // Mild Spices
  2686, // Thunder Ale
  2692, // Hot Spices
  2723, // Bottle of Dalaran Noir
  2880, // Weak Flux
  2894, // Rhapsody Malt
  3030, // Razor Arrow
  3371, // Empty Vial
  3372, // Leaded Vial
  3466, // Strong Flux
  3713, // Soothing Spices
  3857, // Coal
  4289, // Salt
  4291, // Silken Thread
  4340, // Gray Dye
  4341, // Yellow Dye
  4342, // Purple Dye
  4399, // Wooden Stock
  4400, // Heavy Stock
  4470, // Simple Wood
  4536, // Shiny Red Apple
  4605, // Red-speckled Mushroom
  6260, // Blue Dye
  6261, // Orange Dye
  6530, // Nightcrawlers
  8343, // Heavy Silken Thread
  8925, // Crystal Vial
  10284, // Simple Flour
  10290, // Pink Dye
  10647, // Engineer's Ink
  10648, // Blank Parchment
  11291, // Star Wood
  14341, // Rune Thread
  17034, // Maple Seed
  17035, // Stranglethorn Seed
  18567, // Elemental Flux
  272941, // Thick Logs
];

/** Merchant prices for trade supplies, for items Auctionator hasn't seen at a vendor. */
export function tradeSupplyPrices(game: GameData): Map<number, number> {
  const prices = new Map<number, number>();
  for (const itemId of TRADE_SUPPLIES) {
    const price = game.items[itemId]?.buyPrice;
    if (price) prices.set(itemId, price);
  }
  return prices;
}
