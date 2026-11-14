// pnpm exec tsx spikes/engines/acp/driverTest.ts [copilot|kiro|goose] [port]
// Two turns with a tool call, then a restart that resumes the session.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startNotesServer } from '../../codex/mcpServer.ts';
import { acpDriver, engines } from './driver.ts';
import type { ProviderSession } from '../../../shared/types.ts';

const engine = engines[process.argv[2] ?? 'copilot'];
const port = Number(process.argv[3] ?? 4331);
const mcp = await startNotesServer(port, 0, (m: string) => console.log(m), () => 0);
const cwd = mkdtempSync(join(tmpdir(), `acp-driver-`));
const start = { conversationId: 'c1', systemPrompt: 'You are a notes assistant. Keep answers to one sentence.', mcp: { name: 'gateway' as const, url: `http://127.0.0.1:${port}/mcp` }, cwd };

async function turn(s: ProviderSession, it: AsyncIterator<any>, text: string) {
  s.send(text);
  for (;;) {
    const { value: e, done } = await it.next();
    if (done) throw new Error('stream ended');
    if (e.type === 'tool') console.log(`  tool ${e.phase} ${e.name} ${JSON.stringify(e.phase === 'request' ? e.input : e.output).slice(0, 100)}${e.isError ? ' ERROR' : ''}`);
    if (e.type === 'turn-ended') { console.log(`  turn-ended interrupted=${e.interrupted} text=${JSON.stringify(e.text)}${e.error ? ' error=' + e.error : ''}`); return; }
  }
}

let sessionId = '';
try {
  const d = acpDriver(engine);
  let s = await d.start(start);
  let it = s.events()[Symbol.asyncIterator]();
  const first = (await it.next()).value;
  console.log('session', first);
  sessionId = first.sessionId;
  console.log('turn 1'); await turn(s, it, 'Add a note "buy milk". Then run `ls` in a shell.');
  console.log('turn 2'); await turn(s, it, 'What note did you add? Add another note "call Anna".');
  await s.close();
  console.log('restart + resume');
  s = await d.start({ ...start, resumeSessionId: sessionId });
  it = s.events()[Symbol.asyncIterator]();
  console.log('session', (await it.next()).value);
  console.log('turn 3'); await turn(s, it, 'List the notes you added in this conversation.');
  await s.close();
} catch (e) { console.log('FAILED', e); }
mcp.close();
setTimeout(() => process.exit(0), 2500);
