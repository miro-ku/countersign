// Asks an agent questions about its own past in a new conversation, against the
// running server, and prints the answers and the record look-ups it made.
//   pnpm exec tsx server/search/ask.ts <agentId> <claude-code|codex> "question" ["question" ...]
const API = process.env.API_URL ?? 'http://localhost:4100';
const [agentId, provider, ...questions] = process.argv.slice(2);

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(API + path, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : {};
}

const conversation = await call('POST', '/api/conversations', { agentId });
if (conversation.provider !== provider) await call('POST', `/api/conversations/${conversation._id}/provider`, { provider });
console.log(`conversation ${conversation._id} on ${provider}`);
for (const q of questions) {
  const sent = await call('POST', `/api/conversations/${conversation._id}/messages`, { text: q });
  const deadline = Date.now() + 240_000;
  let reply: any = null;
  while (Date.now() < deadline && !reply) {
    await new Promise((r) => setTimeout(r, 2000));
    const snap = await call('GET', `/api/conversations/${conversation._id}`);
    reply = snap.messages.find((m: any) => m.role === 'agent' && m.seq > sent.seq && !m.generating && m.text);
  }
  const snap = await call('GET', `/api/conversations/${conversation._id}`);
  console.log(`\n### Q: ${q}\nA: ${reply?.text ?? '(no reply in time)'}`);
  for (const e of [...snap.ledger].reverse()) {
    if (e.outcome === 'executed') console.log(`  ledger #${e.seq} ${e.action} ${e.outcome} ${JSON.stringify(e.args)}`);
  }
}
