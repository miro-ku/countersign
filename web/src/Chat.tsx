import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, cap, pretty, type Live } from './api.ts';
import { PROVIDER_LABEL, type Ask, type Message, type Step } from './types.ts';

type Item = { kind: 'message'; m: Message } | { kind: 'ask'; a: Ask };

const time = (s?: string) => (s ? new Date(s).getTime() : 0);

/** Messages in `seq` order; each ask sits after the last message written before it. */
function timeline(live: Live): Item[] {
  const messages = Object.values(live.messages).sort((a, b) => a.seq - b.seq);
  const asks = Object.values(live.asks).sort((a, b) => time(a.createdAt) - time(b.createdAt));
  const items: Item[] = [];
  let i = 0;
  for (const m of messages) {
    while (i < asks.length && time(asks[i].createdAt) < time(m.at)) items.push({ kind: 'ask', a: asks[i++] });
    items.push({ kind: 'message', m });
  }
  while (i < asks.length) items.push({ kind: 'ask', a: asks[i++] });
  return items;
}

export function Chat({ live, conversationId, agentId, fail }: {
  live: Live; conversationId: string; agentId: string; fail: (e: unknown) => void;
}) {
  const items = useMemo(() => timeline(live), [live.messages, live.asks]);
  const scroller = useRef<HTMLDivElement>(null);
  const [text, setText] = useState('');

  // Follow the conversation while the reader is near the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 240) el.scrollTop = el.scrollHeight;
  });
  useEffect(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; }, [conversationId]);

  const send = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setText('');
    api.send(conversationId, t).catch((err) => { setText(t); fail(err); });
  };

  return (
    <>
      <div className="chat" ref={scroller}>
        {items.length === 0 && <div className="empty">Say something to start the conversation.</div>}
        {items.map((it) =>
          it.kind === 'message' ? <MessageView key={it.m._id} m={it.m} /> : <AskView key={it.a._id} a={it.a} fail={fail} />,
        )}
      </div>
      <form className="composer" onSubmit={send}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Message the agent…"
          aria-label="Message"
        />
        <button type="submit" className="primary" disabled={!text.trim()}>Send</button>
        {/* The voice track mounts its call button here. */}
        <div id="voice-slot" data-conversation-id={conversationId} data-agent-id={agentId} />
      </form>
    </>
  );
}

function MessageView({ m }: { m: Message }) {
  if (m.role === 'event') {
    const text = m.text.replace(/\bclaude-code\b/g, 'Claude Code').replace(/\bcodex\b/g, 'Codex');
    return <div className="event"><span>{text}</span></div>;
  }
  if (m.role === 'user') {
    return (
      <div className="msg user">
        <div className="who">Miro · {m.source === 'voice' ? '🎙 spoken' : 'typed'}</div>
        <div className="bubble">{m.text}</div>
      </div>
    );
  }
  return (
    <div className={`msg agent${m.generating ? ' live' : ''}`}>
      <div className="who">
        <span className={`badge ${m.provider ?? ''}`}>{m.provider ? PROVIDER_LABEL[m.provider] ?? m.provider : 'Agent'}</span>
        {m.generating && <span className="typing">writing…</span>}
      </div>
      <div className="bubble"><Body m={m} /></div>
    </div>
  );
}

/** The reply in the order it happened: text and tool calls interleaved. */
function Body({ m }: { m: Message }) {
  const steps = m.steps ?? [];
  const responses = new Map<string, Extract<Step, { toolResponse: unknown }>['toolResponse']>();
  for (const s of steps) if ('toolResponse' in s) responses.set(s.toolResponse.ref, s.toolResponse);
  const hasTextSteps = steps.some((s) => 'text' in s);
  const tools = steps.filter((s): s is Extract<Step, { toolRequest: unknown }> => 'toolRequest' in s);

  if (!hasTextSteps) {
    return (
      <>
        {tools.map((s) => <ToolRow key={s.toolRequest.ref} req={s.toolRequest} res={responses.get(s.toolRequest.ref)} />)}
        {m.text ? <div className="text">{m.text}{m.generating && <Caret />}</div> : m.generating && <Caret />}
      </>
    );
  }
  return (
    <>
      {steps.map((s, i) => {
        if ('text' in s) return s.text.trim() ? <div key={i} className="text">{s.text}</div> : null;
        if ('toolRequest' in s) return <ToolRow key={i} req={s.toolRequest} res={responses.get(s.toolRequest.ref)} />;
        return null;
      })}
      {m.generating && <Caret />}
    </>
  );
}

