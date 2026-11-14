import { useEffect, useMemo, useState } from 'react';
import { api, cap, useConversation } from './api.ts';
import { Chat } from './Chat.tsx';
import { Ledger } from './Ledger.tsx';
import { PROVIDER_LABEL, type Agent, type Connection, type Provider } from './types.ts';

const TOOLKITS = [
  { id: 'slack', label: 'Slack' },
  { id: 'gmail', label: 'Gmail' },
];

// Where we are lives in the URL (and localStorage), so the app-connection
// round trip lands back on the same agent and conversation.
function readPlace() {
  const q = new URLSearchParams(location.search);
  return {
    agentId: q.get('agent') ?? localStorage.getItem('agent'),
    conversationId: q.get('conversation') ?? localStorage.getItem('conversation'),
    connected: q.get('connected'),
  };
}

function writePlace(agentId: string | null, conversationId: string | null) {
  const q = new URLSearchParams();
  if (agentId) q.set('agent', agentId);
  if (conversationId) q.set('conversation', conversationId);
  history.replaceState(null, '', `${location.pathname}${q.size ? `?${q}` : ''}`);
  agentId ? localStorage.setItem('agent', agentId) : localStorage.removeItem('agent');
  conversationId ? localStorage.setItem('conversation', conversationId) : localStorage.removeItem('conversation');
  if (agentId && conversationId) localStorage.setItem(`conversation:${agentId}`, conversationId);
}

export function App() {
  const start = useMemo(readPlace, []);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentId, setAgentId] = useState<string | null>(start.agentId);
  const [conversationId, setConversationId] = useState<string | null>(start.conversationId);
  const [notice, setNotice] = useState<string | null>(
    start.connected ? `${cap(start.connected)} connected` : null,
  );
  const [serverUp, setServerUp] = useState(true);
  const live = useConversation(conversationId, agentId);

  const refreshAgents = () =>
    api.listAgents().then((a) => { setAgents(a); setServerUp(true); }).catch(() => setServerUp(false));

  useEffect(() => { refreshAgents(); const t = setInterval(refreshAgents, 10000); return () => clearInterval(t); }, []);
  useEffect(() => writePlace(agentId, conversationId), [agentId, conversationId]);
  useEffect(() => { if (notice) { const t = setTimeout(() => setNotice(null), 6000); return () => clearTimeout(t); } }, [notice]);

  const fail = (e: unknown) => setNotice(e instanceof Error ? e.message : String(e));
  const agent = agents.find((a) => a._id === agentId) ?? null;

  const selectAgent = async (a: Agent) => {
    setAgentId(a._id);
    const known = localStorage.getItem(`conversation:${a._id}`);
    if (known) { setConversationId(known); return; }
    try { setConversationId((await api.createConversation(a._id))._id); } catch (e) { fail(e); }
  };

  const newConversation = async () => {
    if (!agentId) return;
    try { setConversationId((await api.createConversation(agentId))._id); } catch (e) { fail(e); }
  };

  const createAgent = async (body: { name: string; instructions: string; defaultProvider: Provider }) => {
    const a = await api.createAgent(body);
    setAgents((list) => [...list.filter((x) => x._id !== a._id), a]);
    setAgentId(a._id);
    setConversationId((await api.createConversation(a._id))._id);
  };

  const conv = live.conversation;
  const running =
    Object.values(live.executions).some((x) => x.status === 'running') ||
    Object.values(live.messages).some((m) => m.generating);

  return (
    <div className="app">
      <Rail agents={agents} selected={agentId} onSelect={selectAgent} onCreate={createAgent} serverUp={serverUp} />

      <main className="centre">
        {agent && conversationId ? (
          <>
            <header className="head">
              <div className="title">
                <h1>{agent.name}</h1>
                <span className="version">v{agent.version}</span>
              </div>
              <div className="segments" role="group" aria-label="Provider">
                {(['claude-code', 'codex'] as Provider[]).map((p) => (
                  <button
                    key={p}
                    className={conv?.provider === p ? 'on' : ''}
                    disabled={!conv}
                    onClick={() => conv && conv.provider !== p && api.switchProvider(conv._id, p).catch(fail)}
                  >
                    {PROVIDER_LABEL[p]}
                  </button>
                ))}
              </div>
              {running && (
                <button className="stop" onClick={() => api.stop(conversationId).catch(fail)}>■ Stop</button>
              )}
              <Apps agentId={agent._id} connections={Object.values(live.connections)} fail={fail} />
              <button className="ghost" onClick={newConversation} title="Start a new conversation">New chat</button>
            </header>
            {notice && <div className="notice">{notice}</div>}
            {!live.online && <div className="notice warn">Reconnecting to the server…</div>}
            <Chat live={live} conversationId={conversationId} agentId={agent._id} fail={fail} />
          </>
        ) : (
          <div className="blank">
            {notice && <div className="notice">{notice}</div>}
            <p>{agents.length ? 'Pick an agent, or create a new one.' : 'No agents yet. Create one to start.'}</p>
          </div>
        )}
      </main>

      <Ledger entries={Object.values(live.ledger)} fail={fail} />
    </div>
  );
}

