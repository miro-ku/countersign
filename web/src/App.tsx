import { useEffect, useMemo, useState } from 'react';
import { ListChecksIcon, MailIcon, MessageSquareIcon, PlusIcon, ShieldCheckIcon, SquarePenIcon, SquareIcon, WifiOffIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { api, cap, useConversation } from './api.ts';
import { Chat } from './Chat.tsx';
import { Ledger } from './Ledger.tsx';
import { PROVIDER_LABEL, type Agent, type Connection, type Provider, type Rule } from './types.ts';

const TOOLKITS = [
  { id: 'slack', label: 'Slack', icon: MessageSquareIcon },
  { id: 'gmail', label: 'Gmail', icon: MailIcon },
];

// Where we are lives in the URL (and localStorage), so the app-connection
// round trip lands back on the same agent and conversation.
function readPlace() {
  const q = new URLSearchParams(location.search);
  return {
    agentId: q.get('agent') ?? localStorage.getItem('agent'),
    conversationId: q.get('conversation') ?? localStorage.getItem('conversation'),
    connected: q.get('connected'),
    connectError: q.get('connectError'),
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
  const [notice, setNotice] = useState<{ text: string; tone: 'ok' | 'bad' | 'quiet' } | null>(
    start.connected ? { text: `${cap(start.connected)} connected`, tone: 'ok' }
      : start.connectError ? { text: `${cap(start.connectError)} was not connected. You can try again.`, tone: 'quiet' }
      : null,
  );
  const [serverUp, setServerUp] = useState(true);
  const [creating, setCreating] = useState(false);
  const live = useConversation(conversationId, agentId);

  const refreshAgents = () =>
    api.listAgents().then((a) => { setAgents(a); setServerUp(true); }).catch(() => setServerUp(false));

  useEffect(() => { refreshAgents(); const t = setInterval(refreshAgents, 10000); return () => clearInterval(t); }, []);
  useEffect(() => writePlace(agentId, conversationId), [agentId, conversationId]);
  useEffect(() => { if (notice) { const t = setTimeout(() => setNotice(null), 6000); return () => clearTimeout(t); } }, [notice]);

  const fail = (e: unknown) => setNotice({ text: `Something went wrong: ${e instanceof Error ? e.message : String(e)}`, tone: 'bad' });
  const agent = agents.find((a) => a._id === agentId) ?? null;

  const selectAgent = async (a: Agent) => {
    setAgentId(a._id);
    const known = localStorage.getItem(`conversation:${a._id}`);
    if (known) { setConversationId(known); return; }
    try {
      const latest = await api.latestConversation(a._id).catch(() => null);
      setConversationId((latest ?? (await api.createConversation(a._id)))._id);
    } catch (e) { fail(e); }
  };

  const newConversation = async () => {
    if (!agentId) return;
    try { setConversationId((await api.createConversation(agentId))._id); } catch (e) { fail(e); }
  };

  const createAgent = async (body: { name: string; instructions: string; defaultProvider: Provider }) => {
    const a = await api.createAgent(body);
    setAgents((list) => [a, ...list.filter((x) => x._id !== a._id)]);
    // The avatar is drawn a few seconds after the agent is made.
    for (const ms of [3000, 6000, 12000]) setTimeout(() => api.listAgents().then(setAgents).catch(() => {}), ms);
    setAgentId(a._id);
    setConversationId((await api.createConversation(a._id))._id);
  };

  const conv = live.conversation;
  const running =
    Object.values(live.executions).some((x) => x.status === 'running') ||
    Object.values(live.messages).some((m) => m.generating);
  const stop = () => { if (conversationId) api.stop(conversationId).catch(fail); };

  return (
    <div className="grid h-dvh grid-cols-[240px_minmax(0,1fr)_320px] bg-background text-foreground antialiased">
      {/* Agents */}
      <aside className="flex min-h-0 flex-col border-r bg-muted/30">
        <div className="flex h-14 shrink-0 items-center gap-2 px-4">
          <div className="flex size-6 items-center justify-center rounded-md bg-foreground text-background">
            <ShieldCheckIcon className="size-3.5" />
          </div>
          <span className="text-sm font-semibold tracking-tight">Countersign</span>
        </div>
        <div className="px-3 pb-2">
          <Button variant="outline" size="sm" className="w-full justify-start bg-background" onClick={() => setCreating(true)}>
            <PlusIcon /> New agent
          </Button>
        </div>
        <div className="px-4 pt-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Agents</div>
        <ScrollArea className="min-h-0 flex-1 px-2">
          <div className="flex flex-col pb-3">
            {agents.map((a) => (
              <div key={a._id}>
              <button
                onClick={() => selectAgent(a)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent',
                  a._id === agentId && 'bg-accent',
                )}
              >
                <AgentAvatar agent={a} />
                <span className="min-w-0 flex-1 truncate text-sm">{a.name}</span>
                <span className="text-[11px] text-muted-foreground tabular-nums">v{a.version}</span>
              </button>
              {a._id === agentId && (
                <Conversations
                  agentId={a._id}
                  current={conversationId}
                  refreshKey={`${conversationId}:${live.conversation?.title ?? ''}:${Object.values(live.messages).filter((m) => m.role === 'user').length}`}
                  onPick={setConversationId}
                  onNew={newConversation}
                />
              )}
              </div>
            ))}
            {agents.length === 0 && serverUp && <p className="px-2 py-1.5 text-sm text-muted-foreground">None yet</p>}
            {!serverUp && (
              <p className="flex items-center gap-2 px-2 py-1.5 text-xs text-amber-700"><WifiOffIcon className="size-3.5" /> Server not answering</p>
            )}
          </div>
        </ScrollArea>
      </aside>

      {/* Conversation */}
      <main className="flex min-h-0 min-w-0 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          {agent && conversationId ? (
            <>
              <div className="flex min-w-0 flex-1 items-baseline gap-2">
                <h1 className="truncate text-sm font-semibold">{agent.name}</h1>
                <span className="text-xs text-muted-foreground tabular-nums">v{agent.version}</span>
                <span className="text-xs text-muted-foreground">· acts for {cap(agent.ownerId)}</span>
                <Rules agentId={agent._id} />
              </div>
              {running && (
                <Button variant="ghost" size="sm" className="text-red-600 hover:bg-red-50 hover:text-red-700" onClick={stop}>
                  <SquareIcon className="size-3 fill-current" /> Stop
                </Button>
              )}
              <div className="mx-1 h-5 w-px bg-border" />
              <Apps agentId={agent._id} connections={Object.values(live.connections)} fail={fail} />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" onClick={newConversation} aria-label="New conversation"><SquarePenIcon /></Button>
                </TooltipTrigger>
                <TooltipContent>New conversation</TooltipContent>
              </Tooltip>
            </>
          ) : (
            <span className="text-sm text-muted-foreground">No agent selected</span>
          )}
        </header>

        {notice && (
          <div className={cn(
            'mx-auto mt-3 flex w-full max-w-2xl items-center gap-3 rounded-md border px-3 py-2 text-sm',
            notice.tone === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
              : notice.tone === 'bad' ? 'border-red-200 bg-red-50 text-red-900'
              : 'border-border bg-muted/40 text-muted-foreground',
          )}>
            <span className="flex-1">{notice.text}</span>
            <button onClick={() => setNotice(null)} aria-label="Dismiss"><XIcon className="size-4" /></button>
          </div>
        )}

        {agent && conversationId ? (
          <>
            {!live.online && (
              <p className="mx-auto flex w-full max-w-2xl items-center gap-2 px-6 pt-2 text-xs text-amber-700"><WifiOffIcon className="size-3.5" /> Reconnecting…</p>
            )}
            <Chat
              live={live} conversationId={conversationId} agentId={agent._id} running={running} onStop={stop} fail={fail}
              provider={conv?.provider ?? agent.defaultProvider}
              onSwitch={(p) => { if (conv && p !== conv.provider) api.switchProvider(conv._id, p).catch(fail); }}
            />
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <h2 className="text-lg font-semibold tracking-tight">{agents.length ? 'Pick an agent' : 'Create your first agent'}</h2>
            <p className="max-w-sm text-sm text-muted-foreground">Give it a name, instructions and an engine. Every tool call it makes is checked, asked about if needed, and recorded.</p>
            <Button size="sm" className="mt-2" onClick={() => setCreating(true)}><PlusIcon /> New agent</Button>
          </div>
        )}
      </main>

      {/* Ledger */}
      <aside className="flex min-h-0 flex-col border-l">
        <Ledger entries={Object.values(live.ledger)} connections={Object.values(live.connections)} fail={fail} />
      </aside>

      <NewAgent open={creating} onOpenChange={setCreating} onCreate={createAgent} />
    </div>
  );
}

