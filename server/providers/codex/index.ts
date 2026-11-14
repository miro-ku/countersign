// The Codex driver: one `codex app-server` process per session, spoken to over
// stdio JSON-RPC (one JSON object per line). The model gets no tools but the
// gateway's: Codex's own shell, web, apps, plugins and the user's configured
// MCP servers are switched off, the sandbox is read-only in an empty directory,
// and every command or file approval is declined. See spikes/codex/FINDINGS.md.

import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import type { ProviderDriver, ProviderEvent, ProviderSession, ProviderStart } from '../../../shared/types.js';

// How hard the model thinks on a turn. The work here is short tool calls, so
// a quick answer matters more than a deep one. CODEX_EFFORT overrides it.
const EFFORT = process.env.CODEX_EFFORT || 'low';

const CODEX_BIN = process.env.CODEX_BIN ?? 'codex';
/** The gateway may hold a call for 4 minutes while a person decides. */
const TOOL_TIMEOUT_SEC = 300;

/** Launch flags that take away every tool Codex brings itself. */
const TOOLS_OFF = [
  'notify=[]',
  'features.plugins=false',
  'features.hooks=false',
  'features.apps=false',
  'features.shell_tool=false',
  'features.unified_exec=false',
  'features.view_image=false',
  'features.image_generation=false',
  'features.multi_agent=false',
  'features.browser_use=false',
  'features.computer_use=false',
  'features.in_app_browser=false',
  'features.tool_suggest=false',
  'features.goals=false',
  'features.skill_search=false',
  'features.sleep_tool=false',
  'web_search="disabled"',
].flatMap((c) => ['-c', c]);

/** Codex reads its own state from CODEX_* variables; only CODEX_HOME is a deliberate choice. */
function childEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('CODEX_') || k === 'CODEX_HOME'),
  );
}

/**
 * The user's own MCP servers that would start on a thread. They are switched
 * off by name in the thread config (a launch-time `-c` for them is rejected,
 * and naming one that is not configured fails the thread).
 */
let ownServers: Promise<string[]> | null = null;
function userServers(cwd: string): Promise<string[]> {
  ownServers ??= new Promise((resolve) => {
    execFile(
      CODEX_BIN,
      ['-c', 'features.plugins=false', '-c', 'features.apps=false', 'mcp', 'list', '--json'],
      { cwd, env: childEnv(), timeout: 15_000 },
      (err, stdout) => {
        if (err) return resolve([]);
        try {
          const list = JSON.parse(stdout) as { name?: unknown; enabled?: unknown }[];
          resolve(list.filter((s) => s.enabled !== false && typeof s.name === 'string').map((s) => s.name as string));
        } catch {
          resolve([]);
        }
      },
    );
  });
  return ownServers;
}

// ── A small async queue for the events ───────────────────────────

class EventQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiting: ((r: IteratorResult<T>) => void) | null = null;
  private ended = false;
  push(item: T) {
    if (this.ended) return;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: item, done: false });
    } else this.items.push(item);
  }
  end() {
    this.ended = true;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: undefined as never, done: true });
    }
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((r) => (this.waiting = r));
      },
    };
  }
}

// ── The session ──────────────────────────────────────────────────

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

class CodexSession implements ProviderSession {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { ok: (v: Json) => void; fail: (e: Error) => void }>();
  private queue = new EventQueue<ProviderEvent>();
  private consumed = false;
  private exited = false;
  private stderrTail = '';

  threadId = '';
  model = '';
  private turnId: string | null = null;
  private turnActive = false;
  private turnText = '';
  private turnError: string | undefined;
  private waitingTexts: string[] = [];
  private turnEndWaiters: (() => void)[] = [];
  /** Agent message items already seen this turn, to separate them. */
  private messageCount = 0;

