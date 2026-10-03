# wow-artisan

WoW Forever craft advisor. TypeScript on Bun, no framework. One core in
`src/advisor.ts` and `src/engine/`, two front ends: `src/cli.ts` and `src/mcp.ts`.

## Commands

```bash
bun run cli <command>   # recipes | materials | markets | sync
bun run mcp             # MCP server on stdio
bun run mcp --http      # MCP server on http://127.0.0.1:3000/mcp
bun check:fix           # Typecheck + biome --write
bun test                # No network, no game install needed
bun validate            # Full gate: check + test:ci
```

## Data sources

- **Recipes and items**: wago.tools DB2 CSV exports for the installed client
  build, joined in `src/gamedata/load.ts` and cached as JSON. Bump `CACHE_FILE`
  when the cached shape changes.
- **Prices**: Auctionator SavedVariables (CBOR blobs per realm inside a Lua
  string; WoW writes CBOR strings, keys included, as byte strings) or the
  AHledger API (US only, attribution required).
- **Inventory**: Syndicator SavedVariables.

SavedVariables are parsed as latin1 so binary strings survive. Run text through
`luaText` before showing it.

Don't copy Auctionator code: it is All Rights Reserved. Reading it to learn the
data format is fine.
