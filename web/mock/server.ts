// A stand-in for the API on port 4100, for building the page while the real
// server is not up. In memory, no dependencies. `npm --prefix web run mock`.
//
// Sending any message plays a scripted turn: a streaming reply that reads the
// notes, asks to add one, waits for the answer, then finishes. A conversation
// whose stream opens while it is empty plays the whole demo by itself
// (message, reply, ask, a spoken approval, a provider switch) unless
// MOCK_AUTOPLAY=0.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

type Doc = Record<string, any> & { _id: string };
type Provider = 'claude-code' | 'codex';

const db = {
  agents: new Map<string, Doc>(),
  conversations: new Map<string, Doc>(),
  messages: new Map<string, Doc>(),
  asks: new Map<string, Doc>(),
  ledger: new Map<string, Doc>(),
  executions: new Map<string, Doc>(),
  connections: new Map<string, Doc>(),
};
const streams = new Map<string, Set<ServerResponse>>();
const waiting = new Map<string, (ask: Doc) => void>();
let ledgerSeq = 0;

const now = () => new Date().toISOString();
const id = () => randomUUID().replace(/-/g, '').slice(0, 24);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function emit(conversationId: string, event: Record<string, unknown>) {
  for (const res of streams.get(conversationId) ?? []) res.write(`data: ${JSON.stringify(event)}\n\n`);
}
function put(kind: 'message' | 'ask' | 'execution' | 'conversation', d: Doc) {
  const table = { message: db.messages, ask: db.asks, execution: db.executions, conversation: db.conversations }[kind];
  table.set(d._id, d);
  emit(kind === 'conversation' ? d._id : d.conversationId, { type: kind, [kind]: d });
}
function ledger(conv: Doc, e: Partial<Doc>) {
  const agent = db.agents.get(conv.agentId)!;
  const entry: Doc = {
    _id: id(), seq: ++ledgerSeq, at: now(), ownerId: 'miro', agentId: conv.agentId, agentVersion: agent.version,
    conversationId: conv._id, provider: conv.provider, model: conv.provider === 'codex' ? 'gpt-5-codex' : 'claude-opus',
    kind: 'read', args: {}, fingerprint: 'fp', undoable: false, ...e,
  };
  db.ledger.set(entry._id, entry);
  emit(conv._id, { type: 'ledger', entry });
  return entry;
}
function nextSeq(conversationId: string) {
  return 1 + Math.max(0, ...[...db.messages.values()].filter((m) => m.conversationId === conversationId).map((m) => m.seq));
}
function addMessage(conv: Doc, m: Partial<Doc>) {
  const msg: Doc = { _id: id(), conversationId: conv._id, seq: nextSeq(conv._id), generating: false, steps: [], at: now(), text: '', ...m };
  put('message', msg);
  return msg;
}

const running = new Map<string, { stop: boolean }>();

async function playTurn(conv: Doc, userText: string) {
  if (running.has(conv._id)) return;
  const flag = { stop: false };
  running.set(conv._id, flag);
  const p: Provider = conv.provider;
  const exec: Doc = { _id: id(), conversationId: conv._id, provider: p, model: 'mock', status: 'running', startedAt: now() };
  put('execution', exec);
  const reply = addMessage(conv, { role: 'agent', provider: p, model: 'mock', executionId: exec._id, generating: true });
  const update = () => put('message', { ...reply });

  const say = async (text: string) => {
    reply.steps.push({ text: '' });
    const step = reply.steps[reply.steps.length - 1];
    for (const word of text.split(/(?<= )/)) {
      if (flag.stop) return;
      step.text += word;
      reply.text += word;
      update();
      await sleep(60);
    }
  };
  const tool = (name: string, input: unknown) => {
    const ref = id();
    reply.steps.push({ toolRequest: { ref, name, input } });
    update();
    return (output: unknown, isError = false) => {
      reply.steps.push({ toolResponse: { ref, name, output, isError } });
      update();
    };
  };

  await say(`Got it: "${userText.slice(0, 60)}". Let me look at your notes first. `);
  const done1 = tool('mcp__gateway__notes_list', {});
  await sleep(600);
  ledger(conv, { action: 'notes_list', kind: 'read', outcome: 'allowed', ruleId: 'default-read-allow', decidedBy: 'rule' });
  ledger(conv, { action: 'notes_list', kind: 'read', outcome: 'executed', result: { notes: ['Call Anna about the launch'] } });
  done1({ notes: ['Call Anna about the launch'] });
  await say('You have one note. I will add a reminder for tomorrow. ');

  const args = { text: 'Follow up with Anna on Friday' };
  const done2 = tool('mcp__gateway__notes_add', args);
  const ask: Doc = {
    _id: id(), conversationId: conv._id, agentId: conv.agentId, executionId: exec._id, fingerprint: 'notes_add:ab12',
    action: 'notes_add', args, summary: 'Add the note "Follow up with Anna on Friday"', status: 'open',
    askedByProvider: p, createdAt: now(),
  };
  put('ask', ask);
  ledger(conv, { action: 'notes_add', kind: 'write', args, outcome: 'asked', ruleId: 'default-write-ask' });
  const answered = await new Promise<Doc>((resolve) => waiting.set(ask._id, resolve));
  waiting.delete(ask._id);

  if (answered.status === 'approved') {
    await sleep(400);
    const entry = ledger(conv, { action: 'notes_add', kind: 'write', args, outcome: 'executed', undoable: true, result: { ok: true } });
    done2({ ok: true, noteId: entry._id });
    await say('Done: the note is saved. You can undo it from the ledger.');
  } else if (answered.status === 'declined') {
    done2('They were asked and said no', true);
    await say('Understood, I will not add it.');
  } else {
    done2('Stopped', true);
  }
  reply.generating = false;
  update();
  exec.status = flag.stop ? 'stopped' : 'completed';
  exec.endedAt = now();
  put('execution', exec);
  running.delete(conv._id);
}

