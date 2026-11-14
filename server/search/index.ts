// Searching the record by meaning: the ledger's actions and the conversations'
// messages, one sentence each, embedded by the database.
//
// The server wires it with:
//   registerSearchRoutes(api, db)      where the API routes are registered
//   startSearchWorker(db)              after the change streams start
//   createRecordSource(db)             as a gateway tool source
//   RECORD_PROMPT_LINE                 in the agent's system prompt
import type { Hono } from 'hono';
import type { Db } from 'mongodb';
import { searchRecord } from './query.js';

export { startSearchWorker, catchUp } from './worker.js';
export { createRecordSource, isRecordTool, RECORD_PROMPT_LINE, RECORD_TOOLS } from './source.js';
export { setupSearch } from './setup.js';
export { searchRecord, MIN_SCORE } from './query.js';

/** `GET /ledger/search?q=&agentId=&limit=`: the matching ledger entries, best first. */
export function registerSearchRoutes(api: Hono, db: Db): void {
  api.get('/ledger/search', async (c) => {
    const q = c.req.query('q') ?? '';
    const agentId = c.req.query('agentId') ?? '';
    if (!agentId) return c.json({ error: 'agentId is required: a search never crosses agents' }, 400);
    const limit = Number(c.req.query('limit') ?? 10) || 10;
    const kind = c.req.query('kind') === 'message' ? 'message' : c.req.query('kind') === 'any' ? undefined : 'action';
    const hits = await searchRecord(db, agentId, q, { limit, kind });
    const ids = hits.filter((h) => h.kind === 'action').map((h) => h.id);
    const entries = new Map((await db.collection<any>('ledger').find({ _id: { $in: ids }, agentId }).toArray()).map((e) => [e._id, e]));
    return c.json(
      hits
        .map((h) => ({ entry: entries.get(h.id) ?? null, kind: h.kind, id: h.id, score: h.score, text: h.text, at: h.at }))
        .filter((r) => r.kind === 'message' || r.entry),
    );
  });
}
