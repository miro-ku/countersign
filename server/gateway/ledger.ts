import type { LedgerOutcome, Provider } from '../../shared/types.js';
import { col, newId, nextSeq, OWNER_ID } from '../db.js';

export interface LedgerInput {
  agentId: string;
  agentVersion: number;
  conversationId: string;
  executionId?: string | null;
  provider: Provider | string;
  model?: string | null;
  action: string;
  /** The action in plain words, as a person was or would be asked about it. */
  summary?: string | null;
  kind: 'read' | 'write';
  args: unknown;
  fingerprint: string;
  ruleId?: string | null;
  outcome: LedgerOutcome;
  decidedBy?: string | null;
  connectionId?: string | null;
  result?: unknown;
  undoable?: boolean;
  undoOf?: string | null;
}

/** The ledger is append-only: this is the only write it ever gets. */
export async function appendLedger(entry: LedgerInput) {
  const doc = {
    _id: newId(),
    seq: await nextSeq('ledger'),
    at: new Date(),
    ownerId: OWNER_ID,
    ...entry,
    undoable: entry.undoable ?? false,
  };
  await col.ledger.insertOne(doc);
  return doc;
}
