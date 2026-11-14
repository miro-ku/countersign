// The conversation engine. The `messages` collection is the conversation; a
// provider's own session is only a cache that can be rebuilt from it.
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Provider, ProviderDriver, ProviderEvent, ProviderSession, Step } from '../shared/types.js';
import { col, newId, nextSeq, type ConversationDoc, type MessageDoc } from './db.js';
import { closeOpenAsks, hasTools, mintToken, releaseHeldCalls, revokeToken, setRunningExecution, whenLateApproval } from './gateway/index.js';
import { RECORD_PROMPT_LINE } from './search/index.js';

const PORT = Number(process.env.PORT || 4100);
const IDLE_MS = 15 * 60 * 1000;
const STREAM_THROTTLE_MS = 200;
const PERSON = 'Miro';

/** Added to every agent's instructions: how a turn is delivered. */
export const DELIVERY_NOTE =
  'How messages reach you: each turn arrives as lines tagged with who wrote them, such as [Miro], [Event], ' +
  '[Reply you gave on …] and [System]. The tags are only how the conversation is delivered to you, never part of ' +
  'what anyone said. Never mention, repeat or explain them. Answer the person directly and briefly. ' +
  'A line tagged as spoken on a call was said aloud, and your answer to it is read aloud: answer in one or two ' +
  'short sentences, the way you would say them, with no lists, tables, ids, links, symbols or formatting, and with ' +
  'money in words, such as 49 dollars. You are one agent whatever runs you: never mention engines or models.';

const STOP_NOTE =
  '[System] The previous turn was stopped part-way through by the person. A tool call still running then never returned: call it again if it is still needed.';

// ── Drivers ──────────────────────────────────────────────────────

const drivers = new Map<string, ProviderDriver>();

export function registerDriver(driver: ProviderDriver, name: string = driver.name) {
  drivers.set(name, driver);
}

export function knownProviders(): string[] {
  return [...drivers.keys()];
}

// ── Warm sessions: one per conversation#provider ─────────────────

interface Warm {
  session: ProviderSession;
  events: AsyncIterator<ProviderEvent>;
  token: string;
  instructionsHash: string;
  sessionId: string | null;
  model: string | null;
  idle: NodeJS.Timeout | null;
}

const warm = new Map<string, Warm>();

async function retire(key: string) {
  const w = warm.get(key);
  if (!w) return;
  warm.delete(key);
  if (w.idle) clearTimeout(w.idle);
  revokeToken(w.token);
  await w.session.close().catch(() => {});
}

export async function closeAllSessions() {
  await Promise.all([...warm.keys()].map(retire));
}