function answerAsk(askId: string, body: any) {
  const ask = db.asks.get(askId);
  if (!ask || ask.status !== 'open') return null;
  ask.status = body.answer === 'approve' ? 'approved' : 'declined';
  ask.answer = { by: 'miro', source: body.source ?? 'button', scope: body.scope ?? 'conversation', transcript: body.transcript, verdict: body.verdict, at: now() };
  put('ask', ask);
  const conv = db.conversations.get(ask.conversationId)!;
  ledger(conv, {
    action: ask.action, kind: 'write', args: ask.args, outcome: ask.status, decidedBy: 'miro',
    result: body.source === 'voice' ? { transcript: body.transcript } : undefined,
  });
  waiting.get(askId)?.(ask);
  return ask;
}

function switchProvider(conv: Doc, provider: Provider) {
  if (conv.provider === provider) return;
  conv.provider = provider;
  put('conversation', conv);
  addMessage(conv, { role: 'event', text: `Switched to ${provider === 'codex' ? 'Codex' : 'Claude Code'}` });
}

async function autoplay(conv: Doc) {
  await sleep(1200);
  addMessage(conv, { role: 'user', text: 'Check my notes and remind me to follow up with Anna.', source: 'voice' });
  const turn = playTurn(conv, 'Check my notes and remind me to follow up with Anna.');
  await sleep(6000);
  const open = [...db.asks.values()].find((a) => a.conversationId === conv._id && a.status === 'open');
  if (open) answerAsk(open._id, { answer: 'approve', scope: 'conversation', source: 'voice', transcript: 'yes go ahead', verdict: 'yes' });
  await turn;
  await sleep(1500);
  switchProvider(conv, 'codex');
}

// ── HTTP ─────────────────────────────────────────────────────────

