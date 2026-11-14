// Sketch: one ProviderDriver for engines that speak ACP (JSON-RPC on stdio).
// Measured engines and how each is held to the gateway's tools are in
// ../FINDINGS.md. Copilot is the one wired here; Kiro and Goose differ only
// in `launch` (and rely on refusing permission requests instead of removing tools).
import { spawn, type ChildProcess } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ProviderDriver, ProviderEvent, ProviderSession, ProviderStart } from '../../../shared/types.ts';

interface Engine {
  id: string;
  /** Command and args; gets the gateway tool names, as the engine will call them. */
  launch(toolNames: string[]): { cmd: string; args: string[]; env?: Record<string, string> };
  /** Is this permission request for one of the gateway's tools? Everything else is refused. */
  isGatewayCall(toolCall: any, toolNames: string[]): boolean;
}

export const engines: Record<string, Engine> = {
  copilot: {
    id: 'copilot',
    launch: (tools) => ({
      cmd: 'copilot',
      args: ['--acp', '--disable-builtin-mcps', '--no-custom-instructions',
        '--available-tools', ...tools.map((t) => `gateway-${t}`)],
    }),
    // Its built-ins are removed, so the only permission requests are ours; titled by bare tool name.
    isGatewayCall: (tc, names) => names.includes(String(tc.title ?? '').replace(/^gateway-/, '')),
  },
  kiro: {
    id: 'kiro',
    launch: () => ({ cmd: 'kiro-cli', args: ['acp'] }),
    isGatewayCall: (tc) => /@gateway\//.test(tc.title ?? ''),
  },
  goose: {
    id: 'goose',
    launch: () => ({ cmd: 'goose', args: ['acp'], env: { GOOSE_MODE: 'approve' } }),
    isGatewayCall: (tc) => /^gateway: /.test(tc.title ?? ''),
  },
};

async function gatewayToolNames(url: string): Promise<string[]> {
  const c = new Client({ name: 'acp-driver', version: '0.0.1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(url)));
  const { tools } = await c.listTools();
  await c.close();
  return tools.map((t) => t.name);
}

export function acpDriver(engine: Engine): ProviderDriver {
  return {
    name: engine.id as any,
    async start(o: ProviderStart): Promise<ProviderSession> {
      const toolNames = await gatewayToolNames(o.mcp.url);
      const { cmd, args, env } = engine.launch(toolNames);
      const p: ChildProcess = spawn(cmd, args, { cwd: o.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
      let alive = true;
      let id = 0;
      const pending = new Map<number, (m: any) => void>();
      const queue: ProviderEvent[] = [];
      let wake: (() => void) | null = null;
      const emit = (e: ProviderEvent) => { queue.push(e); wake?.(); };
      const write = (m: unknown) => p.stdin!.write(JSON.stringify(m) + '\n');
      const call = (method: string, params: unknown) =>
        new Promise<any>((ok, no) => {
          pending.set(++id, (m) => (m.error ? no(new Error(m.error.message ?? JSON.stringify(m.error))) : ok(m.result)));
          write({ jsonrpc: '2.0', id, method, params });
        });
      let turnText = '';
      let loading = false;
      const titles = new Map<string, string>();

      let buf = '';
      p.stdout!.on('data', (c) => {
        buf += c;
        for (let i; (i = buf.indexOf('\n')) >= 0; ) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let m: any;
          try { m = JSON.parse(line); } catch { continue; }
          if (m.id != null && !m.method) { pending.get(m.id)?.(m); pending.delete(m.id); continue; }
          if (m.method === 'session/update') {
            if (loading) continue; // session/load replays the history; it is not new.
            const u = m.params.update;
            if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') {
              // Copilot prefixes a notice listing the tools it switched off; it is not the model's.
              const delta = String(u.content.text).replace(/^Info: Disabled tools:[^\n]*?(?=\d+\.|$)/, '');
              if (delta) { turnText += delta; emit({ type: 'text', delta }); }
            } else if (u.sessionUpdate === 'tool_call') {
              titles.set(u.toolCallId, u.title ?? '');
              emit({ type: 'tool', phase: 'request', ref: u.toolCallId, name: u.title ?? '', input: u.rawInput });
            } else if (u.sessionUpdate === 'tool_call_update' && (u.status === 'completed' || u.status === 'failed')) {
              emit({ type: 'tool', phase: 'response', ref: u.toolCallId, name: titles.get(u.toolCallId) ?? '',
                output: u.rawOutput ?? u.content, isError: u.status === 'failed' });
            }
            continue;
          }
          if (m.method === 'session/request_permission') {
            const ours = engine.isGatewayCall(m.params.toolCall ?? {}, toolNames);
            const opt = m.params.options.find((x: any) => x.kind === (ours ? 'allow_once' : 'reject_once'))
              ?? m.params.options.find((x: any) => String(x.kind).startsWith(ours ? 'allow' : 'reject'));
            write({ jsonrpc: '2.0', id: m.id, result: { outcome: opt ? { outcome: 'selected', optionId: opt.optionId } : { outcome: 'cancelled' } } });
            continue;
          }
          if (m.id != null) write({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'not supported' } });
        }
      });
      p.on('exit', () => { alive = false; for (const r of pending.values()) r({ error: { message: 'engine exited' } }); wake?.(); });

      await call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
      const mcpServers = [{ type: 'http', name: 'gateway', url: o.mcp.url, headers: [] }];
      let sessionId: string;
      let model = engine.id;
      if (o.resumeSessionId) {
        loading = true;
        const r = await call('session/load', { sessionId: o.resumeSessionId, cwd: o.cwd, mcpServers }).finally(() => (loading = false));
        sessionId = o.resumeSessionId;
        model = r?.models?.currentModelId ?? model;
      } else {
        const r = await call('session/new', { cwd: o.cwd, mcpServers });
        sessionId = r.sessionId;
        model = r?.models?.currentModelId ?? model;
      }
      emit({ type: 'session', sessionId, model });

      // ACP has no system-prompt field: it goes in front of the first message.
      let first = !o.resumeSessionId;
      let interrupted = false;
      return {
        get alive() { return alive; },
        send(text) {
          const body = first ? `${o.systemPrompt}\n\n---\n\n${text}` : text;
          first = false; interrupted = false; turnText = '';
          call('session/prompt', { sessionId, prompt: [{ type: 'text', text: body }] }).then(
            (r) => emit({ type: 'turn-ended', interrupted: interrupted || r?.stopReason === 'cancelled', text: turnText }),
            (e) => emit({ type: 'turn-ended', interrupted, text: turnText, error: String(e) }),
          );
        },
        async interrupt() { interrupted = true; write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } }); },
        async close() { alive = false; p.kill('SIGTERM'); setTimeout(() => p.kill('SIGKILL'), 2000).unref(); wake?.(); },
        async *events() {
          while (true) {
            while (queue.length) yield queue.shift()!;
            if (!alive) return;
            await new Promise<void>((r) => (wake = r));
            wake = null;
          }
        },
      };
    },
  };
}
