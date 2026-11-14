import { serve } from '@hono/node-server';
import { warmJudge } from './assist.js';
import { Hono } from 'hono';
import { client, col, db } from './db.js';
import { startChangeStreams, stopChangeStreams } from './changes.js';
import { closeAllSessions, closeOpenTools, registerDriver } from './engine.js';
import type { Step } from '../shared/types.js';
import { registerGateway } from './gateway/index.js';
import { createApi } from './api.js';
import { claudeCodeDriver } from './providers/claudeCode.js';
import { codexDriver } from './providers/codex/index.js';
import { startSearchWorker } from './search/index.js';

const PORT = Number(process.env.PORT || 4100);

registerDriver(claudeCodeDriver);
registerDriver(codexDriver);
// A second Claude Code under another name, to prove a switch before Codex exists.
if (process.env.TEST_PROVIDER) registerDriver(claudeCodeDriver, process.env.TEST_PROVIDER);

await client.connect();
startChangeStreams();
startSearchWorker(db);

// Turns cut off by a restart: nothing is behind them any more, so close them.
const endedAt = new Date();
const cut = await col.executions.updateMany(
  { status: 'running' },
  { $set: { status: 'failed', endedAt, error: 'the server restarted' } },
);
for (const reply of await col.messages.find({ generating: true }).toArray()) {
  await col.messages.updateOne(
    { _id: reply._id },
    { $set: { generating: false, steps: closeOpenTools(reply.steps as Step[], 'the server restarted') } },
  );
}
if (cut.modifiedCount) console.log(`closed ${cut.modifiedCount} turn(s) cut off by a restart`);

const app = new Hono();
app.get('/health', (c) => c.json({ ok: true }));
app.route('/api', createApi());
registerGateway(app);

const server = serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, () => {
  console.log(`server on http://localhost:${PORT}`);
  // The judge is started ahead of time when some agent has a rule it reads.
  void col.rules.findOne({ judged: true } as any).then((rule) => { if (rule) warmJudge(); }).catch(() => {});
  if (!process.env.COMPOSIO_API_KEY) console.log('COMPOSIO_API_KEY is not set: app connections are off.');
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopChangeStreams();
  // Every provider process goes with the server; don't wait long for them.
  await Promise.race([closeAllSessions(), new Promise((r) => setTimeout(r, 2000))]);
  server.close();
  await client.close().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
