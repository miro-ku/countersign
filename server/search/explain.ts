// The whole story of one ledger entry (or one message), as plain facts the
// agent can repeat: who asked, who approved, how, what ran, what came of it.
// It follows the links the data already has and stays inside one agent.
import type { Db } from 'mongodb';
import { actionWords, argumentWords, PROVIDER_NAME, spokenTime } from './describe.js';

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const json = (v: unknown, n = 400) => clip(typeof v === 'string' ? v : JSON.stringify(v) ?? '', n);
const prov = (p?: string | null) => (p ? PROVIDER_NAME[p] ?? p : 'unknown');

/** What a long app result says, briefly: the useful ids and whether it worked. */
function resultWords(result: any): string {
  if (result == null) return 'nothing was returned';
  const first = Array.isArray(result?.results) ? result.results[0] : null;
  if (first && typeof first === 'object' && 'successful' in first) {
    const data = first.data ?? {};
    const bits = [first.successful ? 'it succeeded' : `it failed${first.error ? `: ${json(first.error, 200)}` : ''}`];
    if (data.channel) bits.push(`channel ${data.channel}`);
    if (data.ts || data.message?.ts) bits.push(`message timestamp ${data.ts ?? data.message.ts}`);
    return bits.join(', ');
  }
  return json(result);
}

