import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { client, col } from './db.js';
import { startChangeStreams, stopChangeStreams } from './changes.js';
import { closeAllSessions, registerDriver } from './engine.js';
import { registerGateway } from './gateway/index.js';
import { createApi } from './api.js';
import { claudeCodeDriver } from './providers/claudeCode.js';
import { codexDriver } from './providers/codex/index.js';

const PORT = Number(process.env.PORT || 4100);

registerDriver(claudeCodeDriver);
registerDriver(codexDriver);
// A second Claude Code under another name, to prove a switch before Codex exists.
if (process.env.TEST_PROVIDER) registerDriver(claudeCodeDriver, process.env.TEST_PROVIDER);

await client.connect();
startChangeStreams();

// Turns cut off by a restart: their sessions are gone, so close them.
const endedAt = new Date();
const cut = await col.executions.updateMany(
  { status: 'running' },
  { $set: { status: 'failed', endedAt, error: 'The server restarted during this turn.' } },
);
await col.messages.updateMany({ generating: true }, { $set: { generating: false } });
if (cut.modifiedCount) console.log(`closed ${cut.modifiedCount} turn(s) cut off by a restart`);

const app = new Hono();
app.get('/health', (c) => c.json({ ok: true }));
app.route('/api', createApi());
registerGateway(app);

const server = serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, () => {
  console.log(`server on http://localhost:${PORT}`);
  if (!process.env.COMPOSIO_API_KEY) console.log('COMPOSIO_API_KEY is not set: app connections are off.');
});

async function shutdown() {
  stopChangeStreams();
  await closeAllSessions();
  server.close();
  await client.close().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
