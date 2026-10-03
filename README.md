# wow-artisan

World of Warcraft Forever craft advisor. Finds recipes worth crafting from bought
materials and selling, and tells you whether the materials you hold are worth
more sold as they are or crafted into something.

It reads recipes from the game client data, prices from your own Auctionator
scans or from [AHledger](https://ahledger.com)'s public API, and your inventory
from Syndicator. Everything runs locally: as a CLI, or as an MCP server so an
agent can answer "what should I craft from 80 copper bars at skill 120".

## Setup

```bash
bun install
bun run cli sync          # download recipes and items for your client build
```

The client build is detected from `.build.info` in your WoW folder. Game data,
with Russian names, is cached under `~/.cache/wow-artisan/<build>/`.

## Usage

```bash
# Profitable crafts for your skill, at least 20s profit per craft
bun run cli recipes -p blacksmithing -s 150 --min-profit 20s

# Only recipes a trainer teaches, hiding those that need a plan
bun run cli recipes -p blacksmithing -s 150 --trainer-only

# Same, smelting bars yourself instead of buying them, with the materials listed
bun run cli recipes -p blacksmithing -s 150 --craft-with mining --details

# Sell 200 copper bars, or craft them into something?
bun run cli materials -p blacksmithing -s 150 --have "Copper Bar:200" --craft-with mining

# Every in-scope material in your bags and banks (from Syndicator)
bun run cli materials -p blacksmithing --inventory

# Use AHledger's US market instead of your own scans
bun run cli markets
bun run cli recipes -p blacksmithing -m ahledger:forever.normal.alliance.us
```

Professions: `blacksmithing`, `mining`. Add `--json` for machine-readable output.
`bun run cli --help` lists every option.

`--lang ru` (or `WOW_ARTISAN_LANG=ru`) prints the output in Russian, with item
and recipe names from the client's ruRU data; `--have` takes Russian names too.
In a terminal that supports hyperlinks, recipe and item names link to Wowhead,
in the output language. JSON text stays English, with Wowhead `url` fields on
items and recipes and a `localName` beside `name` for a non-English language.

### MCP server

Claude Code:

```bash
claude mcp add wow-artisan -- bun /path/to/wow-artisan/src/mcp.ts
```

Claude Desktop, in `claude_desktop_config.json` (Settings → Developer → Edit
Config). Desktop starts the server without your shell's `PATH`, so give the full
path to `bun` (`which bun`):

```json
{
  "mcpServers": {
    "wow-artisan": {
      "command": "/Users/you/.bun/bin/bun",
      "args": ["/path/to/wow-artisan/src/mcp.ts"],
      "env": { "WOW_ARTISAN_LANG": "en" }
    }
  }
}
```

Tools: `recommend_crafts`, `evaluate_materials`, `item_price`, `find_items`,
`list_markets`. All are read-only. Each returns its JSON both as
`structuredContent` and as text. In hosts that support MCP Apps, such as Claude
Desktop, `recommend_crafts`, `evaluate_materials` and `item_price` also render a
view: tables by category with prices in gold, silver and copper, and rows that
expand to show materials and risks. The item view adds a price history chart and
Wowhead links. Other hosts show the JSON, and so does a Desktop build that does not
render the view; the answer is the same either way.

## How it decides

- **Cost** of each reagent is the cheapest of: the auction house, a merchant, or
  crafting it yourself from recipes in scope, up to three steps deep. On the
  auction house a craft's few units come at the cheapest listing when the market
  holds at least ten times as many and that listing is not far under the usual
  price; otherwise at the usual price (AHledger: the median of what is listed).
  Scans keep no price ladder, so a larger buy can't be priced along it. Merchant
  prices are those Auctionator cached when you visited one, plus fluxes, coal,
  coarse thread and green dye from trade-supply merchants.
- **List at** is the asking price to type into the auction house: the lower of
  the cheapest listing and the usual price. A sale nets it minus the 5% cut.
  **Vendor** is what a merchant pays. The product goes the way that nets more; on
  a tie the merchant wins. Products that bind on pickup never count as auction
  sales.
- **If sold** is the margin per craft if every unit sells at that price. Nothing
  records sales, so it is a condition, not a forecast. **Break-even** is the
  lowest asking price per unit that covers the cost after the cut. **If unsold**
  is what is left when the listing expires once, losing its deposit, and every
  unit then goes to a merchant.
- **Deposits** are 5%, 20% or 60% of the vendor price per unit for a 2, 8 or 24
  hour listing. Forever offers those three durations; the rates are Classic
  Era's. The default duration is the one set in Auctionator, else 24 hours;
  `--hours` overrides it. The deposit is refunded on sale, so "if sold" leaves it
  out, and lost when the auction expires. A row is flagged when one expired
  listing costs more than a sale earns, or when the auction adds less than a
  deposit over the vendor price.
- **Freshness**: the header gives the day of your latest full scan, with a
  warning from two days old.
- **Categories** describe where the product goes and the markets a recipe depends
  on, not whether it sells:
  - *Steady*: enough units, the product's asking price holds, and it was on most
    of your recent full scans.
  - *Vendor*: the product is worth more to a merchant. No auction risk, no
    deposit, no limit on how many it takes.
  - *Volatile*: the product's price jumps around. The cheapest listing is far
    below the usual price, the price swung over the period, or the 7-day median
    drifts from the 30-day one. A cheapest listing above the usual price is not
    a risk: the sale price already takes the lower of the two.
  - *Thin*: few units of the product or of a bought reagent, the item was
    missing from your latest scan so its figures are old, or the product was on
    fewer than half, or fewer than three, of your last seven full scans.
    Auctionator also records single-item searches as scan days; only days that
    saw at least half as many items as the busiest one count as full scans.
  - *No market*: nothing is listed and no vendor buys it; only the cost is shown.

  Reagent price history and presence do not matter: you buy at today's price.
  Only whether enough is on the market does. Thresholds are flags: `--thin`, `--spread`,
  `--swing`, `--trend`.
- **Units** on your own scans are the most units Auctionator saw on the last day
  it scanned the item, not what is listed now; the output says which day.
- **Materials**: your materials cost what selling them nets, and each recipe that
  uses them, through intermediates such as ore → bar → item, is evaluated like
  `recipes`. Its gain is what a craft earns above selling what it uses; recipes
  that don't beat selling are left out. Crafts count only what you hold, buying
  the other reagents. Uses compete for the same materials, so their totals don't
  add up.

## Caveats

- `--trainer-only` hides recipes taught by a "Plans:" item, matched by name. It
  can't know which plans you own, and a recipe learned from a quest without a
  plan item still counts as a trainer recipe. The `learn` column marks plan
  recipes.
- Learn skill marked `~` is estimated. Only plans carry the skill a recipe needs;
  for trainer recipes it is the yellow threshold minus 20, the most common gap.
- The deposit rates come from Classic Era (a Chronoboon with a 2g50s vendor
  price costs 12s50c, 50s and 1g50s for 2, 8 and 24 hours) and are not yet
  confirmed on Forever. AHledger describes Forever as listing for 12, 24 or 48
  hours, but Auctionator's Forever build offers 2, 8 and 24.
- Margins assume your listings don't move the price. A batch that is a large share
  of the units on the market will sell lower.
- Auctionator keys its database by realm only. With characters of both factions
  on one gameplay style, their scans mix in one market.
- Auctionator records only the cheapest price per scan and the most units seen
  per day, so the risk checks are weaker on your own scans than on AHledger data.
- AHledger covers US markets only. Price data from AHledger, used under its free
  attribution terms.

## Configuration

| Variable | Default |
| --- | --- |
| `WOW_ARTISAN_MARKET` | `auctionator` |
| `WOW_ARTISAN_LANG` | `en`; `ru` for Russian output and Wowhead links |
| `WOW_ARTISAN_WOW_DIR` | `/Applications/World of Warcraft`, or the Windows install path |
| `WOW_ARTISAN_FLAVOR` | the client folder whose version is 1.60.x, e.g. `_classic_beta_` |
| `WOW_ARTISAN_ACCOUNT` | the account with the most recently written SavedVariables |
