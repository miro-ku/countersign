// Types shared by every part. See docs/CONTRACT.md.

export type Provider = 'claude-code' | 'codex';

// ── Provider sessions ────────────────────────────────────────────

export interface ProviderStart {
  conversationId: string;
  systemPrompt: string;
  resumeSessionId?: string;
  /** The gateway: the only tools the model may have. */
  mcp: { name: 'gateway'; url: string };
  /** An empty scratch directory for this conversation. */
  cwd: string;
}

export type ProviderEvent =
  | { type: 'session'; sessionId: string; model: string }
  | { type: 'text'; delta: string }
  | {
      type: 'tool';
      phase: 'request' | 'response';
      ref: string;
      name: string;
      input?: unknown;
      output?: unknown;
      isError?: boolean;
    }
  | { type: 'turn-ended'; interrupted: boolean; text: string; error?: string };

export interface ProviderSession {
  readonly alive: boolean;
  send(text: string): void;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  events(): AsyncIterable<ProviderEvent>;
}

export interface ProviderDriver {
  name: Provider;
  start(options: ProviderStart): Promise<ProviderSession>;
}

// ── Messages ─────────────────────────────────────────────────────

export type Step =
  | { text: string }
  | { toolRequest: { ref: string; name: string; input: unknown } }
  | { toolResponse: { ref: string; name: string; output: unknown; isError: boolean } };

// ── Gateway ──────────────────────────────────────────────────────

export interface McpToolDef {
  name: string;
  description: string;
  /** JSON Schema of the tool's input. */
  inputSchema: Record<string, unknown>;
}

export interface Action {
  name: string;
  kind: 'read' | 'write';
  args: unknown;
  /** Plain words a person can approve: "send an email to anna@acme.com". */
  summary: string;
  connectionId?: string;
}

export interface CallCtx {
  ownerId: string;
  agentId: string;
  conversationId: string;
  executionId?: string;
  provider: Provider;
}

export type LedgerOutcome =
  | 'allowed'
  | 'denied'
  | 'asked'
  | 'approved'
  | 'declined'
  | 'executed'
  | 'failed'
  | 'undone';

export interface LedgerEntry {
  _id: string;
  seq: number;
  at: Date;
  ownerId: string;
  agentId: string;
  agentVersion: number;
  conversationId: string;
  executionId?: string;
  provider: Provider;
  model?: string;
  action: string;
  kind: 'read' | 'write';
  args: unknown;
  fingerprint: string;
  ruleId?: string;
  outcome: LedgerOutcome;
  decidedBy?: string;
  connectionId?: string;
  result?: unknown;
  undoable: boolean;
  undoOf?: string;
}

export interface ToolSource {
  id: string;
  /** What the model sees for this agent. */
  tools(agentId: string): Promise<McpToolDef[]>;
  /** The single actions one call would take; null refuses the tool outright. */
  actionsOf(tool: string, input: unknown): Action[] | null;
  run(tool: string, input: unknown, ctx: CallCtx): Promise<unknown>;
  undo?(entry: LedgerEntry): Promise<unknown>;
}
