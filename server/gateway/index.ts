// The gateway: the only tools a model gets. Every call is checked against
// decisions and rules, held while a person is asked, and written to the ledger.
import { randomBytes } from 'node:crypto';
import type { Hono } from 'hono';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Action, CallCtx, LedgerEntry, McpToolDef, Provider, ToolSource } from '../../shared/types.js';
import { client, col, db, newId, OWNER_ID, type AskDoc, type RuleDoc } from '../db.js';
import { changes } from '../changes.js';
import { createComposioSource, kindOf } from '../integrations/index.js';
import { appendLedger } from './ledger.js';
import { fingerprint } from './fingerprint.js';
import { isNotesTool, notesSource } from './notes.js';

const HOLD_MS = 4 * 60 * 1000;

const composioSource: ToolSource | null = createComposioSource(db);

// ── Tokens ───────────────────────────────────────────────────────

interface TokenInfo { agentId: string; conversationId: string; provider: Provider }
const tokens = new Map<string, TokenInfo>();

/** A gateway address for one provider session. */
export function mintToken(info: TokenInfo): string {
  const token = randomBytes(18).toString('base64url');
  tokens.set(token, info);
  return token;
}

export function revokeToken(token: string): void {
  tokens.delete(token);
}

// ── What the engine tells the gateway about running turns ────────

const running = new Map<string, { executionId: string; model: string | null }>();

export function setRunningExecution(conversationId: string, run: { executionId: string; model: string | null } | null) {
  if (run) running.set(conversationId, run);
  else running.delete(conversationId);
}

let onLateApproval: (ask: AskDoc) => void = () => {};
/** Called when an ask is approved after its call stopped waiting. */
export function whenLateApproval(fn: (ask: AskDoc) => void) {
  onLateApproval = fn;
}

// ── Sources ──────────────────────────────────────────────────────

async function sourcesFor(agentId: string): Promise<ToolSource[]> {
  const sources: ToolSource[] = [notesSource];
  if (composioSource) {
    const active = await col.connections.countDocuments({ agentId, status: 'active' });
    if (active > 0) sources.push(composioSource);
  }
  return sources;
}

async function toolMap(agentId: string): Promise<Map<string, { source: ToolSource; def: McpToolDef }>> {
  const map = new Map<string, { source: ToolSource; def: McpToolDef }>();
  for (const source of await sourcesFor(agentId)) {
    for (const def of await source.tools(agentId)) map.set(def.name, { source, def });
  }
  return map;
}

export function sourceForAction(action: string): ToolSource | null {
  if (isNotesTool(action)) return notesSource;
  return composioSource;
}

// ── Verdicts ─────────────────────────────────────────────────────

type Verdict =
  | { effect: 'allow'; ruleId?: string; onceDecision?: boolean }
  | { effect: 'deny'; reason: string; ruleId?: string }
  | { effect: 'ask'; ruleId?: string };

const strictness = { allow: 0, ask: 1, deny: 2 } as const;

/** The most specific rule: action over kind, then agent over default. */
function matchRule(rules: RuleDoc[], action: Action): RuleDoc | undefined {
  let best: RuleDoc | undefined;
  let bestScore = -1;
  for (const rule of rules) {
    const { action: name, kind } = rule.match ?? {};
    if (name !== undefined && name !== action.name) continue;
    if (kind !== undefined && kind !== action.kind) continue;
    if (name === undefined && kind === undefined) continue;
    const score = (name !== undefined ? 2 : 0) + (rule.agentId ? 1 : 0);
    if (score > bestScore) {
      best = rule;
      bestScore = score;
    }
  }
  return best;
}

async function verdictFor(conversationId: string, rules: RuleDoc[], action: Action, fp: string): Promise<Verdict> {
  if (action.connectionId) {
    const connection = await col.connections.findOne({ _id: action.connectionId } as any);
    if (!connection || connection.status !== 'active') {
      return { effect: 'deny', reason: 'The app connection it needs is not active.' };
    }
  }
  const decision = await col.decisions.findOne({ conversationId, fingerprint: fp });
  if (decision?.effect === 'declined') return { effect: 'deny', reason: 'They were asked and said no.' };
  if (decision?.effect === 'approved') return { effect: 'allow', onceDecision: decision.scope === 'once' };
  const rule = matchRule(rules, action);
  if (!rule) return { effect: 'ask' };
  if (rule.effect === 'deny') return { effect: 'deny', reason: rule.reason || 'A rule forbids it.', ruleId: rule._id };
  return { effect: rule.effect, ruleId: rule._id };
}

