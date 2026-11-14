// Keeps `record` in step with the ledger and the messages: one sentence per
// ledger entry and per finished user or agent message. It listens to the
// change streams the server already runs and never touches the ledger write;
// a failure here is logged and picked up by the next catch-up.
import type { Db } from 'mongodb';
import { changes } from '../changes.js';
import { describeEntry, describeMessage } from './describe.js';
import { RECORD } from './setup.js';

/**
 * In the ledger, but not in what is searched: the agent's own look-ups and the
 * app-tool discovery calls (plumbing nobody asks about), and `allowed` steps,
 * whose `executed` entry already says which rule allowed them.
 */
const SKIP_ACTIONS = new Set(['record_search', 'record_explain', 'COMPOSIO_SEARCH_TOOLS', 'COMPOSIO_GET_TOOL_SCHEMAS']);
const skipped = (e: any) => SKIP_ACTIONS.has(e.action) || e.outcome === 'allowed';

const CATCH_UP_MS = 60_000;

export async function recordEntry(db: Db, e: any): Promise<void> {
  if (skipped(e)) return;
  const text = await describeEntry(db, e);
  await db.collection<any>(RECORD).updateOne(
    { _id: e._id },
    {
      $set: {
        kind: 'action', agentId: e.agentId, conversationId: e.conversationId, at: e.at,
        outcome: e.outcome, action: e.action, provider: e.provider ?? null, text,
      },
    },
    { upsert: true },
  );
}

const agentOfConversation = new Map<string, string>();
async function agentOf(db: Db, conversationId: string): Promise<string | null> {
  const known = agentOfConversation.get(conversationId);
  if (known) return known;
  const conv = await db.collection<any>('conversations').findOne({ _id: conversationId }, { projection: { agentId: 1 } });
  if (conv?.agentId) agentOfConversation.set(conversationId, conv.agentId);
  return conv?.agentId ?? null;
}

const searchable = (m: any) =>
  (m.role === 'user' || m.role === 'agent') && !m.generating && typeof m.text === 'string' && m.text.trim() !== '';

export async function recordMessage(db: Db, m: any): Promise<void> {
  if (!searchable(m)) return;
  const agentId = await agentOf(db, m.conversationId);
  if (!agentId) return;
  await db.collection<any>(RECORD).updateOne(
    { _id: m._id },
    {
      $set: {
        kind: 'message', agentId, conversationId: m.conversationId, at: m.at, role: m.role,
        provider: m.provider ?? null, text: describeMessage(m),
      },
    },
    { upsert: true },
  );
}

const missing = { $lookup: { from: RECORD, localField: '_id', foreignField: '_id', as: 'r', pipeline: [{ $project: { _id: 1 } }] } };

/** Everything that has no record yet. Returns how many were added. */
export async function catchUp(db: Db, opts: { all?: boolean } = {}): Promise<{ actions: number; messages: number }> {
  let actions = 0;
  let messages = 0;
  const entries = db.collection('ledger').aggregate([
    { $match: { action: { $nin: [...SKIP_ACTIONS] }, outcome: { $ne: 'allowed' } } }, ...(opts.all ? [] : [missing, { $match: { r: { $size: 0 } } }]), { $sort: { seq: 1 } },
  ]);
  for await (const e of entries) {
    await recordEntry(db, e);
    actions++;
  }
  const msgs = db.collection('messages').aggregate([
    { $match: { role: { $in: ['user', 'agent'] }, generating: false, text: { $ne: '' } } },
    ...(opts.all ? [] : [missing, { $match: { r: { $size: 0 } } }]),
  ]);
  for await (const m of msgs) {
    await recordMessage(db, m);
    messages++;
  }
  return { actions, messages };
}

let started = false;

export function startSearchWorker(db: Db): void {
  if (started) return;
  started = true;
  const fail = (what: string) => (err: unknown) =>
    console.error(`search: could not record ${what}, will retry:`, err instanceof Error ? err.message : err);

  changes.on('change', ({ kind, doc }: { kind: string; doc: any }) => {
    if (kind === 'ledger') recordEntry(db, doc).catch(fail(`ledger entry ${doc._id}`));
    else if (kind === 'message') recordMessage(db, doc).catch(fail(`message ${doc._id}`));
  });

  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      const n = await catchUp(db);
      if (n.actions || n.messages) console.log(`search: recorded ${n.actions} action(s) and ${n.messages} message(s) that had none`);
    } catch (err) {
      fail('the catch-up')(err);
    } finally {
      running = false;
    }
  };
  void sweep();
  setInterval(sweep, CATCH_UP_MS).unref();
}
