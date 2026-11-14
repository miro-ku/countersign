// A normal agent (no test tools, no apps) asked what it can do, on one provider.
// Usage: pnpm exec tsx spikes/blank.mts [claude-code|codex]
const API = process.env.API_URL ?? 'http://localhost:4100/api';
const provider = process.argv[2] ?? 'claude-code';
const post = (path: string, body: unknown) =>
  fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const get = (path: string) => fetch(API + path).then((r) => r.json());

const agent = await post('/agents', { name: `Blank ${provider}`, instructions: 'You are a helpful assistant for Miro.', defaultProvider: provider });
const conv = await post('/conversations', { agentId: agent._id });
await post(`/conversations/${conv._id}/messages`, { text: 'What can you do? List every tool you have, by exact name.', source: 'text' });
for (let i = 0; i < 180; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const r = await get(`/conversations/${conv._id}`);
  const reply = r.messages.find((m: any) => m.role === 'agent');
  if (reply && !reply.generating) {
    const ex = await get(`/conversations/${conv._id}`);
    console.log(`testTools: ${agent.testTools}`);
    console.log(`reply (${reply.provider}, ${reply.model}): ${reply.text}`);
    console.log('tool steps:', JSON.stringify(reply.steps.filter((s: any) => !('text' in s))));
    console.log('ledger entries:', ex.ledger.length);
    break;
  }
}
