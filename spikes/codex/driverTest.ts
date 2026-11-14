// Drives codexDriver against the tiny MCP server: two turns, an interrupt
// during a held tool call, then a resume of the same thread in a new process.
// Usage: npx tsx spikes/codex/driverTest.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { codexDriver } from '../../server/providers/codex/index.js';
import type { ProviderEvent, ProviderSession } from '../../shared/types.js';
import { startNotesServer } from './mcpServer.js';

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);
let holdMs = 2000;
const PORT = Number(process.env.PORT ?? 4193);
const server = await startNotesServer(PORT, 0, log, () => holdMs);
const cwd = mkdtempSync(path.join(tmpdir(), 'codex-driver-'));
const start = (resumeSessionId?: string) =>
  codexDriver.start({
    conversationId: 'test',
    systemPrompt: 'You are a notes assistant. Keep replies to one sentence.',
    resumeSessionId,
    mcp: { name: 'gateway', url: `http://127.0.0.1:${PORT}/mcp` },
    cwd,
  });

const failures: string[] = [];
const check = (ok: boolean, what: string) => { log(ok ? 'PASS' : 'FAIL', what); if (!ok) failures.push(what); };

function pump(s: ProviderSession) {
  const seen: ProviderEvent[] = [];
  let waiter: ((e: ProviderEvent) => void) | null = null;
  let want: ((e: ProviderEvent) => boolean) | null = null;
  (async () => {
    for await (const e of s.events()) {
      if (e.type !== 'text') log('event', JSON.stringify(e).slice(0, 300));
      seen.push(e);
      if (want?.(e)) { const w = waiter!; waiter = want = null; w(e); }
    }
  })();
  const next = (pred: (e: ProviderEvent) => boolean, timeoutMs = 180_000) =>
    new Promise<ProviderEvent>((ok, fail) => {
      const found = seen.find(pred);
      if (found) { seen.splice(seen.indexOf(found), 1); return ok(found); }
      want = pred; waiter = (e) => { seen.splice(seen.indexOf(e), 1); ok(e); };
      setTimeout(() => fail(new Error('timed out waiting for event')), timeoutMs);
    });
  return next;
}

let s = await start();
let next = pump(s);
const session = (await next((e) => e.type === 'session')) as Extract<ProviderEvent, { type: 'session' }>;
check(!!session.sessionId && !!session.model, `session event (thread ${session.sessionId}, model ${session.model})`);

log('>>> turn 1');
s.send('add a note saying hello');
const req1 = await next((e) => e.type === 'tool' && e.phase === 'request');
check(req1.type === 'tool' && req1.name === 'notes_add', 'tool request notes_add');
const res1 = await next((e) => e.type === 'tool' && e.phase === 'response');
check(res1.type === 'tool' && !res1.isError, 'tool response ok');
const end1 = await next((e) => e.type === 'turn-ended');
check(end1.type === 'turn-ended' && !end1.interrupted && end1.text.length > 0, `turn 1 ended: ${JSON.stringify(end1.type === 'turn-ended' && end1.text)}`);

log('>>> turn 2');
s.send('What did you just do? One sentence.');
const end2 = await next((e) => e.type === 'turn-ended');
check(end2.type === 'turn-ended' && /hello/i.test(end2.text), `turn 2 remembers: ${JSON.stringify(end2.type === 'turn-ended' && end2.text)}`);

log('>>> turn 3, interrupted during a held call');
holdMs = 60_000;
s.send('add a note saying goodbye');
await next((e) => e.type === 'tool' && e.phase === 'request');
await new Promise((r) => setTimeout(r, 2000));
const ti = Date.now();
await s.interrupt();
const end3 = await next((e) => e.type === 'turn-ended');
check(end3.type === 'turn-ended' && end3.interrupted, `turn 3 interrupted in ${Date.now() - ti}ms`);
await s.close();
check(!s.alive, 'closed');

log('>>> resume in a new process');
holdMs = 1000;
s = await start(session.sessionId);
next = pump(s);
const session2 = (await next((e) => e.type === 'session')) as Extract<ProviderEvent, { type: 'session' }>;
check(session2.sessionId === session.sessionId, `resumed same thread ${session2.sessionId}`);
s.send('[System] The previous turn was stopped part-way through by the person. A tool call still running then never returned: call it again if it is still needed.\n[Miro] Please finish what I asked.');
const end4 = await next((e) => e.type === 'turn-ended');
check(end4.type === 'turn-ended' && !end4.interrupted, `turn 4: ${JSON.stringify(end4.type === 'turn-ended' && end4.text)}`);
await s.close();

server.close(); server.closeAllConnections();
log(failures.length ? `FAILED: ${failures.join('; ')}` : 'ALL PASSED');
process.exit(failures.length ? 1 : 0);
