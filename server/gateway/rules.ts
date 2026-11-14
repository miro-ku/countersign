// Rules: which actions are allowed, asked about or denied, by name and by content.
import type { Action } from '../../shared/types.js';
import { col, type RuleDoc } from '../db.js';

const strictness = { allow: 0, ask: 1, deny: 2 } as const;

/** Throws when a rule's patterns are not valid regular expressions. */
export function checkRule(rule: Pick<RuleDoc, 'match'>): void {
  const { actionPattern, argsPattern } = rule.match ?? {};
  for (const [name, pattern] of [['actionPattern', actionPattern], ['argsPattern', argsPattern]] as const) {
    if (pattern === undefined) continue;
    try {
      new RegExp(pattern, 'i');
    } catch (err) {
      throw new Error(`${name} is not a valid regular expression: ${(err as Error).message}`);
    }
  }
}

/** Action name or content over kind alone; an agent's own over a default. */
function specificity(rule: RuleDoc): number {
  const m = rule.match ?? {};
  const specific = m.action !== undefined || m.actionPattern !== undefined || m.argsPattern !== undefined;
  return (specific ? 2 : 0) + (rule.agentId ? 1 : 0);
}

/** Rules in the order they are applied: most specific first, then the strictest. */
export function rankRules(rules: RuleDoc[]): RuleDoc[] {
  return [...rules].sort(
    (a, b) => specificity(b) - specificity(a) || strictness[b.effect] - strictness[a.effect],
  );
}

/** The rules that apply to an agent (its own and the defaults), in the order they are applied. */
export async function rulesFor(agentId: string): Promise<RuleDoc[]> {
  return rankRules(await col.rules.find({ agentId: { $in: [agentId, null] } }).toArray());
}

function test(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern, 'i').test(text);
  } catch {
    return false; // refused when written; never matches if one slipped in
  }
}

/** A rule matches when every field it has matches. */
export function ruleMatches(rule: RuleDoc, action: Action): boolean {
  const m = rule.match ?? {};
  const fields = [m.action, m.kind, m.actionPattern, m.argsPattern].filter((f) => f !== undefined);
  if (!fields.length) return false;
  if (m.action !== undefined && m.action !== action.name) return false;
  if (m.kind !== undefined && m.kind !== action.kind) return false;
  if (m.actionPattern !== undefined && !test(m.actionPattern, action.name)) return false;
  if (m.argsPattern !== undefined && !test(m.argsPattern, JSON.stringify(action.args ?? null))) return false;
  return true;
}

/** The rule that decides an action, from rules already ranked. */
export function matchRule(ranked: RuleDoc[], action: Action): RuleDoc | undefined {
  return ranked.find((rule) => ruleMatches(rule, action));
}