const Caret = () => <span className="caret" />;

const toolName = (n: string) => n.replace(/^mcp__gateway__/, '');

function oneLine(input: unknown): string {
  if (input == null) return '';
  if (typeof input !== 'object') return String(input);
  const o = input as Record<string, any>;
  if (Array.isArray(o.tools)) return o.tools.map((t: any) => t?.tool_slug ?? '?').join(', ');
  return Object.entries(o)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('  ');
}

function ToolRow({ req, res }: {
  req: { ref: string; name: string; input: unknown };
  res?: { output: unknown; isError: boolean };
}) {
  const [open, setOpen] = useState(false);
  const state = !res ? 'pending' : res.isError ? 'error' : 'ok';
  return (
    <div className={`tool ${state}`}>
      <button className="tool-line" onClick={() => setOpen(!open)}>
        <span className="tool-icon">{state === 'pending' ? '…' : state === 'error' ? '✕' : '✓'}</span>
        <span className="tool-name">{toolName(req.name)}</span>
        <span className="tool-input">{oneLine(req.input)}</span>
      </button>
      {open && (
        <pre className="tool-detail">
          {JSON.stringify(req.input, null, 2)}
          {'\n— result —\n'}
          {res ? pretty(res.output) : 'still running'}
        </pre>
      )}
    </div>
  );
}

function AskView({ a, fail }: { a: Ask; fail: (e: unknown) => void }) {
  const [forConversation, setForConversation] = useState(true);
  const [busy, setBusy] = useState(false);
  const by = PROVIDER_LABEL[a.askedByProvider] ?? a.askedByProvider;

  if (a.status !== 'open') {
    const ans = a.answer;
    let line: string;
    if (a.status === 'approved' || a.status === 'declined') {
      const who = cap(ans?.by ?? 'miro');
      const how = ans?.source === 'voice' ? ` (voice: '${ans.transcript ?? ''}')` : '';
      const scope = ans?.scope === 'conversation' || a.status === 'declined' ? ', for this conversation' : ', once';
      line = `${a.status === 'approved' ? 'Approved' : 'Rejected'} by ${who}${how}${scope}`;
    } else if (a.status === 'replied') {
      line = 'Not answered: Miro wrote something else';
    } else {
      line = 'Stopped before an answer';
    }
    return (
      <div className={`ask-done ${a.status}`}>
        <span className="mark">{a.status === 'approved' ? '✓' : a.status === 'declined' ? '✕' : '–'}</span>
        <span className="ask-line">{line}</span>
        <span className="ask-what">· {a.summary}</span>
      </div>
    );
  }

  const answer = async (choice: 'approve' | 'decline') => {
    setBusy(true);
    try { await api.answer(a._id, choice, forConversation ? 'conversation' : 'once'); }
    catch (e) { fail(e); setBusy(false); }
  };

  return (
    <div className="ask">
      <div className="ask-head">Needs your approval · asked on {by}</div>
      <div className="ask-summary">{a.summary}</div>
      <div className="ask-action">{toolName(a.action)}</div>
      <div className="ask-buttons">
        <button className="approve" disabled={busy} onClick={() => answer('approve')}>Approve</button>
        <button className="reject" disabled={busy} onClick={() => answer('decline')}>Reject</button>
        <label className="check">
          <input type="checkbox" checked={forConversation} onChange={(e) => setForConversation(e.target.checked)} />
          for this conversation
        </label>
      </div>
    </div>
  );
}
