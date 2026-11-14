// Drives the installed `claude` CLI in stream-json mode. The model gets the
// gateway's tools and nothing else: no shell, no files, no web.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ProviderDriver, ProviderEvent, ProviderSession, ProviderStart } from '../../shared/types.js';
import { EventQueue } from './queue.js';

const CLAUDE_BIN = process.env.CLAUDE_BIN || '/Users/mirik/.local/bin/claude';

// Every CLI process still running dies with the server, however it exits.
const children = new Set<ChildProcessWithoutNullStreams>();
process.on('exit', () => {
  for (const child of children) child.kill('SIGTERM');
});

export function claudeArgs(o: ProviderStart): string[] {
  const mcpConfig = { mcpServers: { [o.mcp.name]: { type: 'http', url: o.mcp.url } } };
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--system-prompt', o.systemPrompt,
    '--system-prompt-snapshot', 'off',
    '--mcp-config', JSON.stringify(mcpConfig),
    '--strict-mcp-config',
    // No built-in tools at all; only the gateway's.
    '--tools', '',
    '--allowedTools', `mcp__${o.mcp.name}__*`,
    '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none',
    '--setting-sources', '',
    '--disable-slash-commands',
  ];
  if (o.resumeSessionId) args.push('--resume', o.resumeSessionId);
  return args;
}

class ClaudeCodeSession implements ProviderSession {
  private child: ChildProcessWithoutNullStreams;
  private queue = new EventQueue<ProviderEvent>();
  private turnText = '';
  private interrupting = false;
  private exited = false;
  private stderr = '';

  constructor(o: ProviderStart) {
    this.child = spawn(CLAUDE_BIN, claudeArgs(o), {
      cwd: o.cwd,
      env: { ...process.env, MCP_TOOL_TIMEOUT: '300000' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.add(this.child);
    createInterface({ input: this.child.stdout }).on('line', (line) => this.onLine(line));
    this.child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-4000);
    });
    this.child.on('exit', (code) => {
      this.exited = true;
      children.delete(this.child);
      // A turn that was running never gets its result: end it here.
      this.queue.push({
        type: 'turn-ended', interrupted: this.interrupting, text: this.turnText,
        error: `claude exited (code ${code}). ${this.stderr.trim().slice(-500)}`,
      });
      this.queue.end();
    });
  }

  get alive() {
    return !this.exited;
  }

  private write(obj: unknown) {
    if (!this.exited) this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  send(text: string) {
    this.turnText = '';
    this.interrupting = false;
    this.write({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
  }

  async interrupt() {
    this.interrupting = true;
    this.write({ type: 'control_request', request_id: `interrupt-${Date.now()}`, request: { subtype: 'interrupt' } });
  }

  async close() {
    if (this.exited) return;
    this.child.stdin.end();
    const killer = setTimeout(() => this.child.kill('SIGTERM'), 3000);
    await new Promise<void>((resolve) => this.child.once('exit', () => resolve()));
    clearTimeout(killer);
  }

  events(): AsyncIterable<ProviderEvent> {
    return this.queue;
  }

  private onLine(line: string) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          this.queue.push({ type: 'session', sessionId: msg.session_id, model: msg.model });
        }
        break;
      case 'stream_event': {
        const ev = msg.event;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && !msg.parent_tool_use_id) {
          this.turnText += ev.delta.text;
          this.queue.push({ type: 'text', delta: ev.delta.text });
        }
        break;
      }
      case 'assistant':
        for (const block of msg.message?.content ?? []) {
          if (block.type === 'tool_use') {
            this.queue.push({ type: 'tool', phase: 'request', ref: block.id, name: stripPrefix(block.name), input: block.input });
          }
        }
        break;
      case 'user':
        for (const block of msg.message?.content ?? []) {
          if (block.type === 'tool_result') {
            this.queue.push({
              type: 'tool', phase: 'response', ref: block.tool_use_id, name: '',
              output: toolOutput(block.content), isError: Boolean(block.is_error),
            });
          }
        }
        break;
      case 'result': {
        const failed = msg.is_error || String(msg.subtype ?? '').startsWith('error');
        const interrupted = this.interrupting;
        this.interrupting = false;
        this.queue.push({
          type: 'turn-ended',
          interrupted,
          text: this.turnText || (typeof msg.result === 'string' ? msg.result : ''),
          error: failed && !interrupted ? String(msg.result ?? msg.subtype ?? 'failed') : undefined,
        });
        this.turnText = '';
        break;
      }
      case 'control_request':
        // Nothing should ask permission (dontAsk), but never leave the CLI waiting.
        this.write({
          type: 'control_response',
          response: { subtype: 'success', request_id: msg.request_id, response: { behavior: 'deny', message: 'Not allowed.' } },
        });
        break;
    }
  }
}

function stripPrefix(name: string): string {
  return name.replace(/^mcp__gateway__/, '');
}

function toolOutput(content: unknown): unknown {
  if (Array.isArray(content)) {
    return content.map((c: any) => (c?.type === 'text' ? c.text : c)).join('\n');
  }
  return content;
}

export const claudeCodeDriver: ProviderDriver = {
  name: 'claude-code',
  async start(o) {
    return new ClaudeCodeSession(o);
  },
};
