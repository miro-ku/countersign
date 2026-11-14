// Searching one agent's record by meaning. A search never crosses agents: the
// agent filter is part of every query.
import type { Db } from 'mongodb';
import { RECORD, RECORD_INDEX } from './setup.js';
import { spokenTime } from './describe.js';

/** Below this the matches were unrelated in the real data (see the task's query table). */
export const MIN_SCORE = 0.6;

export interface Hit {
  id: string;
  kind: 'action' | 'message';
  text: string;
  at: Date;
  when: string;
  conversationId: string;
  outcome?: string;
  action?: string;
  role?: string;
  score: number;
}

export interface SearchOptions {
  limit?: number;
  kind?: 'action' | 'message';
  minScore?: number;
}

export async function searchRecord(db: Db, agentId: string, query: string, opts: SearchOptions = {}): Promise<Hit[]> {
  if (!agentId) throw new Error('A search needs an agent.');
  const q = query.trim();
  if (!q) return [];
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 10), 1), 50);
  const filter: Record<string, unknown> = { agentId };
  if (opts.kind) filter.kind = opts.kind;
  const rows = await db
    .collection(RECORD)
    .aggregate([
      {
        $vectorSearch: {
          index: RECORD_INDEX, path: 'text', query: { text: q }, filter,
          numCandidates: Math.max(150, limit * 20), limit,
        },
      },
      { $set: { score: { $meta: 'vectorSearchScore' } } },
    ])
    .toArray();
  const min = opts.minScore ?? MIN_SCORE;
  return rows
    .filter((r) => r.agentId === agentId && r.score >= min)
    .map((r) => ({
      id: String(r._id), kind: r.kind, text: r.text, at: r.at, when: spokenTime(r.at),
      conversationId: r.conversationId, outcome: r.outcome, action: r.action, role: r.role, score: r.score,
    }));
}
