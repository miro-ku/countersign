// Fires several turn starts at once (messages and a switch) and checks the
// turns never overlapped and only one reply was ever generating.
const API = process.env.API_URL ?? 'http://localhost:4100/api';
const post = (path: string, body: unknown) =>
  fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const get = (path: string) => fetch(API + path).then((r) => r.json());

const agent = await post('/agents', { name: 'One turn check', instructions: 'Answer in a few words.', defaultProvider: 'claude-code' });
const conv = await post('/conversations', { agentId: agent._id });
let maxGenerating = 0;
const watcher = setInterval(async () => {
  const r = await get(`/conversations/${conv._id}`);
  maxGenerating = Math.max(maxGenerating, r.messages.filter((m: any) => m.generating).length);
}, 150);
await Promise.all([
  post(`/conversations/${conv._id}/messages`, { text: 'Say one.', source: 'text' }),
  post(`/conversations/${conv._id}/messages`, { text: 'Say two.', source: 'text' }),
  post(`/conversations/${conv._id}/messages`, { text: 'Say three.', source: 'text' }),
  post(`/conversations/${conv._id}/provider`, { provider: 'claude-code' }),
]);
for (let i = 0; i < 120; i++) {
  const r = await get(`/conversations/${conv._id}`);
  if (!r.messages.some((m: any) => m.generating) && r.messages.some((m: any) => m.role === 'agent')) break;
  await new Promise((res) => setTimeout(res, 1000));
}
await new Promise((res) => setTimeout(res, 3000));
clearInterval(watcher);
const r = await get(`/conversations/${conv._id}`);
for (const m of r.messages) console.log(m.seq, m.role, m.text.slice(0, 80).replace(/\n/g, ' '));
console.log('most replies generating at once:', maxGenerating);
console.log('agent replies:', r.messages.filter((m: any) => m.role === 'agent').length);
