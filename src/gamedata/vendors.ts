import type { GameData } from './types.ts';

/**
 * Reagents trade-supply merchants stock without limit. Game data prices every item, sold or
 * not, so only these ids are trusted; each matched Wowhead's vendor price for Forever.
 */
const TRADE_SUPPLIES = [
  2880, // Weak Flux
  3466, // Strong Flux
  18567, // Elemental Flux
  3857, // Coal
  2320, // Coarse Thread
  2605, // Green Dye
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
