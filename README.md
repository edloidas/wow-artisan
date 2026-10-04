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

# With mining at 120: Gold, Steel and Mithril can't be smelted yet, so those bars are bought
bun run cli recipes -p blacksmithing -s 150 --craft-with mining:120 --details

# A friend with tailoring 250 weaves the bolts; repeat --craft-with for as many as you like
bun run cli recipes -p leatherworking -s 200 --craft-with tailoring:250 --craft-with mining

# Priced for 100 crafts: big buys climb past the cheapest listings
bun run cli recipes -p mining --crafts 100 --details

# Sell 200 copper bars, or craft them into something?
bun run cli materials -p blacksmithing -s 150 --have "Copper Bar:200" --craft-with mining

# Every in-scope material in your bags and banks (from Syndicator)
bun run cli materials -p blacksmithing --inventory

# Cheapest way to get 100 bronze bars: buy them, or smelt them from your ore plus bought tin
bun run cli obtain -p mining "Bronze Bar:100" --have "Copper Ore:60"

# Use AHledger's US market instead of your own scans
bun run cli markets
bun run cli recipes -p blacksmithing -m ahledger:forever.normal.alliance.us
```

`--craft-with` names a profession you or a friend has, as many times as needed; the
same profession given twice counts at the higher skill. Without a skill it is taken
to be at least `--skill`, as a gathering profession usually is; with no `--skill`
either, any recipe counts.

Professions: `alchemy`, `blacksmithing`, `cooking`, `enchanting`, `engineering`,
`first-aid`, `leatherworking`, `mining`, `tailoring`. Enchanting covers what it makes
as items (rods, oils, wands, essences); enchants on gear have no item to price. Add `--json` for machine-readable output.
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

Over Streamable HTTP instead of stdio, for a host that connects by URL or a
server shared by several clients:

```bash
bun run mcp --http                 # http://127.0.0.1:3000/mcp
claude mcp add --transport http wow-artisan http://127.0.0.1:3000/mcp
```

`--port` and `--host` change where it listens. On a loopback host it answers
only requests addressed to `localhost`, `127.0.0.1`, `[::1]` or the address it
is bound to, and from no web page but one on those hosts, so a site can't reach
it through DNS rebinding. Any other `--host` drops that check and
exposes the server without authentication to whoever can reach the address.

Tools: `recommend_crafts`, `evaluate_materials`, `item_price`, `find_items`,
`list_markets`. `recommend_crafts` takes `crafts` to price a batch; `item_price`
takes `quantity` and holdings and lists every way to obtain that many, cheapest
first. All are read-only. Each returns its JSON both as
`structuredContent` and as text. In hosts that support MCP Apps, such as Claude
Desktop, `recommend_crafts` and `evaluate_materials` also render a view: tables
by category with prices in gold, silver and copper, Wowhead links, and rows that
expand to show materials and risks. The lookup tools render nothing, so checking
an item does not replace the table the answer is built on. Other hosts show the JSON, and so does a Desktop build that does not
render the view; the answer is the same either way.

## How it decides

- **Cost** of each reagent is the cheapest of: the auction house, a merchant, or
  crafting it yourself from recipes in scope, up to three steps deep. Reagents
  are bought for the whole batch: one craft for `recipes` unless `--crafts`
  says more, the crafts your materials cover for `materials`, the quantity for
  `obtain`. Scans keep no price ladder, so one is modelled: prices climb
  linearly from the cheapest listing to the median of what is listed (AHledger)
  at the middle unit. Your own scans have no listing median, so the middle unit
  costs the usual price, and at least 20% over the cheapest. A batch pays the
  average along that climb, so a few units from a deep market cost about the
  cheapest listing, and buying everything listed averages the median. Units
  beyond what is listed cost the top of the climb, and the recipe turns thin
  with "need N, only M listed". A route the market can fully supply beats one
  it can't, whatever the price: past what is listed the price is a guess, and
  on AHledger those units are not for sale today. A cheapest listing far under
  the usual price is assumed to be a single unit and is ignored, so the climb
  starts at the usual price. Cheap listings can top up another route: a batch
  buys the units that cost less than the next-best route, then gets the rest
  from that route: the copper bars listed under what smelting costs are bought,
  and the rest smelted.
  An item a recipe needs twice, directly and through an intermediate, is bought
  along one climb and drawn from your materials once. Crafts are whole: 3 bronze
  bars take 2 smelts, and the spare bar counts at what it sells for, up to what
  it cost to make. Merchant prices are those Auctionator cached when you visited
  one, plus fluxes, coal, coarse thread and green dye from trade-supply
  merchants.
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
  the other reagents for all of them. Uses compete for the same materials, so
  their totals don't add up.
- **Obtain** lists every way to get a quantity of one item, cheapest first:
  buying it, a merchant, or each recipe that makes it. Your materials are used
  first at what selling them nets, and what they don't cover is bought or
  crafted, so 60 copper ore toward 100 bronze bars smelts the 60 and buys the
  rest at the batch price. Each reagent picks its own source, so the winner can
  buy copper bars, smelt tin from ore and buy no bronze, or buy the bronze
  outright. A route that needs more than is listed says so.

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
  of the units on the market will sell lower. Buying is priced along the
  modelled climb; selling is not.
- The climb is a model, not the market's real price ladder: straight, from the
  cheapest listing to the median. On your own scans its steepness is a guess,
  and the units counted are the most seen that day, not what is listed now.
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
