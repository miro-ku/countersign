// A Slack read through the real gateway: it should run without an ask.
const API = 'http://localhost:4100/api';
const AGENT = '6af897ced8fa56336013b154';
async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json() as Promise<any>;
}
const conv = await call('POST', '/conversations', { agentId: AGENT });
await call('POST', `/conversations/${conv._id}/messages`, { text: 'Which Slack channels are there? Just list them.', source: 'text' });
const end = Date.now() + 240_000;
let s: any;
while (Date.now() < end) {
  await new Promise((r) => setTimeout(r, 2000));
  s = await call('GET', `/conversations/${conv._id}`);
  const last = [...s.messages].reverse().find((m: any) => m.role === 'agent');
  if (last && !last.generating) break;
}
for (const e of [...s.ledger].sort((a: any, b: any) => a.seq - b.seq)) console.log(e.seq, e.outcome, e.kind, e.action, 'conn=' + (e.connectionId ?? '-'));
console.log('open asks:', s.asks.filter((a: any) => a.status === 'open').length);
console.log('reply:', JSON.stringify([...s.messages].reverse().find((m: any) => m.role === 'agent')?.text).slice(0, 300));
