// Drives `codex app-server` over stdio JSON-RPC and prints every event.
// Usage: npx tsx spikes/codex/probe.ts "<prompt>" ["<prompt 2>" ...]
//   env: HOLD_MS (notes_add hold), RESUME=<threadId>, INTERRUPT_AFTER_MS, SANDBOX, NO_OFF=1
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { startNotesServer } from './mcpServer.js';

const PORT = 4199;
const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...a: unknown[]) => console.log(ts(), ...a);

const http = await startNotesServer(PORT, Number(process.env.HOLD_MS ?? 60000), log);
const cwd = process.env.CWD ?? mkdtempSync(path.join(tmpdir(), 'codex-empty-'));
log('cwd', cwd);

// The user's own configured MCP servers, switched off by name.
const own = (JSON.parse(execFileSync('codex', ['mcp', 'list', '--json'], { cwd, encoding: 'utf8' })) as { name: string }[]).map((s) => s.name);
log('own MCP servers turned off:', own.join(', '));

const OFF = process.env.NO_OFF ? [] : [
  'notify=[]', 'features.plugins=false', 'features.hooks=false', 'features.apps=false',
  'features.shell_tool=false', 'features.unified_exec=false', 'features.view_image=false',
  'features.image_generation=false', 'features.multi_agent=false', 'features.browser_use=false',
  'features.computer_use=false', 'features.in_app_browser=false', 'features.tool_suggest=false',
  'features.goals=false', 'features.skill_search=false', 'features.sleep_tool=false',
  'web_search="disabled"',
];
const args = [...OFF.flatMap((c) => ['-c', c]), 'app-server'];
const child = spawn('codex', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', (d) => process.env.STDERR && log('[stderr]', String(d).trim()));

let nextId = 1;
const pending = new Map<number, (m: any) => void>();
const send = (m: object) => child.stdin.write(JSON.stringify(m) + '\n');
const request = (method: string, params: unknown) =>
  new Promise<any>((ok) => { const id = nextId++; pending.set(id, ok); send({ jsonrpc: '2.0', id, method, params }); });

let turnDone: (() => void) | null = null;
let currentTurn: string | null = null;
const QUIET = new Set(['item/agentMessage/delta', 'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta', 'thread/tokenUsage/updated', 'account/rateLimits/updated', 'item/reasoning/summaryPartAdded']);
let text = '';
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  let m: any; try { m = JSON.parse(line); } catch { return log('[raw]', line); }
  if (m.id !== undefined && m.method === undefined) { pending.get(m.id)?.(m); pending.delete(m.id); return; }
  if (m.id !== undefined && m.method) { // server → client request
    log('[REQUEST]', m.method, JSON.stringify(m.params).slice(0, 600));
    let result: unknown;
    switch (m.method) {
      case 'item/commandExecution/requestApproval': result = { decision: 'decline' }; break;
      case 'item/fileChange/requestApproval': result = { decision: 'decline' }; break;
      case 'mcpServer/elicitation/request':
        result = m.params.serverName === 'gateway' && m.params._meta?.codex_approval_kind === 'mcp_tool_call'
          ? { action: 'accept', content: null, _meta: null } : { action: 'decline', content: null, _meta: null };
        break;
      case 'item/permissions/requestApproval': result = { permissions: {}, scope: 'turn' }; break;
      default: send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'not supported' } }); return;
    }
    log('[ANSWER]', JSON.stringify(result));
    send({ jsonrpc: '2.0', id: m.id, result });
    return;
  }
  if (m.method === 'item/agentMessage/delta') text += m.params.delta;
  if (QUIET.has(m.method)) return;
  const p = m.params ?? {};
  if (m.method === 'item/started' || m.method === 'item/completed') {
    const it = p.item ?? {};
    const brief = { ...it }; if (brief.text?.length > 300) brief.text = brief.text.slice(0, 300) + '…';
    log(m.method, it.type, JSON.stringify(brief).slice(0, 900));
  } else log(m.method, JSON.stringify(p).slice(0, 500));
  if (m.method === 'turn/started') currentTurn = p.turn?.id;
  if (m.method === 'turn/completed') { log('AGENT TEXT:', JSON.stringify(text)); text = ''; turnDone?.(); }
});

const init = await request('initialize', { clientInfo: { name: 'gateway-probe', title: 'probe', version: '0' }, capabilities: { experimentalApi: true } });
log('initialize →', JSON.stringify(init.result ?? init.error).slice(0, 300));
send({ jsonrpc: '2.0', method: 'initialized' });

const threadParams = {
  cwd,
  sandbox: process.env.SANDBOX ?? 'read-only',
  approvalPolicy: process.env.APPROVAL ?? 'on-request',
  approvalsReviewer: 'user',
  developerInstructions: 'You are a notes assistant. Your only tools are those of the gateway MCP server.',
  config: {
    mcp_servers: { ...Object.fromEntries(own.map((n) => [n, { enabled: false }])), gateway: { url: `http://127.0.0.1:${PORT}/mcp`, tool_timeout_sec: 300, startup_timeout_sec: 20, default_tools_approval_mode: process.env.MCP_APPROVAL ?? 'approve' } },
  },
};
const started = process.env.RESUME
  ? await request('thread/resume', { threadId: process.env.RESUME, ...threadParams })
  : await request('thread/start', threadParams);
log(process.env.RESUME ? 'thread/resume →' : 'thread/start →', JSON.stringify(started.result ?? started.error).slice(0, 1500));
const threadId = started.result?.thread?.id;

for (const prompt of process.argv.slice(2)) {
  log('>>> SEND', JSON.stringify(prompt));
  const done = new Promise<void>((ok) => (turnDone = ok));
  const r = await request('turn/start', { threadId, input: [{ type: 'text', text: prompt, text_elements: [] }] });
  log('turn/start →', JSON.stringify(r.result ?? r.error).slice(0, 300));
  if (process.env.INTERRUPT_AFTER_MS) {
    setTimeout(async () => {
      log('>>> turn/interrupt', currentTurn);
      const ir = await request('turn/interrupt', { threadId, turnId: currentTurn });
      log('turn/interrupt →', JSON.stringify(ir.result ?? ir.error));
    }, Number(process.env.INTERRUPT_AFTER_MS));
  }
  await done;
}
log('THREAD', threadId);
child.kill('SIGTERM');
http.close(); http.closeAllConnections();
setTimeout(() => process.exit(0), 300);
