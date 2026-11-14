// A tiny MCP server over streamable HTTP for the Codex checks.
// One tool, notes_add, logs its call and holds it for HOLD_MS before answering.
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export function startNotesServer(port: number, holdMs: number, log = console.log) {
  const build = () => {
    const server = new McpServer({ name: 'gateway', version: '0.0.1' });
    server.registerTool(
      'notes_add',
      { description: 'Add a note to the notes list.', inputSchema: { text: z.string() } },
      async ({ text }) => {
        const at = Date.now();
        log(`[mcp] notes_add called text=${JSON.stringify(text)}; holding ${holdMs}ms`);
        await new Promise((r) => setTimeout(r, holdMs));
        log(`[mcp] notes_add answering after ${Date.now() - at}ms`);
        return { content: [{ type: 'text', text: `Saved note: ${text}` }] };
      },
    );
    return server;
  };
  const httpServer = http.createServer(async (req, res) => {
    // Stateless: a fresh server and transport per request.
    const server = build();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => transport.handleRequest(req, res, body ? JSON.parse(body) : undefined));
  });
  return new Promise<http.Server>((ok) => httpServer.listen(port, '127.0.0.1', () => ok(httpServer)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 4199);
  await startNotesServer(port, Number(process.env.HOLD_MS ?? 60000));
  console.log(`notes MCP server on http://127.0.0.1:${port}/mcp`);
}