// ── Holding a call ───────────────────────────────────────────────

// How many calls are holding each ask (two providers can wait on the same one).
const held = new Map<string, number>();
const hold = (id: string) => held.set(id, (held.get(id) ?? 0) + 1);
const unhold = (id: string) => {
  const n = (held.get(id) ?? 1) - 1;
  if (n > 0) held.set(id, n);
  else held.delete(id);
};

type Release = 'approved' | 'declined' | 'replied' | 'stopped' | 'timeout' | 'moved';

// Held calls by conversation, so a switch can let go of the old provider's.
const holders = new Map<string, Set<{ provider: string; release: () => void }>>();

/** Lets go of a provider's held calls in a conversation. Their asks stay open. */
export function releaseHeldCalls(conversationId: string, provider: string) {
  for (const h of holders.get(conversationId) ?? []) if (h.provider === provider) h.release();
}

function waitForAnswers(askIds: string[], who: { conversationId: string; provider: string }, signal?: AbortSignal): Promise<Release> {
  return new Promise((resolve) => {
    const status = new Map<string, AskDoc['status']>();

    let settled = false;
    const settle = (result: Release) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      changes.off('change', onChange);
      holders.get(who.conversationId)?.delete(holder);
      for (const id of askIds) unhold(id);
      resolve(result);
    };
    const check = () => {
      const values = askIds.map((id) => status.get(id) ?? 'open');
      if (values.includes('stopped')) return settle('stopped');
      if (values.includes('declined')) return settle('declined');
      if (values.includes('replied')) return settle('replied');
      if (values.every((v) => v === 'approved')) return settle('approved');
    };
    const onChange = ({ kind, doc }: { kind: string; doc: AskDoc }) => {
      if (kind !== 'ask' || !askIds.includes(doc._id)) return;
      status.set(doc._id, doc.status);
      check();
    };
    const timer = setTimeout(() => settle('timeout'), HOLD_MS);
    changes.on('change', onChange);
    // The provider hung up (an interrupted turn): stop holding. The ask stays open.
    signal?.addEventListener('abort', () => settle('timeout'), { once: true });
    const holder = { provider: who.provider, release: () => settle('moved') };
    if (!holders.has(who.conversationId)) holders.set(who.conversationId, new Set());
    holders.get(who.conversationId)!.add(holder);
    // An answer may have landed before we started listening.
    col.asks.find({ _id: { $in: askIds } }).toArray().then((docs) => {
      for (const d of docs) if (!status.has(d._id)) status.set(d._id, d.status);
      check();
    });
  });
}

// ── One call ─────────────────────────────────────────────────────

