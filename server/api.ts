import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { col, db, newId, OWNER_ID } from './db.js';
import { changes, conversationOf, type ChangeKind } from './changes.js';
import { knownProviders, postMessage, stopTurn, switchProvider } from './engine.js';
import { answerAsk, undoLedgerEntry } from './gateway/index.js';
import { rulesFor } from './gateway/rules.js';
import { registerConnectionRoutes } from './integrations/index.js';
import { registerSearchRoutes } from './search/index.js';

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

export function createApi(): Hono {
  const api = new Hono();

  api.onError((err, c) => {
    console.error(err);
    return c.json({ error: err.message }, 500);
  });

  // ── Agents ──
  api.post('/agents', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const name = String(body.name ?? '').trim();
    const instructions = String(body.instructions ?? '');
    const defaultProvider = body.defaultProvider ?? 'claude-code';
    if (!name) return c.json({ error: 'name is required' }, 400);
    if (!['claude-code', 'codex'].includes(defaultProvider)) return c.json({ error: 'unknown provider' }, 400);
    const agent = {
      _id: newId(), ownerId: OWNER_ID, name, instructions, instructionsHash: hash(instructions),
      version: 1, defaultProvider, testTools: body.testTools === true, createdAt: new Date(),
    };
    await col.agents.insertOne(agent);
    return c.json(agent, 201);
  });

  api.get('/agents', async (c) => c.json(await col.agents.find({ ownerId: OWNER_ID }).sort({ createdAt: -1 }).toArray()));

  api.get('/agents/:id', async (c) => {
    const agent = await col.agents.findOne({ _id: c.req.param('id') });
    return agent ? c.json(agent) : c.json({ error: 'not found' }, 404);
  });

  api.patch('/agents/:id', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const agent = await col.agents.findOne({ _id: c.req.param('id') });
    if (!agent) return c.json({ error: 'not found' }, 404);
    const set: Record<string, unknown> = {};
    if (typeof body.name === 'string' && body.name.trim()) set.name = body.name.trim();
    if (body.defaultProvider && ['claude-code', 'codex'].includes(body.defaultProvider)) set.defaultProvider = body.defaultProvider;
    const update: Record<string, unknown> = { $set: set };
    if (typeof body.instructions === 'string' && body.instructions !== agent.instructions) {
      set.instructions = body.instructions;
      set.instructionsHash = hash(body.instructions);
      update.$inc = { version: 1 };
    }
    if (!Object.keys(set).length) return c.json(agent);
    return c.json(await col.agents.findOneAndUpdate({ _id: agent._id }, update, { returnDocument: 'after' }));
  });

  // ── Conversations ──
  api.post('/conversations', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const agent = await col.agents.findOne({ _id: String(body.agentId ?? '') });
    if (!agent) return c.json({ error: 'agent not found' }, 404);
    const conversation = {
      _id: newId(), agentId: agent._id, ownerId: OWNER_ID, provider: agent.defaultProvider,
      providerSessions: {}, stoppedNote: false, createdAt: new Date(),
    };
    await col.conversations.insertOne(conversation);
    return c.json(conversation, 201);
  });

  api.get('/conversations', async (c) => {
    const filter: Record<string, unknown> = { ownerId: OWNER_ID };
    if (c.req.query('agentId')) filter.agentId = c.req.query('agentId');
    return c.json(await col.conversations.find(filter).sort({ createdAt: -1 }).limit(50).toArray());
  });

  api.get('/conversations/:id', async (c) => {
    const id = c.req.param('id');
    const conversation = await col.conversations.findOne({ _id: id });
    if (!conversation) return c.json({ error: 'not found' }, 404);
    const [messages, asks, ledger] = await Promise.all([
      col.messages.find({ conversationId: id }).sort({ seq: 1 }).toArray(),
      col.asks.find({ conversationId: id }).sort({ createdAt: 1 }).toArray(),
      col.ledger.find({ conversationId: id }).sort({ seq: -1 }).limit(100).toArray(),
    ]);
    return c.json({ conversation, messages, asks, ledger });
  });

  api.post('/conversations/:id/messages', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const text = String(body.text ?? '').trim();
    if (!text) return c.json({ error: 'text is required' }, 400);
    if (!(await col.conversations.findOne({ _id: id }))) return c.json({ error: 'not found' }, 404);
    const message = await postMessage(id, text, body.source === 'voice' ? 'voice' : 'text');
    return c.json(message, 202);
  });

  api.post('/conversations/:id/provider', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const provider = String(body.provider ?? '');
    if (!knownProviders().includes(provider)) return c.json({ error: `unknown provider; one of ${knownProviders().join(', ')}` }, 400);
    const conversation = await switchProvider(c.req.param('id'), provider);
    return conversation ? c.json(conversation) : c.json({ error: 'not found' }, 404);
  });

  api.post('/conversations/:id/stop', async (c) => c.json(await stopTurn(c.req.param('id'))));

  // ── Asks and ledger ──
  api.post('/asks/:id/answer', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const result = await answerAsk(c.req.param('id'), body);
    return result.ok ? c.json(result.ask) : c.json({ error: result.error }, result.status as 400);
  });

  api.post('/ledger/:id/undo', async (c) => {
    const result = await undoLedgerEntry(c.req.param('id'));
    return result.ok ? c.json(result.entry) : c.json({ error: result.error }, result.status as 400);
  });

  // ── Rules (read-only today) ──
  // With ?agentId=, the rules that apply to that agent, in the order they are applied.
  api.get('/rules', async (c) => {
    const agentId = c.req.query('agentId');
    return c.json(agentId ? await rulesFor(agentId) : await col.rules.find({}).toArray());
  });

  // ── Event stream ──
  api.get('/conversations/:id/events', async (c) => {
    const id = c.req.param('id');
    const conversation = await col.conversations.findOne({ _id: id });
    if (!conversation) return c.json({ error: 'not found' }, 404);
    return streamSSE(c, async (stream) => {
      const queue: string[] = [];
      let wake: (() => void) | null = null;
      const onChange = ({ kind, doc }: { kind: ChangeKind; doc: any }) => {
        const belongs = kind === 'connection' ? doc.agentId === conversation.agentId : conversationOf(kind, doc) === id;
        if (!belongs) return;
        const key = kind === 'ledger' ? 'entry' : kind;
        queue.push(JSON.stringify({ type: kind, [key]: doc }));
        wake?.();
      };
      changes.on('change', onChange);
      let open = true;
      stream.onAbort(() => {
        open = false;
        wake?.();
      });
      await stream.writeSSE({ event: 'ready', data: JSON.stringify({ type: 'ready', conversationId: id }) });
      const ping = setInterval(() => void stream.writeSSE({ event: 'ping', data: '{}' }).catch(() => {}), 15000);
      try {
        while (open) {
          while (queue.length) await stream.writeSSE({ data: queue.shift()! });
          await new Promise<void>((r) => (wake = r));
          wake = null;
        }
      } finally {
        clearInterval(ping);
        changes.off('change', onChange);
      }
    });
  });

  registerConnectionRoutes(api, db);
  registerSearchRoutes(api, db);
  return api;
}
