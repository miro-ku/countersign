// Rules: which actions are allowed, asked about or denied, by name and by content.
import type { Action } from '../../shared/types.js';
import { col, type RuleCondition, type RuleDoc } from '../db.js';

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
  for (const c of rule.match?.conditions ?? []) {
    if (!c.field || !OPS.includes(c.op)) throw new Error(`a condition needs a field and one of: ${OPS.join(', ')}`);
    if ((c.op === 'gte' || c.op === 'lte') && typeof c.value !== 'number') throw new Error(`${c.field} ${c.op} needs a number`);
    if (c.op === 'matches') {
      try {
        new RegExp(String(c.value), 'i');
      } catch (err) {
        throw new Error(`the pattern for ${c.field} is not valid: ${(err as Error).message}`);
      }
    }
  }
}

const OPS: RuleCondition['op'][] = ['eq', 'neq', 'gte', 'lte', 'contains', 'matches'];

/** Every value an action has under a field name, at any depth. */
function valuesOf(source: unknown, field: string, found: unknown[] = [], depth = 0): unknown[] {
  if (!source || typeof source !== 'object' || depth > 6) return found;
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (key === field && (typeof value !== 'object' || value === null)) found.push(value);
    else valuesOf(value, field, found, depth + 1);
  }
  return found;
}

function holds(c: RuleCondition, action: Action): boolean {
  // The canonical form first: it has facts the engine may have left out, such as a full refund's amount.
  const values = [...valuesOf(action.identity, c.field), ...valuesOf(action.args, c.field)];
  const text = (v: unknown) => String(v ?? '').toLowerCase();
  const wanted = text(c.value);
  if (c.op === 'neq') return values.length > 0 && values.every((v) => text(v) !== wanted);
  return values.some((v) => {
    if (c.op === 'eq') return text(v) === wanted;
    if (c.op === 'contains') return text(v).includes(wanted);
    if (c.op === 'matches') return test(String(c.value), String(v ?? ''));
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) && (c.op === 'gte' ? n >= Number(c.value) : n <= Number(c.value));
  });
}

/** Action name or content over kind alone; an agent's own over a default. */
function specificity(rule: RuleDoc): number {
  const m = rule.match ?? {};
  const specific = m.action !== undefined || m.actionPattern !== undefined || m.argsPattern !== undefined || !!m.conditions?.length;
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
  if (!fields.length && !m.conditions?.length) return false;
  if (m.action !== undefined && m.action !== action.name) return false;
  if (m.kind !== undefined && m.kind !== action.kind) return false;
  if (m.actionPattern !== undefined && !test(m.actionPattern, action.name)) return false;
  if (m.argsPattern !== undefined && !test(m.argsPattern, JSON.stringify(action.args ?? null)) && !test(m.argsPattern, JSON.stringify(action.identity ?? null))) return false;
  if (m.conditions?.some((c) => !holds(c, action))) return false;
  return true;
}

/** The rule that decides an action, from rules already ranked. */
export function matchRule(ranked: RuleDoc[], action: Action): RuleDoc | undefined {
  return ranked.find((rule) => ruleMatches(rule, action));
}