interface ToolResult { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

const refuse = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

export async function handleCall(info: TokenInfo, tool: string, input: unknown, signal?: AbortSignal): Promise<ToolResult> {
  const { agentId, conversationId, provider } = info;
  const agent = await col.agents.findOne({ _id: agentId });
  if (!agent) return refuse('This agent no longer exists.');
  const run = running.get(conversationId);
  const ctx: CallCtx = { ownerId: OWNER_ID, agentId, conversationId, executionId: run?.executionId, provider };
  const base = {
    agentId, agentVersion: agent.version, conversationId, executionId: run?.executionId ?? null,
    provider, model: run?.model ?? null,
  };

  const entry = (await toolMap(agentId)).get(tool);
  const actions = entry?.source.actionsOf(tool, input, { agentId }) ?? null;
  if (!entry || !actions) {
    await appendLedger({ ...base, action: tool, kind: 'write', args: input, fingerprint: fingerprint(tool, input), outcome: 'denied', result: { reason: 'This tool is not offered.' } });
    return refuse(`${tool} is refused: this tool is not offered.`);
  }

  const rules = await col.rules.find({ agentId: { $in: [agentId, null] } }).toArray();
  const checked = await Promise.all(
    actions.map(async (action) => {
      const fp = fingerprint(action.name, action.args);
      return { action, fp, verdict: await verdictFor(conversationId, rules, action, fp) };
    }),
  );
  const ledgerOf = (c: (typeof checked)[number]) => ({
    ...base, action: c.action.name, kind: c.action.kind, args: c.action.args, fingerprint: c.fp,
    ruleId: c.verdict.ruleId ?? null, connectionId: c.action.connectionId ?? null,
  });

  const worst = checked.reduce((w, c) => (strictness[c.verdict.effect] > strictness[w] ? c.verdict.effect : w), 'allow' as Verdict['effect']);

  if (worst === 'deny') {
    const reasons: string[] = [];
    for (const c of checked) {
      if (c.verdict.effect !== 'deny') continue;
      await appendLedger({ ...ledgerOf(c), outcome: 'denied', result: { reason: c.verdict.reason } });
      reasons.push(`${c.action.summary}: refused. ${c.verdict.reason}`);
    }
    return refuse(reasons.join('\n'));
  }

  if (worst === 'ask') {
    const askIds: string[] = [];
    for (const c of checked) {
      if (c.verdict.effect !== 'ask') continue;
      const ask = await col.asks.findOneAndUpdate(
        { conversationId, fingerprint: c.fp, status: 'open' },
        {
          $setOnInsert: {
            _id: newId(), conversationId, agentId, executionId: run?.executionId ?? null,
            fingerprint: c.fp, action: c.action.name, args: c.action.args, summary: c.action.summary,
            status: 'open', askedByProvider: provider, answer: null, createdAt: new Date(),
          },
        },
        { upsert: true, returnDocument: 'after' },
      );
      askIds.push(ask!._id);
      hold(ask!._id); // before anything else, so an instant answer counts as answering this call
      await appendLedger({ ...ledgerOf(c), outcome: 'asked', result: { askId: ask!._id } });
    }
    const release = await waitForAnswers(askIds, { conversationId, provider }, signal);
    if (release === 'declined') return refuse('They were asked and said no.');
    if (release === 'replied') return refuse('They did not answer; they said something else. Read it and go on from there.');
    if (release === 'stopped') return refuse('The person stopped this turn.');
    if (release === 'timeout') return refuse('Waiting for approval. Stop here.');
    if (release === 'moved') return refuse('The conversation moved to another provider. Stop here.');
    // Approved: the answer wrote decisions; check again so once-approvals are consumed below.
    for (const c of checked) c.verdict = await verdictFor(conversationId, rules, c.action, c.fp);
    if (checked.some((c) => c.verdict.effect !== 'allow')) return refuse('Not every part of this was approved.');
  }

  // The whole call goes ahead: consume single-use approvals now. Only the
  // call that consumes one may use it.
  for (const c of checked) {
    if (c.verdict.effect === 'allow' && c.verdict.onceDecision) {
      const used = await col.decisions.findOneAndDelete({ conversationId, fingerprint: c.fp, scope: 'once', effect: 'approved' });
      if (!used) return refuse(`${c.action.summary}: that approval was already used. Ask again if it is still needed.`);
    } else if (c.verdict.effect === 'allow' && c.verdict.ruleId) {
      await appendLedger({ ...ledgerOf(c), outcome: 'allowed' });
    }
  }

  try {
    const result = await entry.source.run(tool, input, ctx);
    const source = entry.source;
    const undoable = (action: Action) =>
      source.undoable ? source.undoable(action) : typeof source.undo === 'function' && action.kind === 'write';
    for (const c of checked) {
      await appendLedger({ ...ledgerOf(c), outcome: 'executed', result, undoable: undoable(c.action) });
    }
    return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    for (const c of checked) await appendLedger({ ...ledgerOf(c), outcome: 'failed', result: { error: message } });
    return refuse(`${tool} failed: ${message}`);
  }
}

// ── Answering an ask ─────────────────────────────────────────────

export interface Answer {
  answer: 'approve' | 'decline';
  scope: 'once' | 'conversation';
  source: 'button' | 'voice';
  transcript?: string;
  verdict?: string;
}

export async function answerAsk(askId: string, a: Answer): Promise<{ ok: true; ask: AskDoc } | { ok: false; status: number; error: string }> {
  if (a.answer !== 'approve' && a.answer !== 'decline') return { ok: false, status: 400, error: 'answer must be approve or decline' };
  if (a.source === 'voice' && a.answer === 'approve' && a.verdict !== 'yes') {
    return { ok: false, status: 400, error: 'A spoken answer approves only when the judge said yes.' };
  }
  const approved = a.answer === 'approve';
  // A decline is always remembered for the whole conversation.
  const scope: 'once' | 'conversation' = approved && a.scope !== 'conversation' ? 'once' : 'conversation';
  const by = OWNER_ID;
  const at = new Date();
  const answer = { by, source: a.source ?? 'button', scope, transcript: a.transcript, verdict: a.verdict, at };

  const wasHeld = held.has(askId);
  // The answer and its decision commit together, so a held call released by
  // the change stream always finds the decision.
  let ask: AskDoc | null = null;
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      ask = await col.asks.findOneAndUpdate(
        { _id: askId, status: 'open' },
        { $set: { status: approved ? 'approved' : 'declined', answer } },
        { returnDocument: 'after', session },
      );
      if (!ask) return;
      await col.decisions.updateOne(
        { conversationId: ask.conversationId, fingerprint: ask.fingerprint },
        {
          $set: { effect: approved ? 'approved' : 'declined', scope, askId: ask._id, by, at, usedAt: null },
          $setOnInsert: { _id: newId() },
        },
        { upsert: true, session },
      );
    });
  } finally {
    await session.endSession();
  }
  if (!ask) return { ok: false, status: 409, error: 'This ask is not open.' };
  const done: AskDoc = ask;

  const agent = await col.agents.findOne({ _id: done.agentId });
  const action = { name: done.action, kind: isNotesTool(done.action) ? notesSource.actionsOf(done.action, done.args)![0].kind : kindOf(done.action) };
  await appendLedger({
    agentId: done.agentId, agentVersion: agent?.version ?? 1, conversationId: done.conversationId,
    executionId: done.executionId, provider: done.askedByProvider, action: action.name,
    kind: action.kind,
    args: done.args, fingerprint: done.fingerprint, outcome: approved ? 'approved' : 'declined',
    decidedBy: `${by} (${answer.source}${a.verdict ? `, judge: ${a.verdict}` : ''}, ${scope})`,
  });

  if (approved && !wasHeld) onLateApproval(done);
  return { ok: true, ask: done };
}

