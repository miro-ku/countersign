// One plain sentence per ledger entry or message: the text the database embeds
// and a person (or the agent) searches by meaning.
import type { Db } from 'mongodb';

export const PROVIDER_NAME: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };
const providerName = (p?: string) => (p ? PROVIDER_NAME[p] ?? p : 'an unknown provider');

const OUTCOME_WORDS: Record<string, string> = {
  allowed: 'allowed by a rule',
  denied: 'refused by the gateway',
  asked: 'asked the person for approval',
  approved: 'the person approved it',
  declined: 'the person refused it',
  executed: 'done',
  failed: 'tried and failed',
  undone: 'undone, reversed afterwards',
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** "SLACK_SEND_MESSAGE" → "Slack: send message"; "notes_add" → "add a note". */
export function actionWords(action: string): string {
  const own: Record<string, string> = {
    notes_add: 'add a note',
    notes_list: 'read the notes',
    record_search: 'search its own record',
    record_explain: 'look up the story of a past action',
    COMPOSIO_SEARCH_TOOLS: 'look for app tools',
    COMPOSIO_GET_TOOL_SCHEMAS: 'read app tool details',
  };
  if (own[action]) return own[action];
  const parts = action.toLowerCase().split('_').filter(Boolean);
  if (parts.length < 2) return action;
  const app = parts[0][0].toUpperCase() + parts[0].slice(1);
  return `${app}: ${parts.slice(1).join(' ')}`;
}

/** The arguments a person would search for, in a few words. */
export function argumentWords(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const a = args as Record<string, unknown>;
  const words: string[] = [];
  const s = (v: unknown) => (typeof v === 'string' ? v : Array.isArray(v) ? v.filter((x) => typeof x === 'string').join(', ') : '');
  const channel = s(a.channel ?? a.channel_name ?? a.channel_id);
  if (channel) words.push(`in ${channel.startsWith('#') || /^[CDG][A-Z0-9]{6,}$/.test(channel) ? channel : `#${channel}`}`);
  const to = s(a.to ?? a.recipient ?? a.recipient_email ?? a.recipients ?? a.email ?? a.user);
  if (to) words.push(`to ${to}`);
  const subject = s(a.subject ?? a.title);
  if (subject) words.push(`subject "${clip(subject, 160)}"`);
  const body = s(a.text ?? a.markdown_text ?? a.message ?? a.body ?? a.content);
  if (body) words.push(`"${clip(body, 300)}"`);
  const query = s(a.query);
  if (query) words.push(`for "${clip(query, 200)}"`);
  if (Array.isArray(a.queries)) {
    const uses = a.queries.map((q: any) => q?.use_case).filter((x: unknown) => typeof x === 'string');
    if (uses.length) words.push(`for "${clip(uses.join('; '), 200)}"`);
  }
  if (typeof a.id === 'string' && !words.length) words.push(`of ${a.id}`);
  return words.join(' ');
}

/** "miro (button, once)" → "miro (button, once)"; kept as written, it is already plain. */
const decider = (d?: string | null) => (d ? d : '');

export interface EntryLike {
  _id: string;
  conversationId: string;
  fingerprint: string;
  seq: number;
  provider: string;
  action: string;
  args?: unknown;
  outcome: string;
  ruleId?: string | null;
  decidedBy?: string | null;
  result?: any;
}

/**
 * "executed: Slack: send message in #demo "Refund for Acme approved" (post to
 * #demo: 'Refund for Acme approved'), on Claude Code, approved by miro (button, once)".
 */
export async function describeEntry(db: Db, e: EntryLike): Promise<string> {
  const ask = await db
    .collection<any>('asks')
    .find({ conversationId: e.conversationId, fingerprint: e.fingerprint })
    .sort({ createdAt: -1 })
    .limit(1)
    .next();
  let who = '';
  if (e.outcome === 'approved' || e.outcome === 'declined') {
    who = `${e.outcome} by ${decider(e.decidedBy)}`;
  } else if (e.outcome === 'undone') {
    who = `undone by ${decider(e.decidedBy) || 'the person'}`;
  } else if (e.outcome === 'denied') {
    const reason = e.result?.reason ? String(e.result.reason) : '';
    who = reason ? `refused: ${reason}` : 'refused';
  } else if (e.ruleId) {
    who = `allowed by the rule ${e.ruleId}`;
  } else if (e.outcome === 'executed' || e.outcome === 'failed') {
    // Executed without a rule: a person's answer let it through.
    const approval = await db
      .collection<any>('ledger')
      .find({ conversationId: e.conversationId, fingerprint: e.fingerprint, outcome: 'approved', seq: { $lt: e.seq } })
      .sort({ seq: -1 })
      .limit(1)
      .next();
    if (approval) who = `approved by ${decider(approval.decidedBy)}`;
  } else if (e.outcome === 'asked') {
    who = 'waiting for the person to answer';
  }
  const what = [actionWords(e.action), argumentWords(e.args)].filter(Boolean).join(' ');
  const summary = ask?.summary && !what.includes(ask.summary) ? ` (${clip(String(ask.summary), 200)})` : '';
  const failed = e.outcome === 'failed' && e.result?.error ? `, error: ${clip(String(e.result.error), 160)}` : '';
  return `${e.outcome} (${OUTCOME_WORDS[e.outcome] ?? e.outcome}): ${what}${summary}, on ${providerName(e.provider)}${who ? `, ${who}` : ''}${failed}`;
}

export function describeMessage(m: { role: string; text: string; source?: string; provider?: string }): string {
  const text = clip(m.text.replace(/\s+/g, ' ').trim(), 2000);
  if (m.role === 'user') return `The person ${m.source === 'voice' ? 'said aloud' : 'wrote'}: ${text}`;
  return `The agent replied on ${providerName(m.provider)}: ${text}`;
}

/** "Nov 14, 12:31 PM EST": how the agent says a time aloud. */
export function spokenTime(d: Date | string | undefined | null): string {
  if (!d) return 'an unknown time';
  return new Date(d).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
}
