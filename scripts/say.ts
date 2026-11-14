// Says one thing to an agent and prints what happened: every ledger entry,
// every approval request, and the reply.
//   pnpm exec tsx scripts/say.ts <agentId> "<message>" [--in <conversationId>] [--approve | --decline] [--on codex|claude-code]
// Without --approve or --decline an approval request is left open and the script ends.

const API = process.env.API_URL ?? 'http://localhost:4100';
const [agentId, text, ...flags] = process.argv.slice(2);
if (!agentId || !text) {
  console.error('usage: tsx scripts/say.ts <agentId> "<message>" [--in <conversationId>] [--approve|--decline] [--on <provider>]');
  process.exit(2);
}
const flag = (name: string) => (flags.includes(name) ? (flags[flags.indexOf(name) + 1] ?? '') : null);
const answer = flags.includes('--approve') ? 'approve' : flags.includes('--decline') ? 'decline' : null;

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(API + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const out = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${out.slice(0, 300)}`);
  return out ? JSON.parse(out) : {};
}

let conversationId = flag('--in');
if (!conversationId) {
  const created = await call('POST', '/api/conversations', { agentId });
  conversationId = String((created.conversation ?? created)._id);
}
const provider = flag('--on');
if (provider) await call('POST', `/api/conversations/${conversationId}/provider`, { provider });
console.log(`conversation ${conversationId}`);

const started = Date.now();
const secs = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
const response = await fetch(`${API}/api/conversations/${conversationId}/events`);
const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
await call('POST', `/api/conversations/${conversationId}/messages`, { text, source: 'text' });

let buffer = '';
let reply = '';
const deadline = setTimeout(() => { console.log('timed out after 4 minutes'); process.exit(1); }, 240_000);
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += value;
  let end: number;
  while ((end = buffer.indexOf('\n\n')) >= 0) {
    const data = buffer.slice(0, end).split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
    buffer = buffer.slice(end + 2);
    if (!data) continue;
    let event: any;
    try { event = JSON.parse(data); } catch { continue; }
    if (event.type === 'ledger') {
      const e = event.entry ?? event;
      console.log(`${secs()}  ${e.outcome.padEnd(8)} ${e.summary ?? e.action}${e.ruleId ? `  [${e.ruleId}]` : ''}  (${e.provider})  ${e.outcome === 'asked' || e.outcome === 'denied' ? JSON.stringify(e.args).slice(0, 160) : ''}`);
    } else if (event.type === 'ask') {
      const a = event.ask ?? event;
      if (a.status !== 'open') continue;
      console.log(`${secs()}  ASK      ${a.summary}`);
      if (!answer) { console.log('left open'); process.exit(0); }
      await call('POST', `/api/asks/${a._id}/answer`, { answer, scope: answer === 'decline' ? 'conversation' : 'once', source: 'button' });
    } else if (event.type === 'message') {
      const m = event.message ?? event;
      if (m.role === 'agent' && !m.generating && m.text) reply = m.text;
    } else if (event.type === 'execution') {
      const x = event.execution ?? event;
      if (x.status !== 'running') {
        // The final reply is written just after the turn ends.
        await new Promise((r) => setTimeout(r, 800));
        const snap = await call('GET', `/api/conversations/${conversationId}`);
        const last = [...snap.messages].reverse().find((m: any) => m.role === 'agent' && m.text);
        console.log(`${secs()}  turn ${x.status}\n\n${last?.text ?? reply}`);
        clearTimeout(deadline);
        process.exit(0);
      }
    }
  }
}
