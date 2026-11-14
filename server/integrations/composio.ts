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
/** The apps a person can connect to an agent. `auth` says how the app is authorized. */
export const CATALOG = [
  { id: 'slack', name: 'Slack', auth: 'oauth' },
  { id: 'gmail', name: 'Gmail', auth: 'oauth' },
  // Stripe is connected with an API key, so a test-mode key keeps it away from real money.
  { id: 'stripe', name: 'Stripe', auth: 'api_key' },
  { id: 'github', name: 'GitHub', auth: 'oauth' },
  { id: 'notion', name: 'Notion', auth: 'oauth' },
  { id: 'googlecalendar', name: 'Google Calendar', auth: 'oauth' },
  { id: 'linear', name: 'Linear', auth: 'oauth' },
  { id: 'hubspot', name: 'HubSpot', auth: 'oauth' },
] as const;
export const TOOLKITS = CATALOG.map((t) => t.id);
export type Toolkit = (typeof CATALOG)[number]['id'];
export const logoOf = (toolkit: string) => `https://logos.composio.dev/api/${toolkit}`;
const nameOf = (toolkit: string) => CATALOG.find((t) => t.id === toolkit)?.name ?? toolkit;

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

/** A managed config asking only for what the demo uses (Slack: 5 scopes instead of 47). */
export const NARROW_SUFFIX = ' (demo scopes)';
const narrowWanted = () => process.env.COMPOSIO_NARROW_SCOPES === '1';

/**
 * The project's Composio-managed auth config for a toolkit, made on first use.
 * With COMPOSIO_NARROW_SCOPES=1, the "<toolkit> (demo scopes)" config is used
 * when one exists; otherwise always the full one.
 */
export async function ensureAuthConfig(composio: Composio, toolkit: string): Promise<string> {
  const known = authConfigIds.get(toolkit);
  if (known) return known;
  const list = await composio.authConfigs.list({ toolkit });
  const usable = list.items.filter((a: any) => a.status !== 'DISABLED');
  const isNarrow = (a: any) => String(a.name ?? '').endsWith(NARROW_SUFFIX);
  const narrow = narrowWanted() ? usable.find((a: any) => a.isComposioManaged && isNarrow(a)) : undefined;
  const existing = narrow ?? usable.find((a: any) => a.isComposioManaged && !isNarrow(a)) ?? usable.find((a: any) => !isNarrow(a));
  const byKey = CATALOG.find((t) => t.id === toolkit)?.auth === 'api_key';
  if (byKey) {
    // The person types the key on the authorization page; we never see or keep it.
    const keyed = usable.find((a: any) => !a.isComposioManaged && String(a.authScheme ?? '').toUpperCase() === 'API_KEY');
    const id = keyed
      ? keyed.id
      : (await composio.authConfigs.create(toolkit, { type: 'use_custom_auth', authScheme: 'API_KEY', credentials: {}, name: `${toolkit} (api key)` } as any)).id;
    authConfigIds.set(toolkit, id);
    return id;
  }
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

const SLACK_ID = /^[CGD][A-Z0-9]{6,}$/;

/** A channel id's name, when known. */
export type ChannelNames = (id: string) => string | undefined;

function channelName(channel: unknown, names?: ChannelNames): string {
  const c = str(channel).trim();
  if (!c) return 'a channel';
  if (c.startsWith('#') || c.startsWith('@')) return c;
  if (!SLACK_ID.test(c)) return `#${c}`;
  // A Slack id reads as its name when we know it, and as the id otherwise.
  const name = names?.(c);
  return name ? `#${name}` : c;
}

/** Money as a person says it: Stripe counts in the smallest unit. */
function money(amount: unknown, currency: unknown): string | null {
  const n = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(n)) return null;
  return `${(n / 100).toFixed(2)} ${str(currency || 'usd').toUpperCase()}`;
}

/** Any app's action in words: "Stripe: create refund, 20.00 USD, charge ch_123". */
function generic(slug: string, args: Record<string, unknown>): string {
  const toolkit = toolkitOf(slug);
  const verb = slug.split('_').slice(1).join(' ').toLowerCase() || slug.toLowerCase();
  const facts: string[] = [];
  if (args.amount !== undefined) facts.push(toolkit === 'stripe' ? (money(args.amount, args.currency) ?? `amount ${str(args.amount)}`) : `amount ${str(args.amount)}`);
  for (const key of ['customer', 'email', 'charge', 'payment_intent', 'invoice', 'title', 'name', 'subject', 'to', 'query', 'repo', 'summary']) {
    const value = args[key];
    if (facts.length >= 4) break;
    if (typeof value === 'string' && value) facts.push(`${key.replace(/_/g, ' ')} ${value}`);
  }
  return `${nameOf(toolkit)}: ${verb}${facts.length ? `, ${facts.join(', ')}` : ''}`;
}

