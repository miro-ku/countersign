// The apps an agent is connected to, served to the gateway as one tool source.
//
// Every agent is its own Composio user (`agent_<agentId>`). Its tools are the
// three Tool Router meta-tools of a session limited to the toolkits it has
// connected, with code execution, proxy calls and connection management off.
import { config } from 'dotenv';
import { Composio } from '@composio/core';
import type { Db } from 'mongodb';
import type { Action, CallCtx, LedgerEntry, McpToolDef, ToolSource } from '../../shared/types.js';

config({ quiet: true });

export const SEARCH = 'COMPOSIO_SEARCH_TOOLS';
export const SCHEMAS = 'COMPOSIO_GET_TOOL_SCHEMAS';
export const MULTI = 'COMPOSIO_MULTI_EXECUTE_TOOL';
/** The only tools ever listed, whatever a session returns. */
export const LISTED = new Set([SEARCH, SCHEMAS, MULTI]);

/** Toolkits a person may connect today. */
export const TOOLKITS = ['slack', 'gmail'] as const;
export type Toolkit = (typeof TOOLKITS)[number];

const SLACK_POST = 'SLACK_SEND_MESSAGE';
const SLACK_DELETE = 'SLACK_DELETES_A_MESSAGE_FROM_A_CHAT';

export interface ConnectionRecord {
  _id: string;
  agentId: string;
  ownerId: string;
  toolkit: string;
  composioUserId: string;
  composioAccountId?: string | null;
  status: 'pending' | 'active' | 'revoked';
  connectedAt?: Date | null;
  revokedAt?: Date | null;
  createdAt?: Date;
}

export function composioUserId(agentId: string): string {
  return `agent_${agentId}`;
}

export function connectionsOf(db: Db) {
  return db.collection<ConnectionRecord>('connections');
}

let client: Composio | null | undefined;
/** One client per process; null when the key is missing. */
export function composioClient(): Composio | null {
  if (client !== undefined) return client;
  const apiKey = process.env.COMPOSIO_API_KEY;
  client = apiKey ? new Composio({ apiKey, allowTracking: false }) : null;
  return client;
}

// ── Auth configs ─────────────────────────────────────────────────

const authConfigIds = new Map<string, string>();

/** The project's Composio-managed auth config for a toolkit, made on first use. */
export async function ensureAuthConfig(composio: Composio, toolkit: string): Promise<string> {
  const known = authConfigIds.get(toolkit);
  if (known) return known;
  const list = await composio.authConfigs.list({ toolkit });
  const existing = list.items.find((a: any) => a.isComposioManaged && a.status !== 'DISABLED') ?? list.items[0];
  const id = existing
    ? existing.id
    : (await composio.authConfigs.create(toolkit, { type: 'use_composio_managed_auth', name: `${toolkit} (managed)` })).id;
  authConfigIds.set(toolkit, id);
  return id;
}

// ── Actions ──────────────────────────────────────────────────────

const READ_VERBS = ['GET', 'LIST', 'FETCH', 'SEARCH', 'FIND', 'READ', 'RETRIEVE', 'QUERY', 'DESCRIBE', 'VIEW'];
const WRITE_VERBS = ['SEND', 'PUBLISH', 'FORWARD', 'DELETE', 'TRASH', 'REMOVE', 'CREATE', 'UPDATE', 'POST', 'REPLY'];

/** read when the slug names a read verb and no write verb; otherwise write. */
export function kindOf(slug: string): 'read' | 'write' {
  const s = slug.toUpperCase();
  const has = (verbs: string[]) => verbs.some((v) => s.includes(v));
  return has(READ_VERBS) && !has(WRITE_VERBS) ? 'read' : 'write';
}

/** The toolkit a slug belongs to: its first word, lower-cased. */
export function toolkitOf(slug: string): string {
  return slug.split('_')[0].toLowerCase();
}

function clip(text: string, max = 200): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v);
}

function channelName(channel: unknown): string {
  const c = str(channel).trim();
  if (!c) return 'a channel';
  if (c.startsWith('#') || c.startsWith('@')) return c;
  // Slack ids (C…, G…, D…) read as they are; names get the usual #.
  return /^[CGD][A-Z0-9]{6,}$/.test(c) ? c : `#${c}`;
}

/** Plain words a person can approve on a projector or hear on a call. */
export function summarize(slug: string, args: Record<string, unknown>): string {
  switch (slug) {
    case 'GMAIL_SEND_EMAIL': {
      const to = [args.recipient_email, ...(Array.isArray(args.extra_recipients) ? args.extra_recipients : [])]
        .map(str)
        .filter(Boolean)
        .join(', ');
      const subject = str(args.subject);
      return clip(`send an email to ${to || 'someone'}${subject ? ` with the subject '${subject}'` : ''}`);
    }
    case SLACK_POST: {
      const text = str(args.markdown_text ?? args.text ?? args.fallback_text);
      const where = channelName(args.channel);
      const thread = args.thread_ts ? ' (in a thread)' : '';
      return clip(text ? `post to ${where}${thread}: '${text}'` : `post a message to ${where}${thread}`);
    }
    case SLACK_DELETE:
      return clip(`delete the Slack message ${str(args.ts)} in ${channelName(args.channel)}`);
    case 'SLACK_LIST_ALL_CHANNELS':
      return 'list the Slack channels';
    default:
      return clip(`run ${slug} with ${JSON.stringify(args ?? {})}`);
  }
}

