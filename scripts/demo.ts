// Runs the demo's story through the API against an agent that has Slack
// connected, and prints what happened and how long each beat took.
//   pnpm exec tsx scripts/demo.ts <agentId>
// It posts to #demo and takes its own post back at the end.

const API = process.env.API_URL ?? 'http://localhost:4100';
const agentId = process.argv[2];
if (!agentId) {
  console.error('usage: tsx scripts/demo.ts <agentId>');
  process.exit(2);
}
const STEP_TIMEOUT_MS = 150_000;

type Doc = Record<string, any>;
type StreamEvent = { type: string } & Doc;

async function call(method: string, path: string, body?: unknown): Promise<any> {
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

/** One conversation with its live events. */
async function open(): Promise<{
  id: string;
  mark: () => number;
  waitFor: (what: string, from: number, match: (e: StreamEvent) => boolean) => Promise<StreamEvent>;
  since: (from: number) => StreamEvent[];
}> {
  const created = await call('POST', '/api/conversations', { agentId });
  const id = String((created.conversation ?? created)._id);
  const events: StreamEvent[] = [];
  const response = await fetch(`${API}/api/conversations/${id}/events`);
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
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
        const data = buffer
          .slice(0, end)
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');
        buffer = buffer.slice(end + 2);
        try {
          if (data) {
            events.push(JSON.parse(data));
          }
        } catch {
          // A keep-alive: nothing to record.
        }
      }
    }
  })();
  return {
    id,
    mark: () => events.length,
    since: (from) => events.slice(from),
    waitFor: async (what, from, match) => {
      const deadline = Date.now() + STEP_TIMEOUT_MS;
      for (;;) {
        const found = events.slice(from).find(match);
        if (found) {
          return found;
        }
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${what}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    },
  };
}

type Chat = Awaited<ReturnType<typeof open>>;
const part = (e: StreamEvent, key: string): Doc => e[key] ?? e;
const say = (chat: Chat, text: string) =>
  call('POST', `/api/conversations/${chat.id}/messages`, { text, source: 'text' });
const turnEnd = (chat: Chat, from: number) =>
  chat.waitFor('the turn to end', from, (e) => e.type === 'execution' && part(e, 'execution').status !== 'running');
const openAsk = (chat: Chat, from: number) =>
  chat.waitFor('an approval request', from, (e) => e.type === 'ask' && part(e, 'ask').status === 'open');
const ledgerRows = (chat: Chat, from: number) =>
  chat
    .since(from)
    .filter((e) => e.type === 'ledger')
    .map((e) => part(e, 'entry'))
    .map((entry) => `${entry.outcome} ${entry.action}${entry.ruleId ? ` [${entry.ruleId}]` : ''} (${entry.provider})`);
const lastReply = (chat: Chat, from: number) => {
  const replies = chat
    .since(from)
    .filter((e) => e.type === 'message')
    .map((e) => part(e, 'message'))
    .filter((m) => m.role === 'agent' && !m.generating && m.text);
  return replies.length ? String(replies[replies.length - 1].text) : '(no reply)';
};

let failed = false;
async function beat(name: string, run: () => Promise<string[]>): Promise<void> {
  const started = Date.now();
  try {
    const notes = await run();
    console.log(`\n${name}  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    for (const note of notes) {
      console.log(`  ${note}`);
    }
  } catch (error) {
    failed = true;
    console.log(`\n${name}  FAILED after ${((Date.now() - started) / 1000).toFixed(1)}s: ${(error as Error).message}`);
  }
}

const stamp = new Date().toISOString().slice(11, 19);
const REFUND = `Acme refund approved (${stamp})`;
const DISCOUNT = `Acme gets a 50% discount (${stamp})`;
const chat = await open();
let postEntry: Doc | null = null;

await beat('1. A post asks first, and goes out once approved', async () => {
  const from = chat.mark();
  await say(chat, `Post exactly this in #demo: "${REFUND}"`);
  const ask = part(await openAsk(chat, from), 'ask');
  const waited = `approval request: "${ask.summary}"`;
  await call('POST', `/api/asks/${ask._id}/answer`, { answer: 'approve', scope: 'once', source: 'button' });
  const done = await chat.waitFor('the post to run', from, (e) => {
    const entry = e.type === 'ledger' ? part(e, 'entry') : null;
    return entry !== null && entry.outcome === 'executed' && entry.kind === 'write';
  });
  postEntry = part(done, 'entry');
  await turnEnd(chat, from);
  return [waited, ...ledgerRows(chat, from), `agent: ${lastReply(chat, from).slice(0, 200)}`];
});

await beat('2. A card number is refused by a rule, and nobody is asked', async () => {
  const from = chat.mark();
  await say(chat, 'Post exactly this in #demo: "Card on file 4111 1111 1111 1111"');
  await turnEnd(chat, from);
  const rows = ledgerRows(chat, from);
  const asked = chat.since(from).some((e) => e.type === 'ask');
  if (!rows.some((row) => row.startsWith('denied') && row.includes('no-card-numbers'))) {
    throw new Error(`no denial by the rule in the ledger: ${JSON.stringify(rows)}; agent: ${lastReply(chat, from).slice(0, 200)}`);
  }
  return [asked ? 'AN APPROVAL WAS REQUESTED (it should not be)' : 'nobody was asked', ...rows, `agent: ${lastReply(chat, from).slice(0, 200)}`];
});

await beat('3. A rejection on Claude Code holds on Codex', async () => {
  let from = chat.mark();
  await say(chat, `Post exactly this in #demo: "${DISCOUNT}"`);
  const ask = part(await openAsk(chat, from), 'ask');
  await call('POST', `/api/asks/${ask._id}/answer`, { answer: 'decline', scope: 'conversation', source: 'button' });
  await turnEnd(chat, from);
  const first = [`rejected: "${ask.summary}"`, `agent: ${lastReply(chat, from).slice(0, 160)}`];
  await call('POST', `/api/conversations/${chat.id}/provider`, { provider: 'codex' });
  from = chat.mark();
  await say(chat, `Post exactly this in #demo: "${DISCOUNT}"`);
  await turnEnd(chat, from);
  const rows = ledgerRows(chat, from);
  const askedAgain = chat.since(from).some((e) => e.type === 'ask' && part(e, 'ask').status === 'open');
  if (askedAgain || !rows.some((row) => row.startsWith('denied') && row.includes('(codex)'))) {
    throw new Error(`Codex was not refused outright: asked again=${askedAgain}, ledger=${JSON.stringify(rows)}`);
  }
  return [...first, 'switched to Codex, same request:', ...rows, `agent: ${lastReply(chat, from).slice(0, 200)}`];
});

await beat('4. In a new chat, the agent explains the post from its record', async () => {
  const fresh = await open();
  const from = fresh.mark();
  await say(fresh, 'Why did you post the refund message in #demo?');
  await turnEnd(fresh, from);
  return [...ledgerRows(fresh, from), `agent: ${lastReply(fresh, from)}`];
});

await beat('5. The post is taken back', async () => {
  if (!postEntry) {
    throw new Error('there is no post to undo');
  }
  const from = chat.mark();
  await call('POST', `/api/ledger/${postEntry._id}/undo`);
  await chat.waitFor('the undo in the ledger', from, (e) => e.type === 'ledger' && part(e, 'entry').outcome === 'undone');
  return ledgerRows(chat, from);
});

console.log(failed ? '\nSome beats failed.' : '\nAll beats passed.');
process.exit(failed ? 1 : 0);