/** Plain words a person can approve on a projector or hear on a call. */
export function summarize(slug: string, args: Record<string, unknown>, names?: ChannelNames): string {
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
      const where = channelName(args.channel, names);
      const thread = args.thread_ts ? ' (in a thread)' : '';
      return clip(text ? `post to ${where}${thread}: '${text}'` : `post a message to ${where}${thread}`);
    }
    case SLACK_DELETE:
      return clip(`delete the Slack message ${str(args.ts)} in ${channelName(args.channel, names)}`);
    case 'SLACK_LIST_ALL_CHANNELS':
      return 'list the Slack channels';
    default:
      return clip(generic(slug, args ?? {}));
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
const CHANNELS_TTL_MS = 10 * 60_000;
const CHANNELS_WAIT_MS = 4000;

interface ChargeInfo { amount: number; currency: string; description: string; paymentIntent?: string }

export function createSource(db: Db, composio: Composio): ComposioSource {
  const connections = connectionsOf(db);
  const sessions = new Map<string, SessionEntry>();
  // The connection id for each toolkit, per agent, as of the last tools() call.
  // actionsOf is synchronous, so it reads this; run() re-checks the database.
  const known = new Map<string, Map<string, string>>();
  // Stripe charges by id, per connection, learned from Stripe results.
  const charges = new Map<string, Map<string, ChargeInfo>>();
  // Slack channel names by id, per connection, learned from Slack results.
  const channels = new Map<string, { names: Map<string, string>; at: number }>();

  function learnChannels(connectionId: string, data: unknown) {
    let entry = channels.get(connectionId);
    const seen = new Set<unknown>();
    const walk = (v: unknown, depth: number) => {
      if (!v || typeof v !== 'object' || depth > 6 || seen.has(v)) return;
      seen.add(v);
      if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
      const o = v as Record<string, unknown>;
      if (typeof o.id === 'string' && SLACK_ID.test(o.id) && typeof o.name === 'string' && o.name) {
        if (!entry) channels.set(connectionId, (entry = { names: new Map(), at: Date.now() }));
        entry.names.set(o.id, o.name);
      }
      for (const x of Object.values(o)) walk(x, depth + 1);
    };
    walk(data, 0);
  }

  /** What we have seen of Stripe charges, so a refund can be named by its amount and purpose. */
  function learnCharges(connectionId: string, data: unknown) {
    let seen = charges.get(connectionId);
    const visited = new Set<unknown>();
    const walk = (v: unknown, depth: number) => {
      if (!v || typeof v !== 'object' || depth > 7 || visited.has(v)) return;
      visited.add(v);
      if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
      const o = v as Record<string, unknown>;
      if (typeof o.id === 'string' && /^ch_/.test(o.id) && typeof o.amount === 'number') {
        if (!seen) charges.set(connectionId, (seen = new Map()));
        seen.set(o.id, {
          amount: o.amount,
          currency: typeof o.currency === 'string' ? o.currency : 'usd',
          description: typeof o.description === 'string' ? o.description : '',
          paymentIntent: typeof o.payment_intent === 'string' ? o.payment_intent : undefined,
        });
      }
      for (const x of Object.values(o)) walk(x, depth + 1);
    };
    walk(data, 0);
  }

  /** The charge a refund is aimed at, whether it was named by charge or by payment. */
  function chargeFor(agentId: string | undefined, args: Record<string, unknown>): { id: string; info?: ChargeInfo } | undefined {
    const connectionId = connectionFor('STRIPE_', agentId);
    const seen = connectionId ? charges.get(connectionId) : undefined;
    if (typeof args.charge === 'string' && args.charge) return { id: args.charge, info: seen?.get(args.charge) };
    if (typeof args.payment_intent === 'string' && args.payment_intent) {
      for (const [id, info] of seen ?? []) if (info.paymentIntent === args.payment_intent) return { id, info };
      return { id: args.payment_intent };
    }
    return undefined;
  }

  /** Loads the channel list of a Slack connection once, so ids read as names in asks. */
  async function primeChannels(agentId: string, connection: ConnectionRecord) {
    const cached = channels.get(connection._id);
    if (cached && Date.now() - cached.at < CHANNELS_TTL_MS) return;
    const load = (async () => {
      const { session } = await liveSession(agentId);
      const res = await session.execute('SLACK_LIST_ALL_CHANNELS', { limit: 200, exclude_archived: true, types: 'public_channel,private_channel' });
      if (res.resultType !== 'completed') return;
      channels.set(connection._id, { names: channels.get(connection._id)?.names ?? new Map(), at: Date.now() });
      learnChannels(connection._id, res.data);
    })().catch(() => {});
    // An empty cache waits a little; a stale one refreshes in the background.
    if (!cached) await Promise.race([load, new Promise((r) => setTimeout(r, CHANNELS_WAIT_MS))]);
  }

  /** The id of a Slack channel given as an id, a name or "#name"; undefined when unknown. */
  function channelIdFor(agentId: string | undefined, channel: string): string | undefined {
    if (SLACK_ID.test(channel)) return channel;
    const wanted = channel.replace(/^#/, '').trim().toLowerCase();
    const connectionId = connectionFor('SLACK_', agentId);
    const caches = connectionId ? [channels.get(connectionId)] : [...channels.values()];
    for (const cache of caches) {
      for (const [id, name] of cache?.names ?? []) {
        if (name.toLowerCase() === wanted) return id;
      }
    }
    return undefined;
  }

  /**
   * The arguments in one canonical form, so the same action has the same
   * fingerprint whichever engine worded the call: empty values dropped, a
   * Slack channel as its id, and a message's text under one key.
   */
  function identityOf(slug: string, args: Record<string, unknown>, agentId?: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args ?? {})) {
      if (value === null || value === undefined || value === '') continue;
      out[key] = typeof value === 'string' ? value.trim() : value;
    }
    if (toolkitOf(slug) === 'stripe' && /REFUND/.test(slug) && /CREATE/.test(slug)) {
      // A refund is the same refund whatever reason or note was attached:
      // what counts is which charge, and how much.
      const target = chargeFor(agentId, args);
      const amount = typeof args.amount === 'number' ? args.amount : target?.info?.amount;
      return { charge: target?.id ?? null, ...(amount !== undefined ? { amount } : {}) };
    }
    if (toolkitOf(slug) === 'slack') {
      if (typeof out.channel === 'string') out.channel = channelIdFor(agentId, out.channel) ?? out.channel.replace(/^#/, '').toLowerCase();
      const text = out.markdown_text ?? out.text;
      if (typeof text === 'string') {
        delete out.markdown_text;
        out.text = text;
      }
    }
    return out;
  }

  /** A refund in the words a person approves: how much, for what. */
  function refundWords(slug: string, args: Record<string, unknown>, agentId?: string): string | null {
    if (toolkitOf(slug) !== 'stripe' || !/REFUND/.test(slug) || !/CREATE/.test(slug)) return null;
    const target = chargeFor(agentId, args);
    const amount = typeof args.amount === 'number' ? args.amount : target?.info?.amount;
    const sum = amount !== undefined ? money(amount, target?.info?.currency) : null;
    const what = target?.info?.description ? ` for '${target.info.description}'` : '';
    const partial = typeof args.amount === 'number' && target?.info && args.amount < target.info.amount ? ' (part of the charge)' : '';
    return clip(`refund ${sum ?? 'a charge'}${what}${partial}${target ? `, charge ${target.id}` : ''}`);
  }

  function namesFor(agentId?: string): ChannelNames {
    return (id) => {
      const connectionId = connectionFor('SLACK_', agentId);
      if (connectionId) return channels.get(connectionId)?.names.get(id);
      for (const c of channels.values()) {
        const n = c.names.get(id);
        if (n) return n;
      }
      return undefined;
    };
  }

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
      const entry = await sessionFor(agentId, active);
      const slack = active.get('slack');
      if (slack) await primeChannels(agentId, slack);
      return entry.tools;
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
            identity: identityOf(e.tool_slug, e.arguments, ctx?.agentId),
            summary: refundWords(e.tool_slug, e.arguments, ctx?.agentId) ?? summarize(e.tool_slug, e.arguments, namesFor(ctx?.agentId)),
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
            if (toolkitOf(e.tool_slug) === 'slack') learnChannels(connection._id, res.data);
            if (toolkitOf(e.tool_slug) === 'stripe') learnCharges(connection._id, res.data);
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