interface MultiEntry {
  tool_slug: string;
  arguments: Record<string, unknown>;
}

function multiEntries(input: unknown): MultiEntry[] | null {
  const tools = (input as { tools?: unknown })?.tools;
  if (!Array.isArray(tools) || tools.length === 0) return null;
  const out: MultiEntry[] = [];
  for (const t of tools) {
    const slug = (t as any)?.tool_slug;
    if (typeof slug !== 'string' || !slug) return null;
    // Meta-tools are never run from inside a multi-execute.
    if (slug.toUpperCase().startsWith('COMPOSIO_')) return null;
    const args = (t as any)?.arguments;
    out.push({ tool_slug: slug, arguments: args && typeof args === 'object' ? args : {} });
  }
  return out;
}

/** Which actions can be taken back: a posted Slack message. */
export function undoable(action: Pick<Action, 'name'>): boolean {
  return action.name === SLACK_POST;
}

// ── The source ───────────────────────────────────────────────────

export interface ComposioSource extends ToolSource {
  actionsOf(tool: string, input: unknown, ctx?: { agentId: string }): Action[] | null;
  undoable(action: Action): boolean;
}

interface SessionEntry {
  key: string;
  sessionId: string;
  tools: McpToolDef[];
  at: number;
}

const SESSION_TTL_MS = 30 * 60_000;