function scratchDir(conversationId: string): string {
  const dir = join(tmpdir(), 'governed-agents', conversationId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Messages ─────────────────────────────────────────────────────

export async function insertMessage(m: Omit<MessageDoc, '_id' | 'seq' | 'at' | 'generating' | 'steps'> & Partial<MessageDoc>) {
  const doc: MessageDoc = {
    _id: newId(),
    seq: await nextSeq(`messages:${m.conversationId}`),
    at: new Date(),
    generating: false,
    steps: [],
    ...m,
  } as MessageDoc;
  await col.messages.insertOne(doc);
  return doc;
}

/** Renders messages as the lines a provider reads. Continuations are indented so a body cannot forge a tag. */
export function renderNews(messages: MessageDoc[], provider: string): string {
  const lines: string[] = [];
  for (const m of messages) {
    let tag: string;
    if (m.role === 'user') tag = m.source === 'voice' ? `[${PERSON}, spoken on a call]` : `[${PERSON}]`;
    else if (m.role === 'event') tag = '[Event]';
    else if (m.provider !== provider) tag = `[Reply you gave on ${m.provider}]`;
    else continue; // its own reply: it already has it
    const [first, ...rest] = (m.text || '').split('\n');
    lines.push(`${tag} ${first}`, ...rest.map((l) => `  ${l}`));
  }
  return lines.join('\n');
}

// ── Turns ────────────────────────────────────────────────────────

interface Running {
  executionId: string;
  provider: string;
  key: string;
  /** How the turn is being ended early, if it is. */
  ending: 'stopped' | 'handed_off' | null;
  /** The provider it was handed to. */
  handedTo?: string;
}

const running = new Map<string, Running>();
const pending = new Set<string>();
const looping = new Set<string>();

/** Starts a turn if none is running; otherwise the waiting messages become the next turn. */
export function kick(conversationId: string) {
  pending.add(conversationId);
  void loop(conversationId);
}

// One loop per conversation runs its turns one after another; every path that
// starts a turn (a message, a switch, a late approval) only marks it pending.
async function loop(conversationId: string) {
  if (looping.has(conversationId)) return;
  looping.add(conversationId);
  try {
    while (pending.has(conversationId)) {
      pending.delete(conversationId);
      try {
        await runTurn(conversationId);
      } catch (err) {
        console.error('turn failed:', err);
      }
    }
  } finally {
    looping.delete(conversationId);
  }
}

async function runTurn(conversationId: string) {
  const conversation = await col.conversations.findOne({ _id: conversationId });
  if (!conversation) return;
  const agent = await col.agents.findOne({ _id: conversation.agentId });
  if (!agent) return;
  const p = conversation.provider;
  const driver = drivers.get(p);
  const key = `${conversationId}#${p}`;
  const rec = conversation.providerSessions?.[p];

  // The newest message from the person or an event triggers the turn.
  const trigger = await col.messages.find({ conversationId, role: { $in: ['user', 'event'] } }).sort({ seq: -1 }).limit(1).next();
  if (!trigger) return;
  // Nothing waiting: the newest reply already came after it.
  const lastReply = await col.messages.find({ conversationId, role: 'agent' }).sort({ seq: -1 }).limit(1).next();
  if (lastReply && lastReply.seq > trigger.seq) return;

  const executionId = newId();
  const run: Running = { executionId, provider: p, key, ending: null };
  running.set(conversationId, run);

  try {
    await col.executions.insertOne({
    _id: executionId, conversationId, triggerMessageId: trigger._id, provider: p, model: null,
    status: 'running', providerSessionId: null, startedAt: new Date(), endedAt: null, error: null,
    });
  } catch (err: any) {
    running.delete(conversationId);
    // The unique index on running executions: another process has a turn going.
    if (err?.code === 11000) return;
    throw err;
  }

  const reply = await insertMessage({
    conversationId, role: 'agent', text: '', source: 'text', provider: p, model: undefined,
    executionId, generating: true, steps: [],
  });

  const finish = async (status: 'completed' | 'stopped' | 'failed' | 'handed_off', text: string, steps: Step[], error?: string, sessionId?: string | null, model?: string | null) => {
    if (status !== 'completed') {
      const reason = status === 'stopped' ? 'stopped' : status === 'handed_off' ? `moved to ${run.handedTo ?? 'another provider'}` : 'the turn failed';
      steps = closeOpenTools(steps, reason);
    }
    await col.messages.updateOne({ _id: reply._id }, { $set: { text, steps, generating: false, endedAt: new Date(), ...(model ? { model } : {}) } });
    await col.executions.updateOne(
      { _id: executionId },
      { $set: { status, endedAt: new Date(), error: error ?? null, ...(model ? { model } : {}), ...(sessionId ? { providerSessionId: sessionId } : {}) } },
    );
    if (sessionId) {
      // The pointer: written at turn end, skipped when a newer one is stored.
      const at = new Date();
      await col.conversations.updateOne(
        { _id: conversationId, $or: [{ [`providerSessions.${p}.at`]: { $exists: false } }, { [`providerSessions.${p}.at`]: { $lte: at } }] },
        { $set: { [`providerSessions.${p}`]: { sessionId, seenMessageId: reply._id, at } } },
      );
    }
    setRunningExecution(conversationId, null);
    running.delete(conversationId);
  };

  try {
    if (!driver) throw new Error(`No driver for provider ${p}.`);

    // A changed instructions hash retires the warm session.
    let w = warm.get(key);
    if (w && (!w.session.alive || w.instructionsHash !== agent.instructionsHash)) {
      await retire(key);
      w = undefined;
    }

    let news: MessageDoc[];
    if (w || rec) {
      const seen = rec ? await col.messages.findOne({ _id: rec.seenMessageId }) : null;
      news = await col.messages
        .find({ conversationId, seq: { $gt: seen?.seq ?? 0, $lt: reply.seq } })
        .sort({ seq: 1 }).toArray();
    } else {
      news = (await col.messages.find({ conversationId, seq: { $lt: reply.seq } }).sort({ seq: -1 }).limit(200).toArray()).reverse();
    }

    if (!w) {
      const token = mintToken({ agentId: agent._id, conversationId, provider: p as Provider });
      const session = await driver.start({
        conversationId,
        systemPrompt: [agent.instructions.trim(), DELIVERY_NOTE, (await hasTools(agent._id)) ? RECORD_PROMPT_LINE : '']
          .filter(Boolean).join('\n\n'),
        resumeSessionId: rec?.sessionId,
        mcp: { name: 'gateway', url: `http://127.0.0.1:${PORT}/mcp/${token}` },
        cwd: scratchDir(conversationId),
      });
      w = {
        session, events: session.events()[Symbol.asyncIterator](), token,
        instructionsHash: agent.instructionsHash, sessionId: rec?.sessionId ?? null, model: null, idle: null,
      };
      warm.set(key, w);
    }
    if (w.idle) clearTimeout(w.idle);

    let text = renderNews(news, p);
    const fresh = await col.conversations.findOneAndUpdate(
      { _id: conversationId, stoppedNote: true }, { $set: { stoppedNote: false } },
    );
    if (fresh) text = `${STOP_NOTE}\n${text}`;
    if (!text.trim()) text = '[System] Nothing new.';

    setRunningExecution(conversationId, { executionId, model: w.model });
    w.session.send(text);

    // Stream into the reply.
    const steps: Step[] = [];
    let streamed = '';
    let dirty = false;
    let lastFlush = 0;
    const toolNames = new Map<string, string>();
    const flush = async (force = false) => {
      if (!dirty || (!force && Date.now() - lastFlush < STREAM_THROTTLE_MS)) return;
      dirty = false;
      lastFlush = Date.now();
      await col.messages.updateOne({ _id: reply._id }, { $set: { text: streamed, steps } });
    };

    while (true) {
      const next = await w.events.next();
      if (next.done) {
        await finish(run.ending ?? 'failed', streamed, steps, run.ending ? undefined : 'The provider session ended.', w.sessionId, w.model);
        await retire(key);
        break;
      }
      const ev = next.value;
      if (ev.type === 'session') {
        w.sessionId = ev.sessionId;
        w.model = ev.model;
        setRunningExecution(conversationId, { executionId, model: ev.model });
        await col.executions.updateOne({ _id: executionId }, { $set: { model: ev.model, providerSessionId: ev.sessionId } });
        await col.messages.updateOne({ _id: reply._id }, { $set: { model: ev.model } });
      } else if (ev.type === 'text') {
        const last = steps[steps.length - 1];
        if (last && 'text' in last) last.text += ev.delta;
        else {
          // Text after a tool call is a new paragraph of the reply.
          if (streamed) streamed += '\n\n';
          steps.push({ text: ev.delta });
        }
        streamed += ev.delta;
        dirty = true;
        await flush();
      } else if (ev.type === 'tool') {
        if (ev.phase === 'request') {
          toolNames.set(ev.ref, ev.name);
          steps.push({ toolRequest: { ref: ev.ref, name: ev.name, input: ev.input } });
        } else {
          steps.push({ toolResponse: { ref: ev.ref, name: ev.name || toolNames.get(ev.ref) || '', output: ev.output, isError: Boolean(ev.isError) } });
        }
        dirty = true;
        await flush(true);
      } else if (ev.type === 'turn-ended') {
        const finalText = streamed || ev.text;
        const status = run.ending ?? (ev.error ? 'failed' : ev.interrupted ? 'stopped' : 'completed');
        await finish(status, finalText, steps, status === 'failed' ? ev.error : undefined, w.sessionId, w.model);
        if (!w.session.alive) await retire(key);
        else w.idle = setTimeout(() => void retire(key), IDLE_MS);
        break;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finish('failed', `The turn could not run: ${message}`, [], message);
  }
}

// ── Commands from the API ────────────────────────────────────────

export async function postMessage(conversationId: string, text: string, source: 'text' | 'voice') {
  // A typed message while asks are open answers none of them: they are marked replied.
  await closeOpenAsks({ conversationId }, 'replied');
  const message = await insertMessage({ conversationId, role: 'user', text, source });
  kick(conversationId);
  return message;
}

export async function stopTurn(conversationId: string) {
  const run = running.get(conversationId);
  if (!run) return { stopped: false };
  run.ending = 'stopped';
  await col.conversations.updateOne({ _id: conversationId }, { $set: { stoppedNote: true } });
  await closeOpenAsks({ conversationId, executionId: run.executionId }, 'stopped');
  releaseHeldCalls(conversationId, run.provider, 'stopped');
  await warm.get(run.key)?.session.interrupt();
  return { stopped: true };
}

export async function switchProvider(conversationId: string, provider: string): Promise<ConversationDoc | null> {
  // Switching to the provider already in use changes nothing and says nothing.
  const conversation = await col.conversations.findOneAndUpdate(
    { _id: conversationId, provider: { $ne: provider } }, { $set: { provider } }, { returnDocument: 'after' },
  );
  if (!conversation) return col.conversations.findOne({ _id: conversationId });
  await insertMessage({ conversationId, role: 'event', text: `Switched to ${provider}`, source: 'text' });
  const run = running.get(conversationId);
  if (run && run.provider !== provider) {
    // Open asks stay open; the next turn runs on the new provider.
    run.ending = 'handed_off';
    run.handedTo = provider;
    releaseHeldCalls(conversationId, run.provider, 'moved');
    await warm.get(run.key)?.session.interrupt();
    // The new provider carries on from where the old one was cut off.
    kick(conversationId);
  }
  return conversation;
}

// A late approval starts a turn so the agent can retry.
whenLateApproval((ask) => {
  void insertMessage({ conversationId: ask.conversationId, role: 'event', text: `Approved: ${ask.summary}`, source: 'text' })
    .then(() => kick(ask.conversationId));
});

/** Gives every tool request without a response a closing error response. */
export function closeOpenTools(steps: Step[], reason: string): Step[] {
  const answered = new Set(steps.flatMap((st) => ('toolResponse' in st ? [st.toolResponse.ref] : [])));
  const closed = [...steps];
  for (const st of steps) {
    if ('toolRequest' in st && !answered.has(st.toolRequest.ref)) {
      closed.push({ toolResponse: { ref: st.toolRequest.ref, name: st.toolRequest.name, output: reason, isError: true } });
    }
  }
  return closed;
}
