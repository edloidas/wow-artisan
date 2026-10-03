import { afterEach, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { allowedHostsFor, LOOPBACK_HOSTS, mcpHandler } from '../src/mcp/http.ts';

function echoServer(): McpServer {
  const server = new McpServer({ name: 'echo', version: '1' });
  server.registerTool('echo', { inputSchema: { text: z.string() } }, async ({ text }) => ({
    content: [{ type: 'text', text }],
  }));
  return server;
}

type Handler = (request: Request) => Promise<Response>;

const handle = mcpHandler(echoServer, { allowedHosts: LOOPBACK_HOSTS });

const clients: Client[] = [];

async function connect(url = 'http://localhost:3000/mcp', handler: Handler = handle) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    fetch: (input, init) => handler(new Request(input, init)),
  });
  const client = new Client({ name: 'test', version: '1' });
  clients.push(client);
  // The SDK's own transport types clash with exactOptionalPropertyTypes.
  await client.connect(transport as Transport);
  return client;
}

async function echo(client: Client, text: string): Promise<unknown> {
  const result = (await client.callTool({ name: 'echo', arguments: { text } })) as CallToolResult;
  return result.content;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

describe('streamable HTTP', () => {
  test('answers tool calls', async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(['echo']);
    expect(await echo(c, 'hi')).toEqual([{ type: 'text', text: 'hi' }]);
  });

  test('answers concurrent requests from separate clients', async () => {
    const [a, b] = await Promise.all([connect(), connect()]);
    const answers = await Promise.all([echo(a, 'a1'), echo(b, 'b1'), echo(a, 'a2'), echo(b, 'b2')]);
    expect<unknown[]>(answers).toEqual(
      ['a1', 'b1', 'a2', 'b2'].map((text) => [{ type: 'text', text }]),
    );
  });

  test.each(LOOPBACK_HOSTS)('accepts loopback host %s', async (host) => {
    const { tools } = await (await connect(`http://${host}:3000/mcp`)).listTools();
    expect(tools.map((t) => t.name)).toEqual(['echo']);
  });

  test('refuses a foreign Host, which a DNS rebinding page would send', async () => {
    const response = await handle(
      new Request('http://evil.example:3000/mcp', { method: 'POST', body: '{}' }),
    );
    expect(response.status).toBe(403);
  });

  test.each([
    ['https://evil.example', 403],
    ['http://localhost:5173', 200],
    ['null', 200],
    ['app://desktop', 200],
  ])('answers Origin %s with %d', async (origin, status) => {
    const response = await handle(
      new Request('http://localhost:3000/mcp', {
        method: 'POST',
        headers: {
          origin,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 't', version: '1' },
          },
        }),
      }),
    );
    expect(response.status).toBe(status);
  });

  test('accepts any Host when no list is given', async () => {
    const c = await connect('http://evil.example:3000/mcp', mcpHandler(echoServer));
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(['echo']);
  });

  test('offers no SSE stream and serves nothing off the MCP path', async () => {
    const get = await handle(new Request('http://localhost:3000/mcp', { method: 'GET' }));
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    const other = await handle(new Request('http://localhost:3000/', { method: 'POST' }));
    expect(other.status).toBe(404);
  });
});

describe('allowedHostsFor', () => {
  test.each([
    ['127.0.0.1', '127.0.0.1'],
    ['localhost', 'localhost'],
    ['::1', '[::1]'],
    ['[::1]', '[::1]'],
    ['127.1', '127.0.0.1'],
    ['127.0.0.2', '127.0.0.2'],
    ['0:0:0:0:0:0:0:1', '[::1]'],
    ['::ffff:127.0.0.1', '[::ffff:7f00:1]'],
  ])('a loopback bind %s answers at %s and refuses a foreign Host', async (bind, name) => {
    const guarded = mcpHandler(echoServer, allowedHostsFor(bind));
    const { tools } = await (await connect(`http://${name}:3000/mcp`, guarded)).listTools();
    expect(tools.map((t) => t.name)).toEqual(['echo']);
    const foreign = await guarded(
      new Request('http://evil.example:3000/mcp', { method: 'POST', body: '{}' }),
    );
    expect(foreign.status).toBe(403);
  });

  test.each(['0.0.0.0', '::', '192.168.1.10', '127.evil.example', '127.0.0.1.nip.io'])(
    'leaves bind %s open',
    (host) => {
      expect(allowedHostsFor(host)).toEqual({});
    },
  );
});