/** Mark open asks of a conversation (or of one execution) with a new status. */
export async function closeOpenAsks(filter: { conversationId: string; executionId?: string }, status: 'replied' | 'stopped') {
  await col.asks.updateMany({ ...filter, status: 'open' }, { $set: { status } });
}

// ── Undo ─────────────────────────────────────────────────────────

export async function undoLedgerEntry(id: string): Promise<{ ok: true; entry: unknown } | { ok: false; status: number; error: string }> {
  const entry = (await col.ledger.findOne({ _id: id })) as LedgerEntry | null;
  if (!entry) return { ok: false, status: 404, error: 'No such ledger entry.' };
  if (entry.outcome !== 'executed' || !entry.undoable) return { ok: false, status: 400, error: 'This entry cannot be undone.' };
  if (await col.ledger.findOne({ undoOf: id })) return { ok: false, status: 409, error: 'Already undone.' };
  const source = sourceForAction(entry.action);
  if (!source?.undo) return { ok: false, status: 400, error: 'Its source cannot undo.' };
  const agent = await col.agents.findOne({ _id: entry.agentId });
  const { _id, seq, at, ownerId, ...rest } = entry as any;
  try {
    const result = await source.undo(entry);
    const undone = await appendLedger({ ...rest, agentVersion: agent?.version ?? rest.agentVersion, outcome: 'undone', result, undoable: false, undoOf: id, decidedBy: OWNER_ID });
    return { ok: true, entry: undone };
  } catch (err) {
    return { ok: false, status: 500, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── The MCP endpoint ─────────────────────────────────────────────

export function registerGateway(app: Hono): void {
  app.all('/mcp/:token', async (c) => {
    const info = tokens.get(c.req.param('token'));
    if (!info) return c.json({ error: 'Unknown gateway token.' }, 404);

    const server = new Server({ name: 'gateway', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [...(await toolMap(info.agentId)).values()].map(({ def }) => def),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) =>
      handleCall(info, req.params.name, req.params.arguments ?? {}, c.req.raw.signal) as any,
    );
    // Stateless: a fresh server and transport per request.
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });
}