export function createSource(db: Db, composio: Composio): ComposioSource {
  const connections = connectionsOf(db);
  const sessions = new Map<string, SessionEntry>();
  // The connection id for each toolkit, per agent, as of the last tools() call.
  // actionsOf is synchronous, so it reads this; run() re-checks the database.
  const known = new Map<string, Map<string, string>>();

  async function activeConnections(agentId: string) {
    const list = await connections.find({ agentId, status: 'active' }).sort({ connectedAt: -1 }).toArray();
    const byToolkit = new Map<string, ConnectionRecord>();
    for (const c of list) if (!byToolkit.has(c.toolkit)) byToolkit.set(c.toolkit, c);
    known.set(agentId, new Map([...byToolkit].map(([t, c]) => [t, c._id])));
    return byToolkit;
  }

  async function sessionFor(agentId: string, active: Map<string, ConnectionRecord>): Promise<SessionEntry> {
    const accounts = Object.fromEntries([...active].map(([t, c]) => [t, c.composioAccountId as string]));
    const key = JSON.stringify(Object.entries(accounts).sort());
    const cached = sessions.get(agentId);
    if (cached && cached.key === key && Date.now() - cached.at < SESSION_TTL_MS) return cached;
    const session = await composio.create(composioUserId(agentId), {
      toolkits: [...active.keys()],
      connectedAccounts: accounts,
      manageConnections: false,
      sandbox: { enable: false },
      proxyExecute: false,
    } as any);
    const raw = await composio.tools.getRawToolRouterSessionTools(session.sessionId);
    const tools = raw
      .filter((t: any) => LISTED.has(t.slug))
      .map((t: any) => ({
        name: t.slug as string,
        description: (t.description as string) ?? '',
        inputSchema: (t.inputParameters as Record<string, unknown>) ?? { type: 'object', properties: {} },
      }));
    const entry = { key, sessionId: session.sessionId, tools, at: Date.now() };
    sessions.set(agentId, entry);
    return entry;
  }

  /** The agent's session, made fresh when its connections changed. Throws when none is active. */
  async function liveSession(agentId: string) {
    const active = await activeConnections(agentId);
    if (active.size === 0) throw new Error('This agent has no connected apps.');
    const entry = await sessionFor(agentId, active);
    return { entry, active, session: await composio.use(entry.sessionId) };
  }

  function connectionFor(slug: string, agentId?: string): string | undefined {
    const toolkit = toolkitOf(slug);
    if (agentId) return known.get(agentId)?.get(toolkit);
    // actionsOf has no agent id: use whichever agent last listed this toolkit
    // only when exactly one did; otherwise run() fills it in.
    let found: string | undefined;
    for (const m of known.values()) {
      const id = m.get(toolkit);
      if (id) {
        if (found && found !== id) return undefined;
        found = id;
      }
    }
    return found;
  }

  return {
    id: 'composio',

    async tools(agentId) {
      const active = await activeConnections(agentId);
      if (active.size === 0) return [];
      return (await sessionFor(agentId, active)).tools;
    },

    // The optional third argument names the agent, so the connection id is that
    // agent's own; without it the id is filled in only when unambiguous.
    actionsOf(tool: string, input: unknown, ctx?: { agentId: string }) {
      if (tool === SEARCH) {
        const queries = (input as any)?.queries;
        const what = Array.isArray(queries) ? queries.map((q: any) => str(q?.use_case)).filter(Boolean).join('; ') : '';
        return [{ name: SEARCH, kind: 'read', args: input ?? {}, summary: clip(`look up app tools${what ? ` for: ${what}` : ''}`) }];
      }
      if (tool === SCHEMAS) {
        const slugs = (input as any)?.tool_slugs;
        const which = Array.isArray(slugs) ? slugs.map(str).join(', ') : '';
        return [{ name: SCHEMAS, kind: 'read', args: input ?? {}, summary: clip(`read how to use ${which || 'app tools'}`) }];
      }
      if (tool === MULTI) {
        const entries = multiEntries(input);
        if (!entries) return null;
        return entries.map((e) => {
          const action: Action = {
            name: e.tool_slug,
            kind: kindOf(e.tool_slug),
            args: e.arguments,
            summary: summarize(e.tool_slug, e.arguments),
          };
          const connectionId = connectionFor(e.tool_slug, ctx?.agentId);
          if (connectionId) action.connectionId = connectionId;
          return action;
        });
      }
      return null;
    },

    undoable,

    async run(tool, input, ctx: CallCtx) {
      if (!LISTED.has(tool)) throw new Error(`${tool} is not available.`);
      const { session, active } = await liveSession(ctx.agentId);

      if (tool === SEARCH || tool === SCHEMAS) {
        const res = await session.executeMeta(tool, (input ?? {}) as Record<string, unknown>);
        if (res.resultType !== 'completed') throw new Error(res.error || `${tool} failed.`);
        return res.data;
      }

      const entries = multiEntries(input);
      if (!entries) throw new Error('Nothing to run: give tools[] with a tool_slug for each.');
      // Every action needs its own app connected and active, right now.
      for (const e of entries) {
        if (!active.has(toolkitOf(e.tool_slug))) {
          throw new Error(`${e.tool_slug} needs ${toolkitOf(e.tool_slug)} connected to this agent, and it is not.`);
        }
      }
      const results = await Promise.all(
        entries.map(async (e) => {
          const connection = active.get(toolkitOf(e.tool_slug))!;
          try {
            const res = await session.execute(e.tool_slug, e.arguments);
            return {
              tool_slug: e.tool_slug,
              arguments: e.arguments,
              connectionId: connection._id,
              successful: res.resultType === 'completed',
              data: res.data,
              error: res.error ?? null,
              ...slackRef(e, res.data),
            };
          } catch (err) {
            return { tool_slug: e.tool_slug, arguments: e.arguments, connectionId: connection._id, successful: false, data: null, error: errorText(err) };
          }
        }),
      );
      const failed = results.filter((r) => !r.successful);
      if (failed.length === results.length) {
        throw new Error(failed.map((r) => `${r.tool_slug}: ${r.error || 'failed'}`).join('; '));
      }
      return { results };
    },

    async undo(entry: LedgerEntry) {
      if (entry.action !== SLACK_POST) throw new Error(`${entry.action} cannot be undone.`);
      const ref = findSlackRef(entry);
      if (!ref) throw new Error('This entry does not say which Slack message was posted.');
      const { session } = await liveSession(entry.agentId);
      const res = await session.execute(SLACK_DELETE, { channel: ref.channel, ts: ref.ts });
      if (res.resultType !== 'completed') throw new Error(res.error || 'Slack did not delete the message.');
      return { deleted: true, channel: ref.channel, ts: ref.ts };
    },
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** For a posted Slack message: the channel id and timestamp that name it. */
function slackRef(e: MultiEntry, data: unknown): { channel?: string; ts?: string } {
  if (e.tool_slug !== SLACK_POST || !data || typeof data !== 'object') return {};
  const d = data as any;
  const ts = d.ts ?? d.message?.ts ?? d.data?.ts;
  const channel = d.channel ?? d.data?.channel ?? e.arguments.channel;
  return typeof ts === 'string' && typeof channel === 'string' ? { channel, ts } : {};
}

/**
 * Reads the posted message back from a ledger entry. The entry's `result` is
 * either this action's own item ({ channel, ts }) or the whole call's
 * `{ results: [...] }`, in which case the item whose slug and arguments match
 * the entry is used.
 */
export function findSlackRef(entry: Pick<LedgerEntry, 'action' | 'args' | 'result'>): { channel: string; ts: string } | null {
  const r = entry.result as any;
  if (!r || typeof r !== 'object') return null;
  if (typeof r.channel === 'string' && typeof r.ts === 'string') return { channel: r.channel, ts: r.ts };
  const items: any[] = Array.isArray(r.results) ? r.results : [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const candidates = items.filter((i) => i?.tool_slug === entry.action && typeof i.ts === 'string');
  const hit = candidates.find((i) => same(i.arguments ?? i.args, entry.args)) ?? (candidates.length === 1 ? candidates[0] : null);
  return hit ? { channel: hit.channel, ts: hit.ts } : null;
}
