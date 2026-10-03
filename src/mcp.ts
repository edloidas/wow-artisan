#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Advisor } from './advisor.ts';
import { resolveLang } from './i18n/index.ts';
import { allowedHostsFor, MCP_PATH, mcpHandler } from './mcp/http.ts';
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

// Lenient so a host config with arguments we don't know still gets the stdio server.
const { values } = parseArgs({
  strict: false,
  allowPositionals: true,
  options: {
    http: { type: 'boolean' },
    port: { type: 'string', default: '3000' },
    host: { type: 'string', default: '127.0.0.1' },
  },
});

const lang = resolveLang();
const newServer = () => createServer({ advisorFor, listMarkets: listAhledgerMarkets, lang });

if (values.http === true) {
  const { host } = values;
  if (typeof host !== 'string' || host === '') {
    console.error('--host needs an address, e.g. --host 127.0.0.1');
    process.exit(2);
  }
  const port = Number(values.port);
  if (typeof values.port !== 'string' || !/^\d+$/.test(values.port) || port < 1 || port > 65535) {
    console.error('--port needs a number from 1 to 65535, e.g. --port 3000');
    process.exit(2);
  }
  const server = Bun.serve({
    hostname: host,
    port,
    fetch: mcpHandler(newServer, allowedHostsFor(host)),
  });
  console.error(`wow-artisan MCP on ${new URL(MCP_PATH, server.url)}`);
} else {
  await newServer().connect(new StdioServerTransport());
}