function Apps({ agentId, connections, fail }: { agentId: string; connections: Connection[]; fail: (e: unknown) => void }) {
  return (
    <div className="apps">
      {TOOLKITS.map(({ id, label }) => {
        const c = connections
          .filter((x) => x.toolkit?.toLowerCase() === id && x.status !== 'revoked')
          .sort((a, b) => (a.status === 'active' ? -1 : 1) - (b.status === 'active' ? -1 : 1))[0];
        if (c?.status === 'active') {
          return (
            <span key={id} className="chip">
              <span className="dot" /> {label}
              <button className="link" onClick={() => api.disconnect(c._id).catch(fail)}>Disconnect</button>
            </span>
          );
        }
        return (
          <button
            key={id}
            className="connect"
            onClick={async () => {
              try { location.href = (await api.connect(agentId, id)).redirectUrl; } catch (e) { fail(e); }
            }}
          >
            {c?.status === 'pending' ? `Finish connecting ${label}` : `Connect ${label}`}
          </button>
        );
      })}
    </div>
  );
}

function Rail(props: {
  agents: Agent[]; selected: string | null; serverUp: boolean;
  onSelect: (a: Agent) => void;
  onCreate: (b: { name: string; instructions: string; defaultProvider: Provider }) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [provider, setProvider] = useState<Provider>('claude-code');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true); setError(null);
    try {
      await props.onCreate({ name: name.trim(), instructions, defaultProvider: provider });
      setOpen(false); setName(''); setInstructions('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };

  return (
    <aside className="rail">
      <div className="rail-title">Agents</div>
      <ul className="agents">
        {props.agents.map((a) => (
          <li key={a._id}>
            <button className={a._id === props.selected ? 'on' : ''} onClick={() => props.onSelect(a)}>
              <span className="agent-name">{a.name}</span>
              <span className="agent-meta">v{a.version} · {PROVIDER_LABEL[a.defaultProvider] ?? a.defaultProvider}</span>
            </button>
          </li>
        ))}
      </ul>
      {!props.serverUp && <div className="rail-warn">Server not answering</div>}
      {open ? (
        <form className="new-agent" onSubmit={submit}>
          <label>Name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label>Instructions<textarea rows={6} value={instructions} onChange={(e) => setInstructions(e.target.value)} /></label>
          <div className="segments small">
            {(['claude-code', 'codex'] as Provider[]).map((p) => (
              <button type="button" key={p} className={provider === p ? 'on' : ''} onClick={() => setProvider(p)}>
                {PROVIDER_LABEL[p]}
              </button>
            ))}
          </div>
          {error && <div className="form-error">{error}</div>}
          <div className="form-row">
            <button type="submit" className="primary" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create'}</button>
            <button type="button" className="ghost" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      ) : (
        <button className="primary new" onClick={() => setOpen(true)}>+ New agent</button>
      )}
    </aside>
  );
}
