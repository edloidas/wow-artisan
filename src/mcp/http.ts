import { isIPv4, isIPv6 } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

export const MCP_PATH = '/mcp';

export const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** Host names to accept on a server bound to `host`: loopback names and its own. */
export function allowedHostsFor(host: string): HttpOptions {
  const name = hostName(host);
  if (name === undefined || !isLoopback(name)) return {};
  return { allowedHosts: [...new Set([...LOOPBACK_HOSTS, name])] };
}

/** The name as a Host header carries it: `127.1` becomes `127.0.0.1`, `::1` becomes `[::1]`. */
function hostName(host: string): string | undefined {
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  try {
    return new URL(`http://${bracketed}`).hostname;
  } catch {
    return undefined;
  }
}

function isLoopback(name: string): boolean {
  if (name === 'localhost') return true;
  const ip = name.replace(/^\[|\]$/g, '');
  if (isIPv4(ip)) return ip.startsWith('127.');
  return isIPv6(ip) && (ip === '::1' || ip.startsWith('::ffff:7f'));
}

export type HttpOptions = {
  /** Host header names to accept; `undefined` accepts any, for a server bound beyond loopback. */
  allowedHosts?: string[];
};

/**
 * A fetch handler for MCP over Streamable HTTP, stateless: every POST gets a fresh
 * server and transport, and the JSON response holds the whole answer.
 */
export function mcpHandler(
  createServer: () => McpServer,
  options: HttpOptions = {},
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== MCP_PATH) return new Response('Not Found', { status: 404 });
    // A page on any site can reach a loopback server through DNS rebinding; its Host stays foreign.
    if (options.allowedHosts && !options.allowedHosts.includes(url.hostname)) {
      return new Response('Forbidden', { status: 403 });
    }
    if (options.allowedHosts && !originAllowed(request, options.allowedHosts)) {
      return new Response('Forbidden', { status: 403 });
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
    }

    const server = createServer();
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      await server.close();
    }
  };
}

/** A web page must come from an allowed host; other origins (none, `null`, app schemes) pass. */
function originAllowed(request: Request, allowed: string[]): boolean {
  const origin = URL.parse(request.headers.get('origin') ?? '');
  if (origin?.protocol !== 'http:' && origin?.protocol !== 'https:') return true;
  return allowed.includes(origin.hostname);
}