async function body(req: IncomingMessage): Promise<any> {
  let s = '';
  for await (const c of req) s += c;
  return s ? JSON.parse(s) : {};
}
function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const [, a, b, c] = parts;
  const m = req.method;
  try {
    if (parts[0] !== 'api') return json(res, 404, { error: 'not found' });

    if (a === 'agents' && !b && m === 'GET') return json(res, 200, [...db.agents.values()]);
    if (a === 'agents' && !b && m === 'POST') {
      const x = await body(req);
      const agent = { _id: id(), ownerId: 'miro', name: x.name, instructions: x.instructions ?? '', version: 1, defaultProvider: x.defaultProvider ?? 'claude-code', createdAt: now() };
      db.agents.set(agent._id, agent);
      return json(res, 201, agent);
    }
    if (a === 'agents' && b && !c && m === 'GET') return json(res, 200, db.agents.get(b) ?? null);
    if (a === 'agents' && b && c === 'connections' && m === 'GET')
      return json(res, 200, [...db.connections.values()].filter((x) => x.agentId === b));
    if (a === 'agents' && b && c === 'connections' && m === 'POST') {
      const { toolkit } = await body(req);
      const conn = { _id: id(), agentId: b, ownerId: 'miro', toolkit, status: 'active', connectedAt: now() };
      db.connections.set(conn._id, conn);
      // A real flow goes through the provider's consent page; here we come straight back.
      return json(res, 200, { redirectUrl: `http://localhost:5173/?connected=${toolkit}` });
    }
    if (a === 'connections' && b && m === 'DELETE') {
      const conn = db.connections.get(b);
      if (conn) {
        conn.status = 'revoked'; conn.revokedAt = now();
        for (const conv of db.conversations.values())
          if (conv.agentId === conn.agentId) emit(conv._id, { type: 'connection', connection: conn });
      }
      return json(res, 200, { ok: true });
    }

    if (a === 'conversations' && !b && m === 'GET') {
      const agentId = url.searchParams.get('agentId');
      return json(res, 200, [...db.conversations.values()].filter((x) => !agentId || x.agentId === agentId).reverse());
    }
    if (a === 'conversations' && !b && m === 'POST') {
      const { agentId } = await body(req);
      const agent = db.agents.get(agentId);
      if (!agent) return json(res, 404, { error: 'no such agent' });
      const conv = { _id: id(), agentId, ownerId: 'miro', provider: agent.defaultProvider, providerSessions: {}, stoppedNote: false, createdAt: now() };
      db.conversations.set(conv._id, conv);
      return json(res, 201, conv);
    }
    const conv = a === 'conversations' && b ? db.conversations.get(b) : undefined;
    if (a === 'conversations' && b && !conv) return json(res, 404, { error: 'no such conversation' });
    if (conv && !c && m === 'GET') {
      const mine = <T extends Doc>(t: Map<string, T>) => [...t.values()].filter((d) => d.conversationId === conv._id);
      return json(res, 200, {
        conversation: conv,
        messages: mine(db.messages).sort((x, y) => x.seq - y.seq),
        asks: mine(db.asks).filter((x) => x.status === 'open'),
        ledger: mine(db.ledger).sort((x, y) => y.seq - x.seq).slice(0, 100),
      });
    }
    if (conv && c === 'messages' && m === 'POST') {
      const { text, source } = await body(req);
      for (const ask of db.asks.values())
        if (ask.conversationId === conv._id && ask.status === 'open') {
          ask.status = 'replied'; put('ask', ask); waiting.get(ask._id)?.(ask);
        }
      addMessage(conv, { role: 'user', text, source: source ?? 'text' });
      setTimeout(() => playTurn(conv, text), 300);
      return json(res, 202, { ok: true });
    }
    if (conv && c === 'provider' && m === 'POST') {
      const { provider } = await body(req);
      switchProvider(conv, provider);
      return json(res, 200, conv);
    }
    if (conv && c === 'stop' && m === 'POST') {
      const flag = running.get(conv._id);
      if (flag) flag.stop = true;
      for (const ask of db.asks.values())
        if (ask.conversationId === conv._id && ask.status === 'open') {
          ask.status = 'stopped'; put('ask', ask); waiting.get(ask._id)?.(ask);
        }
      return json(res, 200, { ok: true });
    }
    if (conv && c === 'events' && m === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': hello\n\n');
      const set = streams.get(conv._id) ?? new Set();
      streams.set(conv._id, set);
      set.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => { clearInterval(ping); set.delete(res); });
      const empty = ![...db.messages.values()].some((x) => x.conversationId === conv._id);
      if (empty && process.env.MOCK_AUTOPLAY !== '0' && !conv.autoplayed) { conv.autoplayed = true; autoplay(conv); }
      return;
    }

    if (a === 'asks' && b && c === 'answer' && m === 'POST') {
      const ask = answerAsk(b, await body(req));
      return ask ? json(res, 200, ask) : json(res, 409, { error: 'already answered' });
    }
    if (a === 'ledger' && b && c === 'undo' && m === 'POST') {
      const entry = db.ledger.get(b);
      if (!entry?.undoable) return json(res, 400, { error: 'not undoable' });
      const conv2 = db.conversations.get(entry.conversationId)!;
      ledger(conv2, { action: entry.action, kind: entry.kind, args: entry.args, outcome: 'undone', undoOf: entry._id, decidedBy: 'miro' });
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: String(e) });
  }
}).listen(4100, () => console.log('mock API on http://localhost:4100'));