  constructor(private readonly o: ProviderStart) {
    this.child = spawn(CODEX_BIN, [...TOOLS_OFF, 'app-server'], {
      cwd: o.cwd,
      env: childEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.on('data', (d) => {
      this.stderrTail = (this.stderrTail + String(d)).slice(-2000);
    });
    this.child.on('error', (e) => this.onExit(`Codex could not start: ${e.message}`));
    this.child.on('exit', (code, signal) => this.onExit(`Codex exited (${signal ?? code})`));
    this.child.stdin.on('error', () => {});
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => this.onLine(line));
  }

  get alive() {
    return !this.exited;
  }

  // ── JSON-RPC ──

  private write(message: object) {
    if (!this.exited) this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  private request(method: string, params: unknown, timeoutMs = 60_000): Promise<Json> {
    return new Promise((ok, fail) => {
      if (this.exited) return fail(new Error('Codex is not running'));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fail(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        ok: (v) => (clearTimeout(timer), ok(v)),
        fail: (e) => (clearTimeout(timer), fail(e)),
      });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private onLine(line: string) {
    let m: Json;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id !== undefined && m.method === undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.fail(new Error(m.error.message ?? 'Codex error'));
      else p.ok(m.result);
      return;
    }
    if (m.id !== undefined && m.method) return this.onServerRequest(m.id, m.method, m.params ?? {});
    if (m.method) this.onNotification(m.method, m.params ?? {});
  }

  /** Codex asking us something. Only the gateway's tool calls are let through. */
  private onServerRequest(id: number | string, method: string, params: Json) {
    const reply = (result: unknown) => this.write({ jsonrpc: '2.0', id, result });
    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        return reply({ decision: 'decline' });
      case 'execCommandApproval':
      case 'applyPatchApproval':
        return reply({ decision: { denied: { rejection: 'Only the gateway tools may be used.' } } });
      case 'mcpServer/elicitation/request': {
        // The gateway does its own checking, so its tool-call approvals are accepted.
        const isGatewayCall =
          params.serverName === this.o.mcp.name && params._meta?.codex_approval_kind === 'mcp_tool_call';
        return reply({ action: isGatewayCall ? 'accept' : 'decline', content: null, _meta: null });
      }
      case 'item/permissions/requestApproval':
        return reply({ permissions: {}, scope: 'turn' });
      default:
        return this.write({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `${method} is not available here.` },
        });
    }
  }

  private onNotification(method: string, p: Json) {
    switch (method) {
      case 'turn/started':
        if (p.turn?.id) this.turnId = p.turn.id;
        return;
      case 'item/started': {
        const item = p.item ?? {};
        if (item.type === 'agentMessage') {
          // Codex writes several messages per turn (commentary, then the answer).
          if (this.messageCount++ > 0 && this.turnText && !this.turnText.endsWith('\n')) this.text('\n\n');
        } else if (item.type === 'mcpToolCall') {
          this.queue.push({ type: 'tool', phase: 'request', ref: item.id, name: item.tool, input: item.arguments ?? {} });
        }
        return;
      }
      case 'item/agentMessage/delta':
        if (typeof p.delta === 'string' && p.delta) this.text(p.delta);
        return;
      case 'item/completed': {
        const item = p.item ?? {};
        if (item.type === 'mcpToolCall') {
          const failed = item.status === 'failed' || !!item.error || !!item.result?.isError;
          this.queue.push({
            type: 'tool',
            phase: 'response',
            ref: item.id,
            name: item.tool,
            output: item.error ? item.error.message : (item.result?.content ?? item.result),
            isError: failed,
          });
        }
        // fileChange items are never forwarded: their diff can hold a real file.
        return;
      }
      case 'error':
        if (!p.willRetry && p.error?.message) this.turnError = p.error.message;
        return;
      case 'turn/completed': {
        const turn = p.turn ?? {};
        if (this.turnId && turn.id && turn.id !== this.turnId) return;
        const error = turn.status === 'failed' ? (turn.error?.message ?? this.turnError ?? 'The turn failed') : undefined;
        this.finishTurn(turn.status === 'interrupted', error);
        return;
      }
    }
  }

  private text(delta: string) {
    this.turnText += delta;
    this.queue.push({ type: 'text', delta });
  }

  private finishTurn(interrupted: boolean, error?: string) {
    if (!this.turnActive) return;
    this.queue.push({ type: 'turn-ended', interrupted, text: this.turnText, ...(error ? { error } : {}) });
    this.turnActive = false;
    this.turnId = null;
    for (const w of this.turnEndWaiters.splice(0)) w();
    const next = this.waitingTexts.shift();
    if (next !== undefined) this.startTurn(next);
  }

  private onExit(reason: string) {
    if (this.exited) return;
    this.exited = true;
    for (const p of this.pending.values()) p.fail(new Error(reason));
    this.pending.clear();
    this.waitingTexts = [];
    if (this.turnActive) {
      const tail = this.stderrTail.trim().split('\n').pop();
      this.finishTurn(false, tail ? `${reason}: ${tail}` : reason);
    }
    this.queue.end();
  }

  // ── Lifecycle ──

  async open() {
    await this.request('initialize', {
      clientInfo: { name: 'governed-agents', title: 'Governed agents', version: '1' },
      capabilities: { experimentalApi: true },
    });
    this.write({ jsonrpc: '2.0', method: 'initialized' });

    const off = await userServers(this.o.cwd);
    const params = {
      cwd: this.o.cwd,
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
      // Approvals come to this driver, never to a reviewer model.
      approvalsReviewer: 'user',
      developerInstructions: this.o.systemPrompt,
      config: {
        model_reasoning_effort: EFFORT,
        mcp_servers: {
          ...Object.fromEntries(off.filter((n) => n !== this.o.mcp.name).map((n) => [n, { enabled: false }])),
          [this.o.mcp.name]: {
            url: this.o.mcp.url,
            tool_timeout_sec: TOOL_TIMEOUT_SEC,
            startup_timeout_sec: 20,
            default_tools_approval_mode: 'approve',
          },
        },
      },
    };

    let result: Json = null;
    if (this.o.resumeSessionId) {
      try {
        result = await this.request('thread/resume', { threadId: this.o.resumeSessionId, ...params, excludeTurns: true });
      } catch {
        result = null; // The saved thread is gone: start a fresh one; the engine sees a new session id.
      }
    }
    result ??= await this.request('thread/start', params);
    this.threadId = result?.thread?.id;
    this.model = result?.model ?? result?.thread?.model ?? 'codex';
    if (!this.threadId) throw new Error('Codex did not open a thread');
    this.queue.push({ type: 'session', sessionId: this.threadId, model: this.model });
  }

  send(text: string) {
    if (this.exited) throw new Error('The Codex session has ended');
    if (this.turnActive) this.waitingTexts.push(text);
    else this.startTurn(text);
  }

  private startTurn(text: string) {
    this.turnActive = true;
    this.turnText = '';
    this.turnError = undefined;
    this.messageCount = 0;
    this.turnId = null;
    this.request('turn/start', { threadId: this.threadId, input: [{ type: 'text', text, text_elements: [] }], effort: EFFORT })
      .then((r) => {
        if (this.turnActive && !this.turnId) this.turnId = r?.turn?.id ?? null;
      })
      .catch((e: Error) => this.finishTurn(false, e.message));
  }

  async interrupt() {
    if (!this.turnActive || this.exited) return;
    this.waitingTexts = [];
    const ended = new Promise<void>((r) => this.turnEndWaiters.push(r));
    for (let i = 0; i < 50 && !this.turnId && this.turnActive; i++) await new Promise((r) => setTimeout(r, 100));
    if (this.turnId) {
      await this.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }, 10_000).catch(() => {});
    }
    const late = setTimeout(() => this.finishTurn(true), 5_000);
    await ended;
    clearTimeout(late);
  }

  async close() {
    if (this.exited) return;
    const gone = new Promise<void>((r) => this.child.once('exit', () => r()));
    this.child.stdin.end();
    this.child.kill('SIGTERM');
    const hard = setTimeout(() => this.child.kill('SIGKILL'), 3_000);
    await Promise.race([gone, new Promise((r) => setTimeout(r, 4_000))]);
    clearTimeout(hard);
    this.onExit('closed');
  }

  events(): AsyncIterable<ProviderEvent> {
    if (this.consumed) throw new Error('events() can be read once');
    this.consumed = true;
    return this.queue;
  }
}

export const codexDriver: ProviderDriver = {
  name: 'codex',
  async start(options) {
    const session = new CodexSession(options);
    try {
      await session.open();
    } catch (e) {
      await session.close();
      throw e;
    }
    return session;
  },
};