function Apps({ agentId, connections, fail }: { agentId: string; connections: Connection[]; fail: (e: unknown) => void }) {
  return (
    <div className="flex items-center gap-1">
      {TOOLKITS.map(({ id, label, icon: Icon }) => {
        // Only a working connection counts; pending or stale ones are offered again.
        const c = connections.find((x) => x.toolkit?.toLowerCase() === id && x.status === 'active' && !x.stale);
        if (c) {
          return (
            <span key={id} className="group/chip flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium">
              <span className="size-1.5 rounded-full bg-emerald-500" />
              {label}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => { if (window.confirm(`Disconnect ${label}? The agent loses access at once, and connecting again needs a new authorization.`)) api.disconnect(c._id).catch(fail); }} aria-label={`Disconnect ${label}`}>
                    <XIcon className="size-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Disconnect {label}</TooltipContent>
              </Tooltip>
            </span>
          );
        }
        return (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs text-muted-foreground"
                onClick={async () => {
                  try { location.href = (await api.connect(agentId, id)).redirectUrl; } catch (e) { fail(e); }
                }}
              >
                <Icon /> Connect {label}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Give this agent access to your {label}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

/** The agent's conversations, newest first, each named by its first message. */
/** The agent's face: an emoji on a soft gradient, or its initial until that is drawn. */
function AgentAvatar({ agent }: { agent: Agent }) {
  if (!agent.avatar) {
    return (
      <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-background text-xs font-medium text-muted-foreground ring-1 ring-border">
        {agent.name.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return (
    <span
      className="flex size-6 shrink-0 items-center justify-center rounded-md text-sm leading-none"
      style={{ background: `linear-gradient(135deg, ${agent.avatar.from}, ${agent.avatar.to})` }}
    >
      {agent.avatar.emoji}
    </span>
  );
}

function Conversations({ agentId, current, refreshKey, onPick, onNew }: {
  agentId: string; current: string | null; refreshKey: string;
  onPick: (id: string) => void; onNew: () => void;
}) {
  const [list, setList] = useState<{ _id: string; title: string }[]>([]);
  useEffect(() => {
    let off = false;
    (async () => {
      const convs = (await api.listConversations(agentId)).slice(0, 8);
      const titled = await Promise.all(convs.map(async (c) => {
        if (c.title) return { _id: c._id, title: c.title };
        try {
          const snap = await api.getConversation(c._id);
          const first = ((snap.messages ?? []) as { role: string; seq: number; text: string }[])
            .filter((m) => m.role === 'user').sort((x, y) => x.seq - y.seq)[0];
          return { _id: c._id, title: first?.text ?? 'New chat' };
        } catch { return { _id: c._id, title: 'New chat' }; }
      }));
      if (!off) setList(titled);
    })().catch(() => {});
    return () => { off = true; };
  }, [agentId, refreshKey]);

  return (
    <div className="my-1 ml-5 flex min-w-0 flex-col gap-px overflow-hidden border-l pl-2 pr-1">
      <button onClick={onNew} className="flex items-center gap-1.5 rounded px-2 py-1 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
        <PlusIcon className="size-3" /> New chat
      </button>
      {list.map((c) => (
        <button
          key={c._id}
          onClick={() => onPick(c._id)}
          title={c.title}
          className={cn(
            'block w-full min-w-0 truncate rounded px-2 py-1 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground',
            c._id === current && 'bg-background font-medium text-foreground ring-1 ring-inset ring-border',
          )}
        >
          {c.title}
        </button>
      ))}
    </div>
  );
}

const EFFECT_TONE: Record<Rule['effect'], string> = { allow: 'text-emerald-700', ask: 'text-amber-700', deny: 'text-red-700' };

function matchWords(r: Rule): string {
  if (r.title) return r.title;
  const m = r.match;
  if (m.action) return m.action;
  const what = m.kind === 'read' ? 'reads' : m.kind === 'write' ? 'changes' : 'actions';
  if (m.actionPattern) return `${what} with a matching name`;
  if (m.argsPattern) return `${what} whose arguments match`;
  return m.kind === 'read' ? 'anything that reads' : m.kind === 'write' ? 'anything that changes something' : 'anything';
}

/** The rules that apply to this agent, in the order they are checked. Read-only. */
function Rules({ agentId }: { agentId: string }) {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    api.rules(agentId).then(setRules).catch(() => setRules([]));
  }, [agentId, open]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs text-muted-foreground">
          <ListChecksIcon className="size-3.5" /> Rules
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 p-0">
        <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">Checked before every tool call, first match wins</div>
        <ol className="max-h-80 overflow-auto py-1">
          {rules === null && <li className="px-3 py-2 text-xs text-muted-foreground">Loading…</li>}
          {rules?.length === 0 && <li className="px-3 py-2 text-xs text-muted-foreground">No rules: every action is asked about.</li>}
          {rules?.map((r) => (
            <li key={r._id} className="px-3 py-1.5">
              <div className="flex items-baseline gap-2">
                <span className={cn('w-10 shrink-0 text-xs font-semibold', EFFECT_TONE[r.effect])}>{r.effect}</span>
                <span className={cn('min-w-0 truncate text-[13px]', r.match.action && 'font-mono')} title={r.match.actionPattern ?? r.match.argsPattern}>{matchWords(r)}</span>
                {r.agentId == null && <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">default</span>}
              </div>
              <p className="ml-12 text-xs text-muted-foreground">{r.reason}</p>
            </li>
          ))}
        </ol>
      </PopoverContent>
    </Popover>
  );
}

function NewAgent({ open, onOpenChange, onCreate }: {
  open: boolean; onOpenChange: (o: boolean) => void;
  onCreate: (b: { name: string; instructions: string; defaultProvider: Provider }) => Promise<void>;
}) {
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
      await onCreate({ name: name.trim(), instructions, defaultProvider: provider });
      onOpenChange(false); setName(''); setInstructions('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="grid gap-5">
          <DialogHeader>
            <DialogTitle>New agent</DialogTitle>
            <DialogDescription>Its rules and the ledger come with it, whichever engine runs it.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="agent-title">Name</Label>
            <Input id="agent-title" name="agent-title" autoComplete="off" data-1p-ignore data-lpignore="true" value={name} onChange={(e) => setName(e.target.value)} placeholder="Office helper" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="agent-instructions">Instructions</Label>
            <Textarea id="agent-instructions" autoComplete="off" rows={5} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="What it is for, and how it should behave." />
          </div>
          <div className="grid gap-2">
            <Label>Runs on</Label>
            <Tabs value={provider} onValueChange={(v) => setProvider(v as Provider)}>
              <TabsList className="w-full">
                <TabsTrigger value="claude-code" className="flex-1">Claude Code</TabsTrigger>
                <TabsTrigger value="codex" className="flex-1">Codex</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create agent'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
