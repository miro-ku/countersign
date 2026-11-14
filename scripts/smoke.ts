// End-to-end check of the governed path, against a running server.
//   npx tsx scripts/smoke.ts            the path on the agent's default provider
//   npx tsx scripts/smoke.ts --switch   also: a rejection holds after a provider switch
// Exits non-zero on the first step that fails.

const API = process.env.API_URL ?? 'http://localhost:4100';
const withSwitch = process.argv.includes('--switch');
const STEP_TIMEOUT_MS = 120_000;

type Doc = Record<string, any>;
type StreamEvent = { type: string } & Doc;

const events: StreamEvent[] = [];
const waiters = new Set<() => void>();

async function call(method: string, path: string, body?: unknown): Promise<Doc> {
  const response = await fetch(API + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : {};
}

async function listen(conversationId: string): Promise<void> {
  const response = await fetch(`${API}/api/conversations/${conversationId}/events`, {
    headers: { accept: 'text/event-stream' },
  });
  if (!response.ok || !response.body) {
    throw new Error(`event stream -> ${response.status}`);
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        return;
      }
      buffer += value;
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');
        if (!data) {
          continue;
        }
        try {
          events.push(JSON.parse(data));
          for (const wake of waiters) {
            wake();
          }
        } catch {
          // A keep-alive or a partial line: nothing to record.
        }
      }
    }
  })();
}

/** Waits for an event received after `from` that matches. */
async function waitFor(
  what: string,
  from: number,
  match: (event: StreamEvent) => boolean,
): Promise<StreamEvent> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  for (;;) {
    const found = events.slice(from).find(match);
    if (found) {
      return found;
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise<void>((resolve) => {
      const wake = () => {
        waiters.delete(wake);
        resolve();
      };
      waiters.add(wake);
      setTimeout(wake, Math.min(left, 1000));
    });
  }
}

const id = (doc: Doc): string => String(doc._id ?? doc.id);
const unwrap = (doc: Doc, key: string): Doc => doc[key] ?? doc;
const turnEnded = (from: number) =>
  waitFor('the turn to end', from, (e) => {
    const execution = e.type === 'execution' ? unwrap(e, 'execution') : null;
    return execution !== null && execution.status !== 'running';
  });
const ledger = (from: number, action: string, outcome: string) =>
  waitFor(`ledger ${action} ${outcome}`, from, (e) => {
    const entry = e.type === 'ledger' ? unwrap(e, 'entry') : null;
    return entry !== null && entry.action === action && entry.outcome === outcome;
  });
const openAsk = (from: number) =>
  waitFor('an open ask', from, (e) => e.type === 'ask' && unwrap(e, 'ask').status === 'open');

let step = 0;
async function check(name: string, run: () => Promise<void>): Promise<void> {
  step += 1;
  const started = Date.now();
  try {
    await run();
    console.log(`PASS ${step}. ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (error) {
    console.log(`FAIL ${step}. ${name}: ${(error as Error).message}`);
    process.exit(1);
  }
}

const tag = Math.random().toString(36).slice(2, 8);
let agent: Doc = {};
let conversation: Doc = {};

await check('create an agent', async () => {
  agent = unwrap(
    await call('POST', '/api/agents', {
      name: `Smoke ${tag}`,
      instructions:
        'You keep notes. Use the notes tools when asked. When a tool call is refused, say so in one sentence and stop.',
      defaultProvider: 'claude-code',
    }),
    'agent',
  );
  if (!id(agent) || agent.version !== 1) {
    throw new Error(`unexpected agent: ${JSON.stringify(agent).slice(0, 200)}`);
  }
});

await check('start a conversation and its event stream', async () => {
  conversation = unwrap(
    await call('POST', '/api/conversations', { agentId: id(agent) }),
    'conversation',
  );
  await listen(id(conversation));
});

const say = (text: string) =>
  call('POST', `/api/conversations/${id(conversation)}/messages`, { text, source: 'text' });
const answer = (ask: Doc, verdict: 'approve' | 'decline', scope: 'once' | 'conversation') =>
  call('POST', `/api/asks/${id(ask)}/answer`, { answer: verdict, scope, source: 'button' });

await check('a write asks first, and runs once approved', async () => {
  const from = events.length;
  await say(`Add a note with exactly this text: hello-${tag}`);
  const ask = unwrap(await openAsk(from), 'ask');
  if (!ask.summary || !ask.fingerprint) {
    throw new Error('the ask has no summary or fingerprint');
  }
  await answer(ask, 'approve', 'once');
  await ledger(from, 'notes_add', 'executed');
  await turnEnded(from);
});

await check('a read runs without asking', async () => {
  const from = events.length;
  await say('List the notes.');
  await ledger(from, 'notes_list', 'executed');
  await turnEnded(from);
  if (events.slice(from).some((e) => e.type === 'ask')) {
    throw new Error('a read raised an ask');
  }
});

await check('a rejection is recorded', async () => {
  const from = events.length;
  await say(`Add a note with exactly this text: forbidden-${tag}`);
  await answer(unwrap(await openAsk(from), 'ask'), 'decline', 'conversation');
  await turnEnded(from);
});

await check('the same action is refused later without asking', async () => {
  const from = events.length;
  await say(`Try once more to add a note with exactly this text: forbidden-${tag}`);
  await ledger(from, 'notes_add', 'denied');
  await turnEnded(from);
  if (events.slice(from).some((e) => e.type === 'ask' && unwrap(e, 'ask').status === 'open')) {
    throw new Error('it asked again');
  }
});

if (withSwitch) {
  await check('the rejection holds on the other provider', async () => {
    await call('POST', `/api/conversations/${id(conversation)}/provider`, { provider: 'codex' });
    const from = events.length;
    await say(`Add a note with exactly this text: forbidden-${tag}`);
    const entry = unwrap(await ledger(from, 'notes_add', 'denied'), 'entry');
    if (entry.provider !== 'codex') {
      throw new Error(`the entry was written by ${entry.provider}`);
    }
    await turnEnded(from);
  });
}

console.log('All steps passed.');
process.exit(0);
