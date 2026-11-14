// Checks the Claude Code driver: one turn asking it to run `ls`.
import { claudeCodeDriver } from '../server/providers/claudeCode.js';

const session = await claudeCodeDriver.start({
  conversationId: 'spike', systemPrompt: 'You are a helpful agent.',
  mcp: { name: 'gateway', url: 'http://127.0.0.1:4199/mcp/none' }, cwd: process.argv[2] ?? '/tmp',
});
session.send('Run `ls` in your working directory and tell me what is there. Also list every tool you have, by exact name.');
for await (const ev of session.events()) {
  if (ev.type === 'text') process.stdout.write(ev.delta);
  else console.log('\n', JSON.stringify(ev).slice(0, 400));
  if (ev.type === 'turn-ended') break;
}
await session.close();
