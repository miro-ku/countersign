// The demo path through the real server on 4100: a conversation with
// "Apps test agent" asks to post in #demo; the post is asked about,
// approved, executed, recorded and undone.
import assert from 'node:assert/strict';

const API = 'http://localhost:4100/api';
const AGENT = '6af897ced8fa56336013b154';
const TEXT = process.argv[2] ?? "post 'Refund for Acme approved' in #demo";

async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data: any = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, ms: number, fn: () => Promise<T | undefined | null | false>): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const show = (e: any) => `${e.seq} ${e.outcome.padEnd(8)} ${e.kind.padEnd(5)} ${e.action} conn=${e.connectionId ?? '-'} undoable=${e.undoable}`;

const conv = await call('POST', '/conversations', { agentId: AGENT });
const id = conv._id ?? conv.conversation?._id;
console.log('conversation', id);
await call('POST', `/conversations/${id}/messages`, { text: TEXT, source: 'text' });

const ask: any = await until('an open ask', 180_000, async () => {
  const s = await call('GET', `/conversations/${id}`);
  return (s.asks ?? []).find((a: any) => a.status === 'open');
});
console.log('ask:', ask.action, '|', ask.summary);
let state = await call('GET', `/conversations/${id}`);
for (const e of [...state.ledger].sort((a: any, b: any) => a.seq - b.seq)) console.log('  ', show(e));

await call('POST', `/asks/${ask._id}/answer`, { answer: 'approve', scope: 'once', source: 'button' });
const executed: any = await until('the executed post', 120_000, async () => {
  const s = await call('GET', `/conversations/${id}`);
  return s.ledger.find((e: any) => e.action === 'SLACK_SEND_MESSAGE' && (e.outcome === 'executed' || e.outcome === 'failed'));
});
assert.equal(executed.outcome, 'executed', JSON.stringify(executed.result));
const item = executed.result.results.find((r: any) => r.tool_slug === 'SLACK_SEND_MESSAGE');
console.log('posted:', item.channel, item.ts, JSON.stringify(item.arguments));

await until('the turn to end', 120_000, async () => {
  const s = await call('GET', `/conversations/${id}`);
  const last = [...s.messages].reverse().find((m: any) => m.role === 'agent');
  return last && !last.generating && last;
});
state = await call('GET', `/conversations/${id}`);
console.log('ledger:');
for (const e of [...state.ledger].sort((a: any, b: any) => a.seq - b.seq)) console.log('  ', show(e));
const reply = [...state.messages].reverse().find((m: any) => m.role === 'agent');
console.log('reply:', JSON.stringify(reply.text).slice(0, 300));

if (process.argv.includes('--no-undo')) process.exit(0);
const undone = await call('POST', `/ledger/${executed._id}/undo`);
console.log('undo:', JSON.stringify(undone).slice(0, 300));
console.log(JSON.stringify({ channel: item.channel, ts: item.ts }));
