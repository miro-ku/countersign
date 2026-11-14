// Document shapes the page renders, as described in docs/CONTRACT.md.
// Dates arrive over JSON as ISO strings.
import type { Provider, Step, LedgerOutcome } from '../../shared/types.ts';

export type { Provider, Step, LedgerOutcome };

export interface Agent {
  _id: string;
  ownerId: string;
  name: string;
  instructions: string;
  instructionsHash?: string;
  version: number;
  defaultProvider: Provider;
  /** Drawn for the agent from its name and instructions, a few seconds after it is made. */
  avatar?: { emoji: string; from: string; to: string };
  createdAt: string;
}

export interface Rule {
  _id: string;
  agentId: string | null;
  match: { action?: string; kind?: 'read' | 'write'; actionPattern?: string; argsPattern?: string };
  effect: 'allow' | 'ask' | 'deny';
  /** What the rule covers, in plain words. */
  title?: string;
  /** Applied by a judging model reading the sentence, not by a test on fields. */
  judged?: boolean;
  source?: string;
  reason: string;
}

export interface Connection {
  _id: string;
  agentId: string;
  ownerId: string;
  toolkit: string;
  composioUserId?: string;
  composioAccountId?: string;
  status: 'pending' | 'active' | 'revoked';
  /** The authorization was never finished, or no longer works. */
  stale?: boolean;
  connectedAt?: string;
  revokedAt?: string;
}

export interface Conversation {
  _id: string;
  agentId: string;
  ownerId: string;
  provider: Provider;
  providerSessions?: Record<string, { sessionId: string; seenMessageId: string; at: string }>;
  stoppedNote?: boolean;
  /** What the conversation is about, named from its first message. */
  title?: string;
  createdAt: string;
}

export interface Message {
  _id: string;
  conversationId: string;
  seq: number;
  role: 'user' | 'agent' | 'event';
  text: string;
  source?: 'text' | 'voice';
  provider?: Provider;
  model?: string;
  executionId?: string;
  generating: boolean;
  steps?: Step[];
  at: string;
}

export interface Execution {
  _id: string;
  conversationId: string;
  triggerMessageId?: string;
  provider: Provider;
  model?: string;
  status: 'running' | 'completed' | 'stopped' | 'failed' | 'handed_off';
  providerSessionId?: string;
  startedAt: string;
  endedAt?: string;
  error?: string;
}

export interface AskAnswer {
  by: string;
  source: 'button' | 'voice';
  scope: 'once' | 'conversation';
  transcript?: string;
  verdict?: string;
  at: string;
}

export interface Ask {
  _id: string;
  conversationId: string;
  agentId: string;
  executionId?: string;
  fingerprint: string;
  action: string;
  args: unknown;
  summary: string;
  status: 'open' | 'approved' | 'declined' | 'replied' | 'stopped';
  askedByProvider: Provider;
  answer?: AskAnswer;
  createdAt: string;
}

export interface LedgerRow {
  _id: string;
  seq: number;
  at: string;
  ownerId: string;
  agentId: string;
  agentVersion: number;
  conversationId: string;
  executionId?: string;
  provider: Provider;
  model?: string;
  action: string;
  /** The action in plain words. */
  summary?: string;
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

export type StreamEvent =
  | { type: 'message'; message: Message }
  | { type: 'ask'; ask: Ask }
  | { type: 'ledger'; entry: LedgerRow }
  | { type: 'conversation'; conversation: Conversation }
  | { type: 'execution'; execution: Execution }
  | { type: 'connection'; connection: Connection };

export const PROVIDER_LABEL: Record<Provider, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
};
