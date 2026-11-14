import { useEffect, useMemo, useState } from 'react';
import { BotIcon, MailIcon, MessageSquareIcon, PlusIcon, ShieldCheckIcon, SquarePenIcon, SquareIcon, WifiOffIcon, XIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { api, cap, useConversation } from './api.ts';
import { Chat } from './Chat.tsx';
import { Ledger } from './Ledger.tsx';
import { PROVIDER_LABEL, type Agent, type Connection, type Provider } from './types.ts';

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
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(
    start.connected ? { text: `${cap(start.connected)} connected`, ok: true } : null,
  );
  const [serverUp, setServerUp] = useState(true);
  const [creating, setCreating] = useState(false);
  const live = useConversation(conversationId, agentId);

  const refreshAgents = () =>
    api.listAgents().then((a) => { setAgents(a); setServerUp(true); }).catch(() => setServerUp(false));

  useEffect(() => { refreshAgents(); const t = setInterval(refreshAgents, 10000); return () => clearInterval(t); }, []);
  useEffect(() => writePlace(agentId, conversationId), [agentId, conversationId]);
  useEffect(() => { if (notice) { const t = setTimeout(() => setNotice(null), 6000); return () => clearTimeout(t); } }, [notice]);

  const fail = (e: unknown) => setNotice({ text: e instanceof Error ? e.message : String(e), ok: false });
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
    setAgentId(a._id);
    setConversationId((await api.createConversation(a._id))._id);
  };

  const conv = live.conversation;
  const running =
    Object.values(live.executions).some((x) => x.status === 'running') ||
    Object.values(live.messages).some((m) => m.generating);
  const stop = () => { if (conversationId) api.stop(conversationId).catch(fail); };

  return (
    <div className="grid h-dvh grid-cols-[230px_minmax(0,1fr)_340px] bg-background text-foreground">
      {/* Agents */}
      <aside className="flex min-h-0 flex-col border-r bg-muted/40">
        <div className="flex h-16 shrink-0 items-center gap-2.5 border-b px-4">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-foreground text-background">
            <ShieldCheckIcon className="size-5" />
          </div>
          <div className="leading-tight">
            <div className="font-semibold">Governed agents</div>
            <div className="text-xs text-muted-foreground">Same rules, any engine</div>
          </div>
        </div>
        <div className="px-4 pt-4 pb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Agents</div>
        <ScrollArea className="min-h-0 flex-1 px-2">
          <div className="flex flex-col gap-0.5 pb-2">
            {agents.map((a) => (
              <button
                key={a._id}
                onClick={() => selectAgent(a)}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent',
                  a._id === agentId && 'bg-background shadow-sm ring-1 ring-border',
                )}
              >
                <BotIcon className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{a.name}</div>
                  <div className="text-xs text-muted-foreground">v{a.version} · {PROVIDER_LABEL[a.defaultProvider] ?? a.defaultProvider}</div>
                </div>
              </button>
            ))}
            {agents.length === 0 && serverUp && <p className="px-2.5 py-2 text-sm text-muted-foreground">No agents yet.</p>}
            {!serverUp && (
              <p className="flex items-center gap-2 px-2.5 py-2 text-sm text-amber-700"><WifiOffIcon className="size-4" /> Server not answering</p>
            )}
          </div>
        </ScrollArea>
        <div className="border-t p-3">
          <Button className="w-full" size="lg" onClick={() => setCreating(true)}><PlusIcon /> New agent</Button>
        </div>
      </aside>

      {/* Conversation */}
      <main className="flex min-h-0 min-w-0 flex-col">
        <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
          {agent && conversationId ? (
            <>
              <div className="flex min-w-[120px] flex-1 items-center gap-2">
                <h1 className="truncate text-lg font-semibold">{agent.name}</h1>
                <Badge variant="outline" className="font-mono">v{agent.version}</Badge>
              </div>
              <Tabs
                value={conv?.provider ?? 'claude-code'}
                onValueChange={(p) => { if (conv && p !== conv.provider) api.switchProvider(conv._id, p as Provider).catch(fail); }}
              >
                <TabsList>
                  <TabsTrigger value="claude-code" className="px-2.5" disabled={!conv}>Claude Code</TabsTrigger>
                  <TabsTrigger value="codex" className="px-2.5" disabled={!conv}>Codex</TabsTrigger>
                </TabsList>
              </Tabs>
              {running && (
                <Button variant="destructive" size="sm" onClick={stop}><SquareIcon className="fill-current" /> Stop</Button>
              )}
              <Apps agentId={agent._id} connections={Object.values(live.connections)} fail={fail} />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" onClick={newConversation} aria-label="New conversation"><SquarePenIcon /></Button>
                </TooltipTrigger>
                <TooltipContent>New conversation</TooltipContent>
              </Tooltip>
            </>
          ) : (
            <span className="text-sm text-muted-foreground">Create an agent to begin</span>
          )}
        </header>

        {notice && (
          <div className={cn(
            'mx-5 mt-3 flex items-start gap-3 rounded-lg border px-4 py-3 text-sm',
            notice.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-red-200 bg-red-50 text-red-900',
          )}>
            <span className="flex-1">{notice.ok ? notice.text : `Something went wrong: ${notice.text}`}</span>
            <button onClick={() => setNotice(null)} aria-label="Dismiss"><XIcon className="size-4" /></button>
          </div>
        )}

        {agent && conversationId ? (
          <>
            {!live.online && (
              <p className="flex items-center gap-2 px-5 pt-2 text-sm font-medium text-amber-700"><WifiOffIcon className="size-4" /> Reconnecting…</p>
            )}
            <Chat live={live} conversationId={conversationId} agentId={agent._id} running={running} onStop={stop} fail={fail} />
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
            <div className="flex size-16 items-center justify-center rounded-2xl bg-muted"><BotIcon className="size-8 text-muted-foreground" /></div>
            <div className="space-y-1">
              <h2 className="text-2xl font-semibold">{agents.length ? 'Pick an agent' : 'No agents yet'}</h2>
              <p className="text-muted-foreground">Give it a name, instructions and an engine. Its rules come with it.</p>
            </div>
            <Button size="lg" onClick={() => setCreating(true)}><PlusIcon /> New agent</Button>
          </div>
        )}
      </main>

      {/* Ledger */}
      <aside className="flex min-h-0 flex-col border-l bg-muted/40">
        <Ledger entries={Object.values(live.ledger)} fail={fail} />
      </aside>

      <NewAgent open={creating} onOpenChange={setCreating} onCreate={createAgent} />
    </div>
  );
}

