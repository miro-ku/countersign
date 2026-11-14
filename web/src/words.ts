import { PROVIDER_LABEL, type LedgerRow, type Provider } from './types.ts';

export const capFirst = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const TOOLKIT_NAMES: Record<string, string> = { slack: 'Slack', gmail: 'Gmail', composio: 'Apps' };

/** "SLACK_FIND_CHANNELS" reads as "Slack: find channels". */
export function humanize(action: string): string {
  const name = action.replace(/^mcp__gateway__/, '');
  if (name === 'COMPOSIO_SEARCH_TOOLS') return 'look up which app tools to use';
  if (name === 'COMPOSIO_GET_TOOL_SCHEMAS') return 'read how to use the app tools';
  if (name === 'record_search') return 'search its own record';
  if (name === 'record_explain') return 'look up the story of one action';
  const [first, ...rest] = name.split('_');
  if (!rest.length) return name;
  const toolkit = TOOLKIT_NAMES[first.toLowerCase()];
  const words = (toolkit ? rest : [first, ...rest]).join(' ').toLowerCase();
  return toolkit ? `${toolkit}: ${words}` : words;
}

/** A summary in plain words; one that only repeats the action's name and arguments is reworded. */
export function plainSummary(summary: string | undefined | null, action: string): string {
  if (!summary || /^run [A-Z0-9_]+\b/.test(summary)) return humanize(action);
  return summary;
}

/** The single actions inside one tool call, as the gateway unpacks them. */
function actionsOf(name: string, input: unknown): Array<{ action: string; args: unknown }> {
  const tools = (input as { tools?: unknown } | null)?.tools;
  if (name === 'COMPOSIO_MULTI_EXECUTE_TOOL' && Array.isArray(tools)) {
    return tools.map((t) => ({ action: String(t?.tool_slug ?? ''), args: t?.arguments }));
  }
  return [{ action: name, args: input }];
}

/** What a tool call does, in the words a person was or would be asked about it. */
export function describeCall(toolName: string, input: unknown, ledger: LedgerRow[]): string {
  const name = toolName.replace(/^mcp__gateway__/, '');
  const parts = actionsOf(name, input).map(({ action, args }) => {
    const wanted = JSON.stringify(args);
    const row = ledger.find((e) => e.action === action && e.summary && JSON.stringify(e.args) === wanted);
    return plainSummary(row?.summary, action);
  });
  return capFirst(parts.join('; '));
}

export type StepStatus =
  | { tone: 'ok' | 'running' | 'waiting' | 'blocked' | 'quiet' | 'failed'; label: string; detail?: string };

/** How a refused or cut-off tool call reads: a refusal is the product working, not an error. */
export function refusalStatus(text: string): StepStatus {
  const rule = /refused\.\s*(.*?)\s*A rule forbids this/i.exec(text);
  if (rule || /rule forbids/i.test(text)) return { tone: 'blocked', label: 'Blocked by rule', detail: rule?.[1] || undefined };
  if (/asked and said no/i.test(text)) return { tone: 'blocked', label: 'Rejected by Miro' };
  const moved = /moved to ([a-z-]+)/i.exec(text);
  if (moved) return { tone: 'quiet', label: `Handed over to ${PROVIDER_LABEL[moved[1] as Provider] ?? moved[1]}` };
  if (/stopped/i.test(text)) return { tone: 'quiet', label: 'Stopped' };
  if (/said something else|did not answer/i.test(text)) return { tone: 'quiet', label: 'Not answered' };
  if (/waiting for approval/i.test(text)) return { tone: 'waiting', label: 'Still waiting for approval' };
  if (/not offered|not connected|revoked/i.test(text)) return { tone: 'blocked', label: 'Not allowed', detail: text };
  return { tone: 'failed', label: 'Failed', detail: text };
}

/** "miro (voice, judge: yes, conversation)" reads as "Miro, by voice (judged yes), for this conversation". */
export function deciderWords(decidedBy?: string | null): string | null {
  if (!decidedBy) return null;
  const m = /^([^()]+?)\s*\(([^)]*)\)/.exec(decidedBy);
  if (!m) return capFirst(decidedBy);
  const bits = m[2].split(',').map((b) => b.trim());
  const how = bits.includes('voice') ? 'by voice' : bits.includes('button') ? 'with the button' : '';
  const judged = bits.find((b) => b.startsWith('judge:'));
  const scope = bits.includes('conversation') ? 'for this conversation' : bits.includes('once') ? 'once' : '';
  return [capFirst(m[1]), how && `${how}${judged ? ` (judged ${judged.slice(6).trim()})` : ''}`, scope].filter(Boolean).join(', ');
}
