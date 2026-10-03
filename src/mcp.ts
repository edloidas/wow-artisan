#!/usr/bin/env bun
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Advisor } from './advisor.ts';
import { resolveLang } from './i18n/index.ts';
import { createServer } from './mcp/server.ts';
import { listAhledgerMarkets } from './prices/ahledger.ts';

/** Saved scans and AHledger tables change slowly; reload an advisor after this long. */
const ADVISOR_TTL_MS = 5 * 60_000;

const advisors = new Map<string, { advisor: Promise<Advisor>; createdAt: number }>();

function advisorFor(market: string | undefined): Promise<Advisor> {
  const key = market ?? '';
  const cached = advisors.get(key);
  if (cached && Date.now() - cached.createdAt < ADVISOR_TTL_MS) return cached.advisor;
  const advisor = Advisor.create(market ? { market } : {});
  advisor.catch(() => advisors.delete(key));
  advisors.set(key, { advisor, createdAt: Date.now() });
  return advisor;
}

const server = createServer({ advisorFor, listMarkets: listAhledgerMarkets, lang: resolveLang() });
await server.connect(new StdioServerTransport());