function Apps({ agentId, connections, fail }: { agentId: string; connections: Connection[]; fail: (e: unknown) => void }) {
  return (
    <div className="flex items-center gap-2">
      {TOOLKITS.map(({ id, label, icon: Icon }) => {
        const c = connections
          .filter((x) => x.toolkit?.toLowerCase() === id && x.status !== 'revoked')
          .sort((a, b) => (a.status === 'active' ? -1 : 1) - (b.status === 'active' ? -1 : 1))[0];
        if (c?.status === 'active') {
          return (
            <Badge key={id} variant="secondary" className="h-8 gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 pr-1 pl-2.5 text-sm text-emerald-800">
              <span className="size-2 rounded-full bg-emerald-500" />
              {label}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button className="ml-0.5 rounded-full p-1 hover:bg-emerald-100" onClick={() => api.disconnect(c._id).catch(fail)} aria-label={`Disconnect ${label}`}>
                    <XIcon className="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Disconnect {label}</TooltipContent>
              </Tooltip>
            </Badge>
          );
        }
        return (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  try { location.href = (await api.connect(agentId, id)).redirectUrl; } catch (e) { fail(e); }
                }}
              >
                <PlusIcon /><Icon /> {label}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{c?.status === 'pending' ? `Finish connecting ${label}` : `Connect ${label} to this agent`}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
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
