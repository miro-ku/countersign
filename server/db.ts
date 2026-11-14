import { config } from 'dotenv';
import { MongoClient, ObjectId, type Db } from 'mongodb';

config({ quiet: true });

export const OWNER_ID = 'miro';

// The running server connects as the restricted app user when one is configured:
// it may append to `ledger` and read it, never change or remove an entry.
const uri = process.env.MONGODB_APP_URI || process.env.MONGODB_URI;
if (!uri) throw new Error('MONGODB_URI is missing from .env');

export const client = new MongoClient(uri);
export const db: Db = client.db(process.env.MONGODB_DB || 'hackathon');

/** Every document id is a string: sortable by creation time, readable in JSON. */
export function newId(): string {
  return new ObjectId().toHexString();
}

/** A monotonic counter kept in the `counters` collection. */
export async function nextSeq(name: string): Promise<number> {
  const doc = await db
    .collection<{ _id: string; n: number }>('counters')
    .findOneAndUpdate({ _id: name }, { $inc: { n: 1 } }, { upsert: true, returnDocument: 'after' });
  return doc!.n;
}

// Document shapes, as docs/CONTRACT.md lists them.

export interface AgentDoc {
  _id: string;
  ownerId: string;
  name: string;
  instructions: string;
  instructionsHash: string;
  version: number;
  defaultProvider: string;
  /** Serves the built-in note tools; for testing only. */
  testTools?: boolean;
  createdAt: Date;
}

export interface ProviderPointer {
  sessionId: string;
  seenMessageId: string;
  at: Date;
}

export interface ConversationDoc {
  _id: string;
  agentId: string;
  ownerId: string;
  provider: string;
  providerSessions: Record<string, ProviderPointer>;
  stoppedNote: boolean;
  createdAt: Date;
}

export interface MessageDoc {
  _id: string;
  conversationId: string;
  seq: number;
  role: 'user' | 'agent' | 'event';
  text: string;
  source: 'text' | 'voice';
  provider?: string;
  model?: string;
  executionId?: string;
  generating: boolean;
  steps: unknown[];
  at: Date;
  /** When an agent reply was finished; `at` is when its turn opened it. */
  endedAt?: Date;
}

export interface ExecutionDoc {
  _id: string;
  conversationId: string;
  triggerMessageId: string;
  provider: string;
  model: string | null;
  status: 'running' | 'completed' | 'stopped' | 'failed' | 'handed_off';
  providerSessionId: string | null;
  startedAt: Date;
  endedAt: Date | null;
  error: string | null;
}

export interface AskDoc {
  _id: string;
  conversationId: string;
  agentId: string;
  executionId: string | null;
  fingerprint: string;
  action: string;
  args: unknown;
  summary: string;
  connectionId?: string | null;
  status: 'open' | 'approved' | 'declined' | 'replied' | 'stopped';
  askedByProvider: string;
  answer: {
    by: string;
    source: 'button' | 'voice';
    scope: 'once' | 'conversation';
    transcript?: string;
    verdict?: string;
    at: Date;
  } | null;
  createdAt: Date;
}

export interface DecisionDoc {
  _id: string;
  conversationId: string;
  fingerprint: string;
  effect: 'approved' | 'declined';
  scope: 'once' | 'conversation';
  askId: string;
  by: string;
  at: Date;
  usedAt: Date | null;
}

export interface RuleDoc {
  _id: string;
  agentId: string | null;
  /** Every field present must match: `action` exactly, the patterns as case-insensitive regular expressions. */
  match: {
    action?: string; kind?: 'read' | 'write'; actionPattern?: string; argsPattern?: string;
    /** Tests on the action's own fields, such as amount >= 5000. Every one must hold. */
    conditions?: RuleCondition[];
  };
  effect: 'allow' | 'ask' | 'deny';
  /** What the rule covers, in plain words. */
  title?: string;
  reason: string;
  /** The sentence a person wrote, when the rule was made from one. */
  source?: string;
  createdBy?: string;
  createdAt?: Date;
}

export interface RuleCondition {
  /** The name of a field of the action, at any depth: amount, channel, recipient_email. */
  field: string;
  op: 'eq' | 'neq' | 'gte' | 'lte' | 'contains' | 'matches';
  value: string | number;
}

export interface ConnectionDoc {
  _id: string;
  agentId: string;
  ownerId: string;
  toolkit: string;
  status: 'pending' | 'active' | 'revoked';
  [key: string]: unknown;
}

export interface NoteDoc {
  _id: string;
  agentId: string;
  text: string;
  at: Date;
}

export const col = {
  agents: db.collection<AgentDoc>('agents'),
  connections: db.collection<ConnectionDoc>('connections'),
  rules: db.collection<RuleDoc>('rules'),
  conversations: db.collection<ConversationDoc>('conversations'),
  messages: db.collection<MessageDoc>('messages'),
  executions: db.collection<ExecutionDoc>('executions'),
  asks: db.collection<AskDoc>('asks'),
  decisions: db.collection<DecisionDoc>('decisions'),
  ledger: db.collection<any>('ledger'),
  notes: db.collection<NoteDoc>('notes'),
};