export async function explain(db: Db, agentId: string, id: string): Promise<{ facts: string[]; [k: string]: unknown }> {
  const ledger = db.collection<any>('ledger');
  const entry = await ledger.findOne({ _id: id, agentId });
  if (!entry) {
    const message = await db.collection<any>('messages').findOne({ _id: id });
    const conv = message && (await db.collection<any>('conversations').findOne({ _id: message.conversationId, agentId }));
    if (!message || !conv) return { facts: [`There is nothing with the id ${id} in this agent's record.`] };
    return explainMessage(db, message);
  }

  const facts: string[] = [];
  const what = [actionWords(entry.action), argumentWords(entry.args)].filter(Boolean).join(' ');
  facts.push(`Action: ${entry.action} — ${what}. This entry's outcome: ${entry.outcome}, at ${spokenTime(entry.at)}, in conversation ${entry.conversationId}.`);

  // The request that started the turn.
  const execution = entry.executionId ? await db.collection<any>('executions').findOne({ _id: entry.executionId }) : null;
  const trigger = execution?.triggerMessageId ? await db.collection<any>('messages').findOne({ _id: execution.triggerMessageId }) : null;
  if (trigger) {
    facts.push(`Requested by the person at ${spokenTime(trigger.at)}, ${trigger.source === 'voice' ? 'spoken aloud' : 'typed'}: "${clip(trigger.text, 500)}".`);
  } else {
    facts.push('The message that started this turn is not on record.');
  }

  // Every step this action went through in the conversation.
  const steps = await ledger
    .find({ conversationId: entry.conversationId, fingerprint: entry.fingerprint })
    .sort({ seq: 1 })
    .project({ _id: 1, seq: 1, at: 1, outcome: 1, decidedBy: 1, provider: 1, ruleId: 1 })
    .toArray();
  facts.push(
    `Its steps in this conversation: ${steps
      .map((s) => `${s.outcome} at ${spokenTime(s.at)}${s.decidedBy ? ` by ${s.decidedBy}` : ''}${s._id === entry._id ? ' (this entry)' : ''}`)
      .join('; ')}.`,
  );

  // The approval request and its answer.
  const asks = await db
    .collection<any>('asks')
    .find({ conversationId: entry.conversationId, fingerprint: entry.fingerprint, createdAt: { $lte: entry.at } })
    .sort({ createdAt: -1 })
    .limit(1)
    .toArray();
  const ask = asks[0];
  if (ask) {
    facts.push(`Approval was asked at ${spokenTime(ask.createdAt)} by the agent on ${prov(ask.askedByProvider)}: "${clip(ask.summary, 300)}".`);
    const a = ask.answer;
    if (a) {
      const how = a.source === 'voice'
        ? `by voice, saying "${clip(a.transcript ?? '', 300)}", and the judge's verdict was "${a.verdict ?? 'none'}"`
        : 'with the button';
      const scope = a.scope === 'conversation' ? 'for the rest of this conversation' : 'once, for this one action';
      facts.push(`${a.by} ${ask.status === 'approved' ? 'approved' : ask.status === 'declined' ? 'refused' : `answered (${ask.status})`} it at ${spokenTime(a.at)}, ${how}, ${scope}.`);
    } else {
      facts.push(`That request was not answered with a button or voice; it ended as "${ask.status}".`);
    }
  } else if (entry.ruleId) {
    facts.push('Nobody was asked: a rule decided it.');
  }

  if (entry.ruleId) {
    const rule = await db.collection<any>('rules').findOne({ _id: entry.ruleId });
    facts.push(`Rule applied: ${entry.ruleId}${rule ? ` (${rule.effect}: ${rule.reason})` : ''}.`);
  }
  if (entry.outcome === 'denied' && entry.result?.reason) facts.push(`Refused because: ${entry.result.reason}`);

  facts.push(`Ran on ${prov(entry.provider)}${entry.model ? `, model ${entry.model}` : ''}, agent version ${entry.agentVersion}.`);

  if (entry.connectionId) {
    const conn = await db.collection<any>('connections').findOne({ _id: entry.connectionId });
    facts.push(
      conn
        ? `Through the ${conn.toolkit} connection ${conn._id}, made by ${conn.ownerId} at ${spokenTime(conn.connectedAt ?? conn.createdAt)}, now ${conn.status}.`
        : `Through the connection ${entry.connectionId}, which is no longer on record.`,
    );
  }

  if (entry.outcome === 'executed' || entry.outcome === 'failed' || entry.outcome === 'undone') {
    facts.push(`Result: ${resultWords(entry.result)}.`);
  }

  if (entry.undoOf) {
    const original = await ledger.findOne({ _id: entry.undoOf });
    facts.push(`This entry undid ${entry.undoOf}${original ? `, which ran at ${spokenTime(original.at)}` : ''}; undone by ${entry.decidedBy ?? 'the person'}.`);
  } else {
    const undo = await ledger.findOne({ undoOf: entry._id });
    if (undo) facts.push(`It was undone later, at ${spokenTime(undo.at)}, by ${undo.decidedBy ?? 'the person'}.`);
    else if (entry.outcome === 'executed') facts.push('It has not been undone.');
  }

  return {
    facts,
    id: entry._id,
    conversationId: entry.conversationId,
    at: entry.at,
  };
}

async function explainMessage(db: Db, m: any) {
  const facts: string[] = [];
  facts.push(
    m.role === 'user'
      ? `The person ${m.source === 'voice' ? 'said aloud' : 'wrote'} at ${spokenTime(m.at)}: "${clip(m.text, 800)}".`
      : `The agent replied on ${prov(m.provider)}${m.model ? ` (${m.model})` : ''} at ${spokenTime(m.at)}: "${clip(m.text, 800)}".`,
  );
  const executions = await db.collection<any>('executions').find({ triggerMessageId: m._id }).project({ _id: 1 }).toArray();
  const ids = executions.map((e) => e._id).concat(m.executionId ? [m.executionId] : []);
  if (ids.length) {
    const acts = await db
      .collection<any>('ledger')
      .find({ executionId: { $in: ids }, action: { $nin: ['record_search', 'record_explain'] } })
      .sort({ seq: 1 })
      .toArray();
    if (acts.length) {
      facts.push(`Actions in that turn: ${acts.map((a) => `${a.action} ${a.outcome} at ${spokenTime(a.at)} (id ${a._id})`).join('; ')}.`);
    }
  }
  return { facts, id: m._id, conversationId: m.conversationId, at: m.at };
}
